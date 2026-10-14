import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { BROWSER_USER_AGENT } from './constants.js';
import { DownloadError, statusError, toDownloadError } from './errors.js';
import { fileNameFromContentDisposition, fileNameFromUrl, sanitizeFileName, uniquePath } from './filename.js';
import { RangeMap } from './RangeMap.js';
import { SpeedMeter } from './SpeedMeter.js';

const execFileAsync = promisify(execFile);
const MB = 1024 * 1024;

export const DownloadState = Object.freeze({
  IDLE: 'idle',
  PROBING: 'probing',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const DEFAULTS = {
  connections: 8,
  minChunkSize: 1 * MB,
  maxRetries: 5,
  retryDelayMs: 1000,
  readTimeoutMs: 30_000,
  writeBufferSize: 1 * MB,
  progressIntervalMs: 250,
  saveIntervalMs: 1000,
  /** What to do when the target file already exists: 'rename' | 'overwrite' | 'error' */
  ifExists: 'rename',
  userAgent: BROWSER_USER_AGENT,
};

const STATE_VERSION = 1;

/**
 * A single file download over HTTP(S).
 *
 * Splits the file into chunks downloaded over parallel connections when the
 * server supports byte ranges. Progress is tracked as a map of finished byte
 * ranges saved next to the file (`<file>.part.json`), so a paused, crashed or
 * failed download resumes where it stopped. When a connection runs out of
 * work it takes over half of the largest remaining chunk, so all connections
 * stay busy until the end.
 *
 * Events: 'state' (state), 'progress' (info), 'retry' ({attempt, error}),
 * 'connections' (new connection limit, after the server refused extra connections).
 */
export class Download extends EventEmitter {
  #opts;
  #state = DownloadState.IDLE;
  #error = null;

  #finalUrl = null;
  #fileName = null;
  #filePath = null;
  #size = null;
  #ranged = false;
  #etag = null;
  #lastModified = null;

  #map = new RangeMap();
  #meter = new SpeedMeter();
  #fh = null;

  #running = null;
  #controller = null;
  #stopReason = null;
  #fatal = null;
  /** @type {Set<Segment>} */
  #active = new Set();
  /** @type {Segment[]} */
  #pending = [];
  #connectionLimit = 1;

  /** True once this run loaded or created the .part file; guards against saving an empty map over real progress. */
  #prepared = false;
  #dirty = false;
  #saving = Promise.resolve();
  #lastSave = 0;
  #ticker = null;

  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} opts.directory folder to save into
   * @param {string} [opts.fileName] override the server-provided name
   * @param {string} [opts.filePath] exact target path; set when restoring a saved download
   * @param {Record<string, string>} [opts.headers] extra request headers (cookies, referer, ...)
   * @param {number} [opts.connections] max parallel connections
   * @param {{algorithm: string, value: string}} [opts.checksum] verify the finished file, e.g. sha256
   * @param {Array<{consume(bytes: number, signal: AbortSignal): Promise<void>}>} [opts.limiters] speed limits (per download and/or global)
   */
  constructor(opts) {
    super();
    if (!opts?.url) throw new TypeError('url is required');
    if (!opts.directory && !opts.filePath) throw new TypeError('directory or filePath is required');
    this.#opts = { ...DEFAULTS, ...opts, headers: { ...opts.headers }, limiters: opts.limiters ?? [] };
    this.#filePath = opts.filePath ?? null;
    this.#fileName = opts.filePath ? path.basename(opts.filePath) : null;
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
    const downloaded = this.#map.covered;
    const speed = this.#state === DownloadState.DOWNLOADING ? this.#meter.speed() : 0;
    const size = this.#size;
    return {
      url: this.#opts.url,
      finalUrl: this.#finalUrl,
      fileName: this.#fileName,
      filePath: this.#filePath,
      state: this.#state,
      size,
      downloaded,
      speed,
      eta: size != null && speed > 0 ? Math.round((size - downloaded) / speed) : null,
      connections: this.#active.size,
      resumable: this.#ranged,
      error: this.#error ? { code: this.#error.code, message: this.#error.message } : null,
    };
  }

  /** Options needed to recreate this download later (e.g. after an app restart). */
  toJSON() {
    const { url, directory, fileName, headers, connections, checksum } = this.#opts;
    return { url, directory, fileName, filePath: this.#filePath, headers, connections, checksum, state: this.#state };
  }

  /**
   * Start or resume. Resolves with the final state once the download
   * completes, fails, is paused or is cancelled. Never rejects; see `error`.
   */
  start() {
    if (!this.#running) {
      this.#running = this.#run().finally(() => {
        this.#running = null;
      });
    }
    return this.#running;
  }

  /** Stop and keep the partial file so `start()` can resume. */
  async pause() {
    if (!this.#running) return;
    this.#stopReason = DownloadState.PAUSED;
    this.#controller?.abort();
    await this.#running;
  }

  /** Stop and (by default) delete the partial file. */
  async cancel({ deleteFile = true } = {}) {
    if (this.#running) {
      this.#stopReason = DownloadState.CANCELLED;
      this.#controller?.abort();
      await this.#running;
    } else {
      this.#setState(DownloadState.CANCELLED);
    }
    if (deleteFile && this.#filePath) {
      await rm(this.#partPath, { force: true });
      await rm(this.#statePath, { force: true });
    }
  }

  get #partPath() {
    return `${this.#filePath}.part`;
  }

  get #statePath() {
    return `${this.#filePath}.part.json`;
  }

  get #signal() {
    return this.#controller.signal;
  }

  // ---------------------------------------------------------------- lifecycle

  async #run() {
    this.#controller = new AbortController();
    this.#stopReason = null;
    this.#fatal = null;
    this.#error = null;
    this.#prepared = false;
    this.#meter.reset();
    try {
      this.#setState(DownloadState.PROBING);
      const probe = await this.#withRetries(() => this.#probe());
      await this.#prepareFile(probe);

      this.#setState(DownloadState.DOWNLOADING);
      this.#startTicker();
      await this.#downloadAll();
      this.#stopTicker();

      await this.#finish();
      this.#setState(DownloadState.COMPLETED);
    } catch (err) {
      this.#stopTicker();
      if (this.#stopReason) {
        this.#setState(this.#stopReason);
      } else {
        this.#error = toDownloadError(err);
        this.#setState(DownloadState.FAILED);
      }
    } finally {
      this.#active.clear();
      if (this.#fh) {
        await this.#fh.close().catch(() => {});
        this.#fh = null;
      }
      if (this.#state !== DownloadState.COMPLETED && this.#prepared) await this.#saveState(true);
      this.emit('progress', this.info);
    }
    return this.#state;
  }

  #setState(state) {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', state);
  }

  #startTicker() {
    this.#ticker = setInterval(() => {
      this.emit('progress', this.info);
      if (Date.now() - this.#lastSave >= this.#opts.saveIntervalMs) this.#saveState();
    }, this.#opts.progressIntervalMs);
    this.#ticker.unref?.();
  }

  #stopTicker() {
    clearInterval(this.#ticker);
    this.#ticker = null;
  }

  // ---------------------------------------------------------------- probing

  #requestHeaders(extra = {}) {
    return {
      'User-Agent': this.#opts.userAgent,
      // Compressed responses break byte ranges and size checks.
      'Accept-Encoding': 'identity',
      ...this.#opts.headers,
      ...extra,
    };
  }

  /** Ask for the first byte to learn size, range support and file name. */
  async #probe() {
    const req = this.#timedRequest();
    try {
      const res = await fetch(this.#opts.url, {
        headers: this.#requestHeaders({ Range: 'bytes=0-0' }),
        signal: req.signal,
        redirect: 'follow',
      });
      await res.body?.cancel().catch(() => {});

      let size = null;
      let ranged = false;
      if (res.status === 206) {
        const cr = parseContentRange(res.headers.get('content-range'));
        if (cr?.total != null) {
          size = cr.total;
          ranged = true;
        }
      } else if (res.status === 200) {
        const len = res.headers.get('content-length');
        size = len != null ? Number(len) : null;
      } else if (res.status === 416) {
        // Range not satisfiable for an empty file: "bytes */0".
        const cr = parseContentRange(res.headers.get('content-range'));
        if (cr?.total === 0) size = 0;
        else throw statusError(res);
      } else {
        throw statusError(res);
      }

      const name =
        this.#opts.fileName ??
        fileNameFromContentDisposition(res.headers.get('content-disposition')) ??
        fileNameFromUrl(res.url) ??
        fileNameFromUrl(this.#opts.url);

      return {
        finalUrl: res.url || this.#opts.url,
        size,
        ranged,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        fileName: sanitizeFileName(name),
      };
    } catch (err) {
      throw req.reason() ?? err;
    } finally {
      req.dispose();
    }
  }

  // ---------------------------------------------------------------- file setup

  async #prepareFile(probe) {
    this.#finalUrl = probe.finalUrl;
    this.#size = probe.size;
    this.#ranged = probe.ranged;
    this.#etag = probe.etag;
    this.#lastModified = probe.lastModified;

    if (!this.#filePath) {
      const dir = this.#opts.directory;
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, probe.fileName);
      const saved = await readJson(`${target}.part.json`);
      if (saved?.url === this.#opts.url) {
        this.#filePath = target; // unfinished download of the same URL: resume it
      } else if (this.#opts.ifExists === 'overwrite') {
        this.#filePath = target;
        await rm(`${target}.part.json`, { force: true });
      } else if (this.#opts.ifExists === 'error' && (await fileExists(target))) {
        throw new DownloadError('FILE_EXISTS', `File already exists: ${target}`);
      } else {
        this.#filePath = await uniquePath(dir, probe.fileName);
      }
    }
    this.#fileName = path.basename(this.#filePath);

    const saved = await readJson(this.#statePath);
    const canResume =
      saved?.version === STATE_VERSION &&
      this.#ranged &&
      saved.size === this.#size &&
      (saved.etag ?? null) === (this.#etag ?? null) &&
      (saved.lastModified ?? null) === (this.#lastModified ?? null) &&
      (await fileExists(this.#partPath));

    if (canResume) {
      this.#map = new RangeMap(saved.ranges);
      this.#fh = await open(this.#partPath, 'r+');
    } else {
      this.#map = new RangeMap();
      await this.#createPartFile();
    }
    this.#prepared = true;
    this.#dirty = true;
    await this.#saveState(true);
  }

  async #createPartFile() {
    await writeFile(this.#partPath, '');
    // On Windows, writing far into an empty file makes NTFS zero-fill the gap
    // first. Marking the file sparse avoids that stall for multi-chunk downloads.
    if (process.platform === 'win32' && this.#ranged && (this.#size ?? 0) > 64 * MB) {
      await execFileAsync('fsutil', ['sparse', 'setflag', this.#partPath], { windowsHide: true }).catch(() => {});
    }
    this.#fh = await open(this.#partPath, 'r+');
    if (this.#size) await this.#fh.truncate(this.#size);
  }

  async #saveState(force = false) {
    if (!this.#dirty && !force) return;
    if (!this.#filePath || this.#state === DownloadState.COMPLETED) return;
    this.#dirty = false;
    this.#lastSave = Date.now();
    const data = JSON.stringify({
      version: STATE_VERSION,
      url: this.#opts.url,
      finalUrl: this.#finalUrl,
      size: this.#size,
      etag: this.#etag,
      lastModified: this.#lastModified,
      ranges: this.#map.toJSON(),
      updatedAt: new Date().toISOString(),
    });
    const target = this.#statePath;
    this.#saving = this.#saving.then(async () => {
      try {
        await writeFile(`${target}.tmp`, data);
        await rename(`${target}.tmp`, target);
      } catch {
        this.#dirty = true; // try again on the next tick
      }
    });
    await this.#saving;
  }

  // ---------------------------------------------------------------- downloading

  async #downloadAll() {
    this.#connectionLimit = this.#ranged ? Math.max(1, this.#opts.connections) : 1;

    // Usually one round. Another round runs only if a connection gave up early
    // (e.g. the server stopped honouring ranges) and left a gap behind.
    for (;;) {
      const before = this.#map.covered;
      if (this.#ranged) {
        this.#pending = this.#map.missing(this.#size).map(([s, e]) => new Segment(s, e));
      } else {
        this.#map.clear();
        this.#pending = [new Segment(0, this.#size ?? Infinity)];
      }
      if (this.#pending.length === 0) return;

      const workers = Array.from({ length: this.#connectionLimit }, () => this.#worker());
      await Promise.all(workers);

      if (this.#stopReason) throw new DownloadError('ABORTED', 'Stopped');
      if (this.#fatal) throw this.#fatal;
      if (!this.#ranged) {
        if (this.#size == null) this.#size = this.#map.covered;
        if (this.#map.covered !== this.#size) {
          throw new DownloadError('INCOMPLETE', 'Server closed the connection early', { retryable: true });
        }
        return;
      }
      if (this.#map.isComplete(this.#size)) return;
      if (this.#map.covered === before) throw new DownloadError('INCOMPLETE', 'Download made no progress');
    }
  }

  async #worker() {
    while (!this.#signal.aborted) {
      const seg = this.#takeSegment();
      if (!seg) return;
      this.#active.add(seg);
      try {
        await this.#runSegment(seg);
      } catch (err) {
        const e = toDownloadError(err);
        if (this.#signal.aborted) return;
        if (this.#active.size > 1 && (e.retryable || e.code === 'RANGE_IGNORED')) {
          // The server limits parallel connections (or this one keeps failing).
          // Drop this connection; the others take over the rest of its chunk.
          this.#connectionLimit = Math.max(1, this.#active.size - 1);
          if (seg.pos < seg.end) this.#pending.push(new Segment(seg.pos, seg.end));
          this.emit('connections', this.#connectionLimit);
          return;
        }
        this.#fatal ??= e;
        this.#controller.abort();
        return;
      } finally {
        this.#active.delete(seg);
      }
    }
  }

  /** Next chunk to work on: an unassigned one, or half of the busiest one. */
  #takeSegment() {
    if (this.#pending.length) return this.#pending.shift();
    if (!this.#ranged || this.#active.size >= this.#connectionLimit) return null;

    let victim = null;
    for (const seg of this.#active) {
      if (!victim || seg.remaining > victim.remaining) victim = seg;
    }
    if (!victim || victim.remaining < 2 * this.#opts.minChunkSize) return null;
    const mid = victim.received + Math.floor(victim.remaining / 2);
    const stolen = new Segment(mid, victim.end);
    victim.end = mid;
    return stolen;
  }

  async #runSegment(seg) {
    let attempt = 0;
    while (seg.received < seg.end) {
      if (this.#signal.aborted) return;
      const before = seg.pos;
      try {
        await this.#fetchSegment(seg);
        if (seg.end === Infinity) return; // unknown size: stream ended normally
        if (seg.pos < seg.end) {
          throw new DownloadError('CONNECTION_CLOSED', 'Server closed the connection early', { retryable: true });
        }
      } catch (err) {
        const e = toDownloadError(err);
        if (this.#signal.aborted) return;
        if (!e.retryable) throw e;
        // "Too many requests" while other connections work: give this one up now.
        if (e.status === 429 && this.#active.size > 1) throw e;
        if (this.#ranged && seg.pos > before) {
          attempt = 0; // made progress: reconnect right away
          continue;
        }
        if (++attempt > this.#opts.maxRetries) throw e;
        this.emit('retry', { attempt, error: e });
        const delay = e.retryAfterMs ?? Math.min(this.#opts.retryDelayMs * 2 ** (attempt - 1), 30_000);
        await sleep(delay, undefined, { signal: this.#signal }).catch(() => {});
      }
    }
  }

  async #fetchSegment(seg) {
    if (!this.#ranged && seg.pos > 0) {
      // No range support: a broken connection means starting over.
      this.#map.clear();
      seg.pos = seg.received = 0;
      await this.#fh.truncate(0);
    }

    const headers = {};
    if (this.#ranged) {
      headers.Range = `bytes=${seg.pos}-${seg.end - 1}`;
      // If the file changed on the server, it answers 200 instead of 206.
      const validator = this.#etag && !this.#etag.startsWith('W/') ? this.#etag : this.#lastModified;
      if (validator) headers['If-Range'] = validator;
    }

    const req = this.#timedRequest();
    const bufs = [];
    let buffered = 0;
    try {
      const res = await fetch(this.#finalUrl, {
        headers: this.#requestHeaders(headers),
        signal: req.signal,
        redirect: 'follow',
      });

      if (res.status === 206) {
        const cr = parseContentRange(res.headers.get('content-range'));
        if (!cr || cr.start !== seg.pos) {
          await res.body?.cancel().catch(() => {});
          throw new DownloadError('BAD_RANGE', `Server sent the wrong range (${res.headers.get('content-range')})`);
        }
      } else if (res.status === 200) {
        if (this.#ranged && seg.pos > 0) {
          await res.body?.cancel().catch(() => {});
          throw new DownloadError('RANGE_IGNORED', 'Server ignored the range request or the file changed');
        }
      } else {
        await res.body?.cancel().catch(() => {});
        throw statusError(res);
      }

      for await (const chunk of res.body) {
        req.touch();
        let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const room = seg.end - seg.received;
        if (buf.length > room) buf = buf.subarray(0, room);
        for (const limiter of this.#opts.limiters) await limiter.consume(buf.length, req.signal);

        seg.received += buf.length;
        this.#meter.add(buf.length);
        bufs.push(buf);
        buffered += buf.length;
        if (buffered >= this.#opts.writeBufferSize) {
          await this.#write(seg, bufs.splice(0), buffered);
          buffered = 0;
        }
        // Reached the end, which may have moved closer if another connection took half.
        if (seg.received >= seg.end) break;
      }
    } catch (err) {
      throw req.reason() ?? err;
    } finally {
      req.dispose();
      // Keep whatever arrived before an error; the retry continues after it.
      if (buffered) await this.#write(seg, bufs, buffered);
      seg.received = seg.pos;
    }
  }

  async #write(seg, bufs, length) {
    const data = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs, length);
    await this.#fh.write(data, 0, length, seg.pos);
    this.#map.add(seg.pos, seg.pos + length);
    seg.pos += length;
    this.#dirty = true;
  }

  /**
   * AbortController tied to the download's controller, which also aborts when
   * no data arrives for `readTimeoutMs`. Call touch() whenever data arrives.
   */
  #timedRequest() {
    const ctl = new AbortController();
    const parent = this.#signal;
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
    touch();
    return {
      signal: ctl.signal,
      touch,
      reason: () => timeoutError,
      dispose: () => {
        clearTimeout(timer);
        parent.removeEventListener('abort', onAbort);
        ctl.abort();
      },
    };
  }

  async #withRetries(fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const e = toDownloadError(err);
        if (this.#signal.aborted || !e.retryable || attempt > this.#opts.maxRetries) throw e;
        this.emit('retry', { attempt, error: e });
        const delay = e.retryAfterMs ?? Math.min(this.#opts.retryDelayMs * 2 ** (attempt - 1), 30_000);
        await sleep(delay, undefined, { signal: this.#signal });
      }
    }
  }

  // ---------------------------------------------------------------- finishing

  async #finish() {
    await this.#saving;
    await this.#fh.datasync().catch(() => {});
    await this.#fh.close();
    this.#fh = null;

    const actual = (await stat(this.#partPath)).size;
    if (this.#size != null && actual !== this.#size) {
      throw new DownloadError('SIZE_MISMATCH', `Expected ${this.#size} bytes but file has ${actual}`);
    }

    const { checksum } = this.#opts;
    if (checksum?.value) {
      this.#setState(DownloadState.VERIFYING);
      const digest = await hashFile(this.#partPath, checksum.algorithm, this.#signal);
      if (digest.toLowerCase() !== checksum.value.toLowerCase()) {
        throw new DownloadError('CHECKSUM_MISMATCH', `${checksum.algorithm} does not match`);
      }
    }

    await rename(this.#partPath, this.#filePath);
    await rm(this.#statePath, { force: true });
  }
}

class Segment {
  constructor(start, end) {
    this.start = start;
    /** bytes written to disk up to here */
    this.pos = start;
    /** bytes received (written + buffered) up to here */
    this.received = start;
    /** exclusive; may shrink when another connection takes half */
    this.end = end;
  }

  get remaining() {
    return this.end - this.received;
  }
}

/** Parse "bytes 0-99/1234", "bytes 0-99/*" or "bytes *\/1234". */
export function parseContentRange(header) {
  if (!header) return null;
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return null;
  return {
    start: m[1] != null ? Number(m[1]) : null,
    end: m[2] != null ? Number(m[2]) : null,
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(file, algorithm, signal) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
