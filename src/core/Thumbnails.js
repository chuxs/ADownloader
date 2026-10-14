import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BROWSER_USER_AGENT } from '../engine/constants.js';
import { makeThumbnail } from '../engine/ffmpeg.js';
import { LinkState } from './DownloadList.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MEDIA = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|mpg|mpeg|3gp|jpe?g|png|gif|webp|bmp)$/i;

/**
 * Thumbnails for links, cached as files in one folder:
 * - links with a `thumbnail` URL (from yt-dlp or a page's preview image) get it downloaded;
 * - finished video/image files without one get a frame grabbed by ffmpeg.
 * When a thumbnail is ready the link gets `thumbKey`, the cached file's name.
 *
 * Events: 'ready'
 */
export class Thumbnails extends EventEmitter {
  #dir;
  #tools;
  #lists;
  #pending = new Set();
  #failed = new Set();
  #timer = null;
  #running = 0;
  #queue = [];
  /** @type {Map<string, Promise<string>>} */
  #fetching = new Map();

  /**
   * @param {string} dir cache folder
   * @param {{ffmpeg: string|null}} tools
   * @param {Array<{links(): Iterable<object>, updateLink(id: string, patch: object): void, on: Function}>} lists
   *        the download list and the link grabber
   */
  constructor(dir, tools, lists) {
    super();
    this.#dir = dir;
    this.#tools = tools;
    this.#lists = lists;
    for (const list of lists) list.on('changed', () => this.#scheduleScan());
    for (const list of lists) list.on('added', () => this.#scheduleScan());
  }

  /** Full path of a cached thumbnail, or null for an invalid key. */
  fileFor(key) {
    return /^[\w-]{6,64}\.jpg$/.test(key) ? path.join(this.#dir, key) : null;
  }

  /** Delete cached thumbnails no link refers to any more. */
  async cleanup() {
    const used = new Set();
    for (const list of this.#lists) for (const l of list.links()) if (l.thumbKey) used.add(l.thumbKey);
    for (const name of await readdir(this.#dir).catch(() => [])) {
      if (!used.has(name)) await rm(path.join(this.#dir, name), { force: true });
    }
  }

  scan() {
    for (const list of this.#lists) {
      for (const link of list.links()) {
        if (link.thumbKey || this.#pending.has(link.id) || this.#failed.has(link.id)) continue;
        if (link.thumbnail) this.#enqueue(list, link, () => this.#fetch(link.thumbnail));
        else if (link.state === LinkState.COMPLETED && link.filePath && MEDIA.test(link.filePath) && this.#tools.ffmpeg) {
          this.#enqueue(list, link, () => this.#generate(link.filePath, link.id));
        }
      }
    }
  }

  #scheduleScan() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.scan(), 300);
    this.#timer.unref?.();
  }

  #enqueue(list, link, make) {
    this.#pending.add(link.id);
    this.#queue.push(async () => {
      try {
        const key = await make();
        list.updateLink(link.id, { thumbKey: key });
        this.emit('ready');
      } catch {
        this.#failed.add(link.id); // don't retry a broken thumbnail on every change
      } finally {
        this.#pending.delete(link.id);
      }
    });
    this.#pump();
  }

  async #pump() {
    while (this.#running < 3 && this.#queue.length) {
      const job = this.#queue.shift();
      this.#running++;
      job().finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }

  /** Download a remote thumbnail; links sharing a URL share one download. */
  #fetch(url) {
    const key = `${createHash('sha1').update(url).digest('hex').slice(0, 20)}.jpg`;
    if (!this.#fetching.has(key)) {
      const p = this.#download(url, key).finally(() => this.#fetching.delete(key));
      this.#fetching.set(key, p);
    }
    return this.#fetching.get(key);
  }

  async #download(url, key) {
    const file = path.join(this.#dir, key);
    if (await stat(file).catch(() => null)) return key;
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') ?? 'image/')) throw new Error('not an image');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length === 0 || data.length > MAX_BYTES) throw new Error('bad size');
    await mkdir(this.#dir, { recursive: true });
    await writeFile(`${file}.tmp`, data);
    await rename(`${file}.tmp`, file);
    return key;
  }

  /** Grab a frame from a finished file. */
  async #generate(filePath, linkId) {
    const key = `f-${createHash('sha1').update(linkId).digest('hex').slice(0, 20)}.jpg`;
    await mkdir(this.#dir, { recursive: true });
    await makeThumbnail(this.#tools.ffmpeg, filePath, path.join(this.#dir, key));
    return key;
  }
}
