import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const VIDEO = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|flv|mpg|mpeg|3gp|ts)$/i;
/** yt-dlp keeps video and audio as "name.f137.mp4" until it joins them: not a finished video. */
const INTERMEDIATE = /\.f[\w-]+\.\w+$/i;

export function isVideoLink(link) {
  return link.pluginId === 'ytdlp' || link.pluginId === 'hls' || VIDEO.test(link.name ?? '');
}

/**
 * Spreads videos over numbered folders: "Trip", "Trip 2", "Trip 3", ...
 * Each folder takes up to `limit` videos. When the newest one is full, the
 * user is asked before the next folder is created.
 *
 * Only links whose package saves into the chosen base folder are affected.
 */
export class FolderSplitter {
  #enabled = false;
  #base = '';
  #limit = 15;
  #ask;
  /** @type {Map<string, string>} linkId -> folder, for downloads not finished yet */
  #assigned = new Map();
  #lock = Promise.resolve();
  #declined = false;

  /**
   * @param {(q: {full: string, next: string, limit: number}) => Promise<boolean>} ask
   *        asks the user whether to create `next`
   */
  constructor(ask) {
    this.#ask = ask;
  }

  configure({ enabled, base, limit }) {
    if (enabled !== undefined) this.#enabled = Boolean(enabled);
    if (base !== undefined) this.#base = base ? path.resolve(base) : '';
    if (limit !== undefined) this.#limit = Math.max(1, Math.floor(limit));
  }

  get active() {
    return this.#enabled && Boolean(this.#base);
  }

  /** Does this link get its folder from the splitter? */
  appliesTo(link, pkg) {
    return this.active && samePath(pkg.directory, this.#base) && isVideoLink(link);
  }

  /** Called when downloads are started again after the user said "not now". */
  resetDecline() {
    this.#declined = false;
  }

  /**
   * Folder for a video about to start, or null if the user declined a new folder.
   * Calls are handled one at a time so two downloads can't both take the 15th spot.
   */
  allocate(linkId) {
    const run = this.#lock.then(() => this.#allocate(linkId));
    this.#lock = run.catch(() => {});
    return run;
  }

  /** The download ended (finished, paused, failed or removed). */
  release(linkId) {
    this.#assigned.delete(linkId);
  }

  folderName(n) {
    return n <= 1 ? this.#base : `${this.#base} ${n}`;
  }

  async #allocate(linkId) {
    if (this.#declined) return null;
    if (this.#assigned.has(linkId)) return this.#assigned.get(linkId);

    // Continue in the newest folder of the series.
    let n = 1;
    while (await exists(this.folderName(n + 1))) n++;

    for (;;) {
      const folder = this.folderName(n);
      if ((await this.countVideos(folder)) < this.#limit) {
        await mkdir(folder, { recursive: true });
        this.#assigned.set(linkId, folder);
        return folder;
      }
      const next = this.folderName(n + 1);
      if (!(await exists(next))) {
        const ok = await this.#ask({ full: folder, next, limit: this.#limit });
        if (!ok) {
          this.#declined = true;
          return null;
        }
        await mkdir(next, { recursive: true });
      }
      n++;
    }
  }

  /** Finished videos in the folder plus videos currently downloading into it. */
  async countVideos(folder) {
    const names = await readdir(folder).catch(() => []);
    const onDisk = names.filter((n) => VIDEO.test(n) && !INTERMEDIATE.test(n)).length;
    let inProgress = 0;
    for (const f of this.#assigned.values()) if (samePath(f, folder)) inProgress++;
    return onDisk + inProgress;
  }
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

async function exists(p) {
  return Boolean(await stat(p).catch(() => null));
}
