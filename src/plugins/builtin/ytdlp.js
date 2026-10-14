import { EventEmitter } from 'node:events';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { DownloadState } from '../../engine/Download.js';
import { DownloadError } from '../../engine/errors.js';
import { sanitizeFileName, uniquePath } from '../../engine/filename.js';
import { killTree, run, start } from '../../tools/process.js';
import { PluginError } from '../PluginError.js';

const COMMON_ARGS = ['--ignore-config', '--no-warnings', '--no-playlist'];

/**
 * Quality choice: best resolution, then frame rate; at equal resolution prefer
 * H.264/AAC, which every player handles. Joining separate video and audio
 * needs ffmpeg; without it only files that contain both can be used.
 */
function formatArgs(ffmpeg) {
  return ffmpeg ? ['-f', 'bv*+ba/b', '-S', 'res,fps,vcodec:h264,acodec:aac'] : ['-f', 'b'];
}

/**
 * Ask yt-dlp what is at a URL, with the same quality choice as the download
 * so the reported size matches.
 * @returns {Promise<object>} yt-dlp's JSON (a video, or a playlist with flat entries)
 */
export async function ytdlpInfo(ytdlp, url, { signal, ffmpeg = null, timeoutMs = 90_000 } = {}) {
  try {
    const args = [...COMMON_ARGS.filter((a) => a !== '--no-playlist'), ...formatArgs(ffmpeg), '-J', '--flat-playlist', url];
    const { stdout } = await run(ytdlp, args, { signal, timeoutMs });
    return JSON.parse(stdout);
  } catch (err) {
    throw ytdlpError(err.stderr || err.message);
  }
}

function ytdlpError(text) {
  const msg = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'))
    .at(-1)
    ?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '') ?? String(text).trim().split('\n').at(-1);
  if (/unsupported url/i.test(msg)) return new PluginError('UNSUPPORTED', 'Not a supported video page');
  if (/unavailable|private|removed|deleted|not found|404|does not exist/i.test(msg)) return new PluginError('OFFLINE', msg);
  if (/sign in|log in|login|members only|premium|\bage[- ]?(restrict|verif|gate)/i.test(msg)) {
    return new PluginError('ACCOUNT_REQUIRED', msg);
  }
  const retryable = /HTTP Error 5\d\d|timed out|timeout|connection|temporar|429/i.test(msg);
  return new PluginError(retryable ? 'TEMPORARY' : 'YTDLP', msg || 'yt-dlp failed', { retryable });
}

/** Preview image: the main thumbnail, or the largest listed one. */
function thumbnailOf(info) {
  if (info.thumbnail) return info.thumbnail;
  const list = (info.thumbnails ?? []).filter((t) => t?.url?.startsWith('http'));
  list.sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.preference ?? 0) - (a.preference ?? 0));
  return list[0]?.url;
}

function videoName(info, hasFfmpeg) {
  const ext = hasFfmpeg ? 'mp4' : (info.ext ?? 'mp4');
  return `${sanitizeFileName(info.title ?? info.id ?? 'video', 'video')}.${ext}`;
}

/**
 * Size of the chosen format(s). Streams often have no exact size; then it is
 * estimated from bitrate x duration and marked approximate.
 * @returns {{size: number|null, sizeApprox: boolean}}
 */
export function videoSize(info) {
  const formats = info.requested_formats?.length ? info.requested_formats : [info];
  const duration = info.duration;
  let total = 0;
  let approx = false;
  for (const f of formats) {
    let size = f.filesize ?? null;
    if (!size) {
      approx = true;
      const kbps = f.tbr ?? ((f.vbr ?? 0) + (f.abr ?? 0) || null);
      size = f.filesize_approx ?? (kbps && duration ? (kbps * 1000 * duration) / 8 : null);
    }
    if (!size) return { size: null, sizeApprox: false };
    total += size;
  }
  return { size: Math.round(total), sizeApprox: approx };
}

/**
 * Plugin for video sites, backed by yt-dlp (https://github.com/yt-dlp/yt-dlp),
 * which supports well over a thousand sites. Only active when yt-dlp is installed.
 * @param {import('../../tools/Tools.js').Tools} tools
 * @returns {import('../PluginRegistry.js').Plugin & {available(): boolean}}
 */
