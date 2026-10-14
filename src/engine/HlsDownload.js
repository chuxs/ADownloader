import { EventEmitter } from 'node:events';
import { createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { BROWSER_USER_AGENT } from './constants.js';
import { DownloadState } from './Download.js';
import { DownloadError, statusError, toDownloadError } from './errors.js';
import { remuxToMp4 } from './ffmpeg.js';
import { fileNameFromUrl, sanitizeFileName, uniquePath } from './filename.js';
import { bestVariant, closestVariant, parsePlaylist, sequenceIv } from './m3u8.js';
import { SpeedMeter } from './SpeedMeter.js';

const DEFAULTS = {
  connections: 4,
  maxRetries: 5,
  retryDelayMs: 1000,
  readTimeoutMs: 30_000,
  progressIntervalMs: 250,
  userAgent: BROWSER_USER_AGENT,
};

/**
 * Downloads an HLS stream (.m3u8): picks the best quality, downloads the
 * segments in parallel (decrypting AES-128 if needed), joins them, and
 * converts to .mp4 with ffmpeg when available (otherwise saves .ts).
 *
 * Segments are kept in "<file>.hls/" until the end, so pausing and resuming
 * only re-downloads unfinished segments.
 *
 * Same interface as Download: start(), pause(), cancel(), state, info, events.
 */
export class HlsDownload extends EventEmitter {
  #opts;
  #state = DownloadState.IDLE;
  #error = null;
  #filePath;
  #running = null;
  #controller = null;
  #stopReason = null;
  #meter = new SpeedMeter();
  #ticker = null;
  #keys = new Map();

  #total = 0;
  #done = 0;
  #bytes = 0;
  #inflight = 0;
  #active = 0;
  #phase = null;

  /**
   * @param {object} opts
   * @param {string} opts.url              the .m3u8 playlist
   * @param {string} [opts.directory]
   * @param {string} [opts.fileName]       e.g. "My video.mp4"; the extension is adjusted
   * @param {string} [opts.filePath]       when restoring a saved download
   * @param {string} [opts.ffmpeg]         path to ffmpeg, for .mp4 output and separate audio
   * @param {Record<string,string>} [opts.headers]
   * @param {number} [opts.connections]    segments downloaded in parallel
   * @param {Array<{consume(n: number, s: AbortSignal): Promise<void>}>} [opts.limiters]
   * @param {{width?: number, height?: number, bandwidth?: number}} [opts.variant] a specific quality (default: best)
   */
  constructor(opts) {
    super();
    this.#opts = { ...DEFAULTS, ...opts, headers: { ...opts.headers }, limiters: opts.limiters ?? [] };
    this.#filePath = opts.filePath ?? null;
  }

  get state() {
    return this.#state;
  }

  get error() {
    return this.#error;
  }

  get filePath() {
    return this.#filePath;
  }

  get info() {
    const downloaded = this.#bytes + this.#inflight;
    const size = this.#done > 0 ? Math.round((this.#bytes / this.#done) * this.#total) : null;
    const speed = this.#state === DownloadState.DOWNLOADING ? this.#meter.speed() : 0;
    return {
      url: this.#opts.url,
      fileName: this.#filePath ? path.basename(this.#filePath) : null,
      filePath: this.#filePath,
      state: this.#state,
      size: this.#state === DownloadState.COMPLETED ? this.#bytes : size,
      downloaded,
      speed,
      eta: size && speed ? Math.round((size - downloaded) / speed) : null,
      connections: this.#active,
      resumable: true,
      phase: this.#phase,
      segments: { done: this.#done, total: this.#total },
      error: this.#error ? { code: this.#error.code, message: this.#error.message } : null,
    };
  }

  start() {
    this.#running ??= this.#run().finally(() => (this.#running = null));
    return this.#running;
  }

  async pause() {
    if (!this.#running) return;
    this.#stopReason = DownloadState.PAUSED;
    this.#controller.abort();
    await this.#running;
  }

  async cancel({ deleteFile = true } = {}) {
    if (this.#running) {
      this.#stopReason = DownloadState.CANCELLED;
      this.#controller.abort();
      await this.#running;
    } else {
      this.#setState(DownloadState.CANCELLED);
    }
    if (deleteFile && this.#filePath) {
      await rm(`${this.#filePath}.hls`, { recursive: true, force: true });
      await rm(`${this.#filePath}.part`, { force: true });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async #run() {
    this.#controller = new AbortController();
    this.#stopReason = null;
    this.#error = null;
    this.#meter.reset();
    try {
      this.#setState(DownloadState.PROBING);
      const { video, audio } = await this.#retry(() => this.#loadPlaylists());
      if (!video.endList) throw new DownloadError('LIVE_STREAM', 'Live streams are not supported');
      if (video.segments.length === 0) throw new DownloadError('EMPTY_PLAYLIST', 'The playlist has no segments');
      if (audio && !this.#opts.ffmpeg) {
        throw new DownloadError('NEEDS_FFMPEG', 'This video has separate audio; ffmpeg is needed to join them');
      }

      const fmp4 = video.segments.some((s) => s.map) || /\.(m4s|mp4)(\?|$)/i.test(video.segments[0].url);
      await this.#chooseFile(fmp4 || this.#opts.ffmpeg ? '.mp4' : '.ts');
      const work = `${this.#filePath}.hls`;
      await mkdir(work, { recursive: true });

      const tasks = [...this.#tasks(video, 'v', work), ...(audio ? this.#tasks(audio, 'a', work) : [])];
      await this.#markExisting(tasks, work);

      this.#setState(DownloadState.DOWNLOADING);
      this.#ticker = setInterval(() => this.emit('progress', this.info), this.#opts.progressIntervalMs);
      await this.#downloadAll(tasks);
      if (this.#stopReason) throw new DownloadError('ABORTED', 'Stopped');

      this.#phase = 'merging';
      this.emit('progress', this.info);
      await this.#assemble(tasks, work, fmp4, Boolean(audio));
      await rm(work, { recursive: true, force: true });
      this.#setState(DownloadState.COMPLETED);
    } catch (err) {
      if (this.#stopReason) this.#setState(this.#stopReason);
      else {
        this.#error = toDownloadError(err);
        this.#setState(DownloadState.FAILED);
      }
    } finally {
      clearInterval(this.#ticker);
      this.#phase = null;
      this.#active = 0;
      this.#inflight = 0;
      this.emit('progress', this.info);
    }
    return this.#state;
  }

  #setState(state) {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', state);
  }

  async #loadPlaylists() {
    const first = await this.#fetchText(this.#opts.url);
    let video = parsePlaylist(first.text, first.url);
    let audio = null;
    if (video.type === 'master') {
      const variant = this.#opts.variant ? closestVariant(video.variants, this.#opts.variant) : bestVariant(video.variants);
      if (!variant) throw new DownloadError('EMPTY_PLAYLIST', 'No video streams found');
      // Separate audio track for this variant, if the playlist declares one with its own URI.
      const rendition = variant.audio
        ? (video.media.find((m) => m.type === 'AUDIO' && m.groupId === variant.audio && m.default && m.url) ??
          video.media.find((m) => m.type === 'AUDIO' && m.groupId === variant.audio && m.url))
        : null;
      const v = await this.#fetchText(variant.url);
      video = parsePlaylist(v.text, v.url);
      if (rendition) {
        const a = await this.#fetchText(rendition.url);
        audio = parsePlaylist(a.text, a.url);
      }
    }
    return { video, audio };
  }

  async #chooseFile(ext) {
    if (this.#filePath) return;
    const dir = this.#opts.directory;
    await mkdir(dir, { recursive: true });
    const given = this.#opts.fileName ?? fileNameFromUrl(this.#opts.url)?.replace(/\.m3u8$/i, '') ?? 'video';
    const base = sanitizeFileName(given.replace(/\.(mp4|ts|m3u8|mkv)$/i, ''), 'video');
    this.#filePath = await uniquePath(dir, `${base}${ext}`);
    // Reserve the name so a second download can't pick it too.
    await mkdir(`${this.#filePath}.hls`, { recursive: true });
  }

  /** One task per segment, plus the init section for fragmented MP4 streams. */
  #tasks(playlist, prefix, work) {
    const tasks = [];
    const map = playlist.segments.find((s) => s.map)?.map;
    if (map) tasks.push({ file: path.join(work, `${prefix}-init`), url: map.url, range: map.range, key: null, kind: prefix, init: true });
    playlist.segments.forEach((s, i) =>
      tasks.push({
        file: path.join(work, `${prefix}${String(i).padStart(6, '0')}`),
        url: s.url,
        range: s.range,
        key: s.key,
        sequence: s.sequence,
        kind: prefix,
        init: false,
      }),
    );
    return tasks;
  }

  async #markExisting(tasks, work) {
    const present = new Set(await readdir(work).catch(() => []));
    this.#total = tasks.length;
    this.#done = 0;
    this.#bytes = 0;
    for (const t of tasks) {
      if (present.has(path.basename(t.file))) {
        t.done = true;
        this.#done++;
        this.#bytes += (await stat(t.file)).size;
      }
    }
  }

  async #downloadAll(tasks) {
    const queue = tasks.filter((t) => !t.done);
    let fatal = null;
    const worker = async () => {
      for (let t = queue.shift(); t && !fatal && !this.#controller.signal.aborted; t = queue.shift()) {
        this.#active++;
        try {
          await this.#retry(() => this.#fetchSegment(t));
        } catch (err) {
          if (!this.#controller.signal.aborted) {
            fatal = toDownloadError(err);
            this.#controller.abort();
          }
        } finally {
          this.#active--;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.#opts.connections) }, worker));
    if (fatal && !this.#stopReason) throw fatal;
  }

  async #fetchSegment(t) {
    let data = await this.#fetchBytes(t.url, t.range);
    if (t.key) {
      if (t.key.method !== 'AES-128') {
        throw new DownloadError('UNSUPPORTED_ENCRYPTION', `Encryption "${t.key.method}" is not supported (DRM)`);
      }
      const key = await this.#key(t.key.url);
      const decipher = createDecipheriv('aes-128-cbc', key, t.key.iv ?? sequenceIv(t.sequence));
      data = Buffer.concat([decipher.update(data), decipher.final()]);
    }
    await writeFile(`${t.file}.tmp`, data);
    await rename(`${t.file}.tmp`, t.file);
    t.done = true;
    this.#done++;
    this.#bytes += data.length;
  }

  #key(url) {
    if (!this.#keys.has(url)) {
      const p = this.#fetchBytes(url, null).then((b) => {
        if (b.length !== 16) throw new DownloadError('BAD_KEY', 'Invalid decryption key');
        return b;
      });
      p.catch(() => this.#keys.delete(url));
      this.#keys.set(url, p);
    }
    return this.#keys.get(url);
  }

  /** Join the segments into one file, converting to .mp4 if needed. */
  async #assemble(tasks, work, fmp4, hasAudio) {
    const concat = async (kind, name) => {
      const out = path.join(work, name);
      const fh = await open(out, 'w');
      try {
        for (const t of tasks.filter((x) => x.kind === kind)) await fh.write(await readFile(t.file));
      } finally {
        await fh.close();
      }
      return out;
    };
    const video = await concat('v', fmp4 ? 'video.mp4' : 'video.ts');
    const audio = hasAudio ? await concat('a', 'audio') : null;
    const part = `${this.#filePath}.part`;

    const needsRemux = this.#filePath.endsWith('.mp4') && (!fmp4 || audio);
    if (needsRemux) {
      await remuxToMp4(this.#opts.ffmpeg, { video, audio, output: part, signal: this.#controller.signal });
    } else {
      await rename(video, part);
    }
    this.#bytes = (await stat(part)).size;
    await rename(part, this.#filePath);
  }

  // ---------------------------------------------------------------- HTTP

  async #fetchText(url) {
    const res = await this.#request(url, null);
    return { url: res.url || url, text: await res.text() };
  }

  async #fetchBytes(url, range) {
    const res = await this.#request(url, range, true);
    const chunks = [];
    let got = 0;
    try {
      for await (const chunk of res.body) {
        res.touch();
        for (const l of this.#opts.limiters) await l.consume(chunk.byteLength, this.#controller.signal);
        chunks.push(chunk);
        got += chunk.byteLength;
        this.#inflight += chunk.byteLength;
        this.#meter.add(chunk.byteLength);
      }
    } catch (err) {
      throw res.reason() ?? err;
    } finally {
      this.#inflight -= got;
      res.dispose();
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  }

  /** fetch() with headers, the stop signal and a no-data timeout. */
  async #request(url, range, keepOpen = false) {
    const ctl = new AbortController();
    const parent = this.#controller.signal;
    const onAbort = () => ctl.abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    let timeoutError = null;
    let timer;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timeoutError = new DownloadError('TIMEOUT', 'No data received from server', { retryable: true });
        ctl.abort(timeoutError);
      }, this.#opts.readTimeoutMs);
    };
    const dispose = () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    };
    touch();
    try {
      const headers = { 'User-Agent': this.#opts.userAgent, ...this.#opts.headers };
      if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw statusError(res);
      }
      if (!keepOpen) {
        res.touch = touch;
        return res;
      }
      return Object.assign(res, { touch, dispose, reason: () => timeoutError });
    } catch (err) {
      dispose();
      throw timeoutError ?? err;
    } finally {
      if (!keepOpen) dispose();
    }
  }

  async #retry(fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const e = toDownloadError(err);
        if (this.#controller.signal.aborted || !e.retryable || attempt > this.#opts.maxRetries) throw e;
        this.emit('retry', { attempt, error: e });
        const delay = e.retryAfterMs ?? Math.min(this.#opts.retryDelayMs * 2 ** (attempt - 1), 30_000);
        await sleep(delay, undefined, { signal: this.#controller.signal });
      }
    }
  }
}
