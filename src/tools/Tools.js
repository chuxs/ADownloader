import { EventEmitter } from 'node:events';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { Download, DownloadState } from '../engine/Download.js';
import { isExecutable, run, which } from './process.js';

const IS_WIN = process.platform === 'win32';
const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp' }[process.platform] ?? 'yt-dlp';

/**
 * Finds the outside programs ADownloader can use, and installs yt-dlp on request.
 * - yt-dlp: video sites (downloaded into the app's tools folder)
 * - ffmpeg: joins video and audio, converts streams to .mp4
 * - 7-Zip:  extracts archives (falls back to the system "tar" for simple ones)
 *
 * Events: 'changed' (status)
 */
export class Tools extends EventEmitter {
  #dir;
  #overrides;
  #status = { ytdlp: null, ytdlpVersion: null, ffmpeg: null, sevenZip: null, tar: null, installing: false };

  /**
   * @param {string} toolsDir where downloaded tools are kept
   * @param {{ffmpegPath?: string, sevenZipPath?: string}} [overrides] paths chosen in settings
   */
  constructor(toolsDir, overrides = {}) {
    super();
    this.#dir = toolsDir;
    this.#overrides = overrides;
  }

  get status() {
    return { ...this.#status };
  }

  get ytdlp() {
    return this.#status.ytdlp;
  }

  get ffmpeg() {
    return this.#status.ffmpeg;
  }

  get sevenZip() {
    return this.#status.sevenZip;
  }

  get tar() {
    return this.#status.tar;
  }

  setOverrides(overrides) {
    this.#overrides = { ...this.#overrides, ...overrides };
    return this.refresh();
  }

  /** Look for every tool again. */
  async refresh() {
    const ownYtdlp = path.join(this.#dir, YTDLP_ASSET);
    const ytdlp = (await isExecutable(ownYtdlp)) ? ownYtdlp : await which('yt-dlp');
    let ytdlpVersion = null;
    if (ytdlp) {
      ytdlpVersion = await run(ytdlp, ['--version'], { timeoutMs: 30_000 })
        .then((r) => r.stdout.trim())
        .catch(() => null);
    }
    const sevenZipCandidates = IS_WIN
      ? [
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
        ]
      : [];
    Object.assign(this.#status, {
      ytdlp: ytdlpVersion ? ytdlp : null,
      ytdlpVersion,
      ffmpeg: (await this.#override('ffmpegPath')) ?? (await which('ffmpeg')),
      sevenZip:
        (await this.#override('sevenZipPath')) ??
        (await firstExisting(sevenZipCandidates)) ??
        (await which('7z')) ??
        (await which('7zz')),
      tar: await which('tar'),
    });
    this.emit('changed', this.status);
    return this.status;
  }

  /** Download the latest yt-dlp from its official GitHub releases and verify its checksum. */
  async installYtDlp() {
    if (this.#status.installing) return this.status;
    this.#set({ installing: true });
    try {
      await mkdir(this.#dir, { recursive: true });
      const target = path.join(this.#dir, YTDLP_ASSET);
      const tmpDir = path.join(this.#dir, 'download');
      await rm(tmpDir, { recursive: true, force: true });

      const sums = await (await fetch(`${YTDLP_RELEASE}/SHA2-256SUMS`)).text();
      const expected = sums
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .find(([, name]) => name === YTDLP_ASSET)?.[0];
      if (!expected) throw new Error('Could not find the yt-dlp checksum');

      const dl = new Download({
        url: `${YTDLP_RELEASE}/${YTDLP_ASSET}`,
        directory: tmpDir,
        fileName: YTDLP_ASSET,
        checksum: { algorithm: 'sha256', value: expected },
      });
      if ((await dl.start()) !== DownloadState.COMPLETED) {
        throw new Error(`yt-dlp download failed: ${dl.error?.message ?? 'unknown error'}`);
      }
      await rm(target, { force: true });
      await rename(dl.filePath, target);
      await rm(tmpDir, { recursive: true, force: true });
      if (!IS_WIN) await chmod(target, 0o755);
    } finally {
      this.#set({ installing: false });
    }
    return this.refresh();
  }

  /** Update yt-dlp in place (sites change often, so this matters). */
  async updateYtDlp() {
    if (!this.#status.ytdlp) return this.installYtDlp();
    this.#set({ installing: true });
    try {
      await run(this.#status.ytdlp, ['-U'], { timeoutMs: 180_000 });
    } finally {
      this.#set({ installing: false });
    }
    return this.refresh();
  }

  async #override(key) {
    const p = this.#overrides[key];
    return p && (await isExecutable(p)) ? p : null;
  }

  #set(patch) {
    Object.assign(this.#status, patch);
    this.emit('changed', this.status);
  }
}

async function firstExisting(paths) {
  for (const p of paths) if (await isExecutable(p)) return p;
  return null;
}