export function createYtDlpPlugin(tools) {
  return {
    id: 'ytdlp',
    name: 'Video sites (yt-dlp)',
    type: 'host',
    patterns: [],

    available: () => Boolean(tools.ytdlp),

    /** Used by the crawler for web pages: video(s) on the page, or throws UNSUPPORTED. */
    async crawl(url, ctx) {
      const info = await ytdlpInfo(tools.ytdlp, url, { signal: ctx.signal, ffmpeg: tools.ffmpeg });
      if (info._type === 'playlist') {
        return (info.entries ?? [])
          .filter((e) => e?.url)
          .map((e) => ({
            url: e.url.startsWith('http') ? e.url : (e.webpage_url ?? e.url),
            name: e.title ? videoName(e, Boolean(tools.ffmpeg)) : undefined,
            packageName: info.title ?? undefined,
            thumbnail: thumbnailOf(e),
            pluginId: 'ytdlp',
          }));
      }
      return [
        {
          url: info.webpage_url ?? url,
          name: videoName(info, Boolean(tools.ffmpeg)),
          ...videoSize(info),
          packageName: info.title ?? undefined,
          thumbnail: thumbnailOf(info),
          pluginId: 'ytdlp',
          checked: true,
        },
      ];
    },

    async check(link, ctx) {
      if (!tools.ytdlp) throw new PluginError('TEMPORARY', 'yt-dlp is not installed (Settings → Video sites)');
      const info = await ytdlpInfo(tools.ytdlp, link.url, { signal: ctx.signal, ffmpeg: tools.ffmpeg });
      return { available: true, name: videoName(info, Boolean(tools.ffmpeg)), ...videoSize(info), thumbnail: thumbnailOf(info) };
    },

    createDownload(link, opts) {
      if (!tools.ytdlp) throw new PluginError('NEEDS_TOOL', 'yt-dlp is not installed (Settings → Video sites)');
      return new YtDlpDownload({
        ytdlp: tools.ytdlp,
        ffmpeg: tools.ffmpeg,
        url: link.url,
        name: link.name,
        expectedSize: link.size,
        ...opts,
      });
    },
  };
}

/**
 * Runs yt-dlp to download one video. Same interface as Download.
 * Pausing stops yt-dlp; it continues its partial files when started again.
 */
export class YtDlpDownload extends EventEmitter {
  #o;
  #state = DownloadState.IDLE;
  #error = null;
  #filePath;
  #child = null;
  #running = null;
  #stopReason = null;
  #progress = { base: 0, downloaded: 0, total: null, speed: 0, eta: null, format: null, lastTotal: 0 };
  #phase = null;
  #destinations = new Set();
  #ticker = null;

  /**
   * @param {{ytdlp: string, ffmpeg?: string|null, url: string, name?: string, directory?: string,
   *          fileName?: string, filePath?: string, connections?: number, limiters?: Array<{rate?: number}>,
   *          expectedSize?: number|null}} opts
   */
  constructor(opts) {
    super();
    this.#o = opts;
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
    const p = this.#progress;
    // yt-dlp reports video and audio one at a time; until the end, don't show
    // less than the size known from the link check.
    let size = p.total != null ? p.base + p.total : null;
    if (this.#state !== DownloadState.COMPLETED && this.#o.expectedSize) size = Math.max(size ?? 0, this.#o.expectedSize);
    return {
      url: this.#o.url,
      fileName: this.#filePath ? path.basename(this.#filePath) : null,
      filePath: this.#filePath,
      state: this.#state,
      size,
      downloaded: p.base + p.downloaded,
      speed: this.#state === DownloadState.DOWNLOADING ? p.speed : 0,
      eta: p.eta,
      connections: this.#child ? 1 : 0,
      resumable: true,
      phase: this.#phase,
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
    killTree(this.#child);
    await this.#running;
  }

  async cancel({ deleteFile = true } = {}) {
    if (this.#running) {
      this.#stopReason = DownloadState.CANCELLED;
      killTree(this.#child);
      await this.#running;
    } else this.#setState(DownloadState.CANCELLED);
    if (deleteFile) await this.#deletePartials();
  }

  async #run() {
    this.#stopReason = null;
    this.#error = null;
    this.#progress = { base: 0, downloaded: 0, total: null, speed: 0, eta: null, format: null, lastTotal: 0 };
    try {
      this.#setState(DownloadState.PROBING);
      await this.#chooseFile();
      this.#setState(DownloadState.DOWNLOADING);
      this.#ticker = setInterval(() => this.emit('progress', this.info), 250);
      await this.#spawn();
      this.#setState(DownloadState.COMPLETED);
    } catch (err) {
      if (this.#stopReason) this.#setState(this.#stopReason);
      else {
        this.#error = err instanceof DownloadError ? err : ytdlpError(err.message);
        this.#setState(DownloadState.FAILED);
      }
    } finally {
      clearInterval(this.#ticker);
      this.#child = null;
      this.#phase = null;
      this.emit('progress', this.info);
    }
    return this.#state;
  }

  #setState(state) {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', state);
  }

  async #chooseFile() {
    if (this.#filePath) return;
    const dir = this.#o.directory;
    await mkdir(dir, { recursive: true });
    const name = this.#o.fileName ?? this.#o.name ?? 'video.mp4';
    const ext = path.extname(name) || (this.#o.ffmpeg ? '.mp4' : '');
    this.#filePath = await uniquePath(dir, sanitizeFileName(name.slice(0, name.length - path.extname(name).length)) + ext);
  }

  /** Output template: the chosen path with yt-dlp filling in the real extension. */
  get #template() {
    const ext = path.extname(this.#filePath);
    return `${this.#filePath.slice(0, this.#filePath.length - ext.length)}.%(ext)s`;
  }

  #spawn() {
    const o = this.#o;
    const args = [
      ...COMMON_ARGS,
      '--newline',
      '--progress',
      '--no-mtime',
      '--no-simulate',
      '--print',
      'after_move:ADLFILE %(filepath)s',
      '--progress-template',
      'download:ADLPROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s',
      '-N',
      String(o.connections ?? 4),
      '-o',
      this.#template,
    ];
    args.push(...formatArgs(o.ffmpeg));
    if (o.ffmpeg) args.push('--ffmpeg-location', o.ffmpeg, '--merge-output-format', 'mp4');
    const rate = o.limiters?.find((l) => l.rate > 0)?.rate;
    if (rate) args.push('--limit-rate', String(rate));
    args.push(o.url);

    return new Promise((resolve, reject) => {
      const child = start(o.ytdlp, args);
      this.#child = child;
      const errors = [];
      createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
      createInterface({ input: child.stderr }).on('line', (line) => {
        if (line.startsWith('ERROR:')) errors.push(line);
        else this.#onLine(line);
      });
      child.on('error', (err) => reject(new DownloadError('YTDLP', `Could not run yt-dlp: ${err.message}`)));
      child.on('close', async (code) => {
        if (this.#stopReason) return reject(new DownloadError('ABORTED', 'Stopped'));
        if (code === 0) {
          // Reported size = real file size, now that it is final.
          const size = await stat(this.#filePath).then((s) => s.size).catch(() => null);
          if (size != null) Object.assign(this.#progress, { base: 0, downloaded: size, total: size });
          return resolve();
        }
        reject(ytdlpError(errors.join('\n') || `yt-dlp exited with code ${code}`));
      });
    });
  }

  #onLine(line) {
    if (line.startsWith('ADLPROG|')) {
      const [, done, total, estimate, speed, eta, format] = line.split('|').map((v) => (v === 'NA' || v === 'None' ? null : v));
      const p = this.#progress;
      // yt-dlp downloads video and audio one after the other: carry the first over.
      if (p.format && format !== p.format) p.base += p.lastTotal;
      p.format = format;
      p.downloaded = Number(done) || 0;
      p.total = Number(total ?? estimate) || null;
      p.lastTotal = p.total ?? p.downloaded;
      p.speed = Number(speed) || 0;
      p.eta = eta != null ? Number(eta) : null;
      this.#phase = null;
    } else if (line.startsWith('ADLFILE ')) {
      this.#filePath = line.slice(8).trim();
    } else if (/^\[(Merger|VideoConvertor|FixupM3u8|ExtractAudio)\]/.test(line)) {
      this.#phase = 'merging';
    } else {
      const dest = /^\[download\] Destination: (.+)$/.exec(line);
      if (dest) this.#destinations.add(dest[1].trim());
    }
  }

  async #deletePartials() {
    if (!this.#filePath) return;
    const dir = path.dirname(this.#filePath);
    const base = path.basename(this.#template).replace('.%(ext)s', '');
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.startsWith(`${base}.`)) continue;
      const full = path.join(dir, name);
      const partial = /\.(part|ytdl|temp)$|\.part-Frag\d+|\.f[\w-]+\.\w+$/.test(name) || this.#destinations.has(full);
      if (partial) await rm(full, { force: true });
    }
  }
}
