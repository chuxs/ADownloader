import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { JsonStore } from './JsonStore.js';
import { fileNameFromUrl } from '../engine/filename.js';

/** Link states as stored in the list. */
export const LinkState = Object.freeze({
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  /** failed with a temporary error; goes back to QUEUED at `retryAt` */
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const LIST_VERSION = 1;

/**
 * @typedef {object} Link
 * @property {string} id
 * @property {string} packageId
 * @property {string} url           as added; for site plugins this is the page, not the file
 * @property {string} pluginId      host plugin that downloads it ('directhttp' for plain file links)
 * @property {object} [data]        plugin-private data
 * @property {string} name          shown name; replaced by the real file name once known
 * @property {string|null} customName name chosen by the user, used instead of the server's
 * @property {string|null} filePath set once the download has picked its file
 * @property {string} state         one of LinkState
 * @property {boolean} enabled
 * @property {number} priority      higher starts first; -1..2
 * @property {number|null} size
 * @property {boolean} sizeApprox    size is an estimate until the download finishes
 * @property {string|null} thumbnail  remote preview image URL, if the site gave one
 * @property {string|null} thumbKey   cached thumbnail file name (see core/Thumbnails.js)
 * @property {number} downloaded
 * @property {{code: string, message: string}|null} error
 * @property {number} retries       automatic retries used so far
 * @property {number|null} retryAt  epoch ms, when WAITING
 * @property {Record<string,string>} [headers]
 * @property {{algorithm: string, value: string}} [checksum]
 * @property {number} addedAt
 * @property {number|null} finishedAt
 *
 * @typedef {object} Package
 * @property {string} id
 * @property {string} name
 * @property {string} directory
 * @property {number} priority
 * @property {number} addedAt
 * @property {Link[]} links
 */

/**
 * The download list: packages of links, kept in order and saved to disk.
 * Holds data only; the Scheduler does the downloading.
 *
 * Events: 'added' (Package), 'removed' (linkIds[]), 'changed' (Link), 'reordered'.
 */
export class DownloadList extends EventEmitter {
  /** @type {Package[]} */
  #packages = [];
  /** @type {Map<string, Link>} */
  #links = new Map();
  #store;

  /** @param {{file: string, saveDelayMs?: number}} opts */
  constructor({ file, saveDelayMs = 1000 }) {
    super();
    this.#store = new JsonStore(file, () => this.toJSON(), saveDelayMs);
  }

  async load() {
    const data = await this.#store.load();
    this.#packages = [];
    this.#links.clear();
    for (const pkg of data?.packages ?? []) {
      for (const link of pkg.links) {
        link.packageId = pkg.id;
        // Nothing is running right after a restart.
        if (link.state === LinkState.DOWNLOADING || link.state === LinkState.WAITING) {
          link.state = LinkState.QUEUED;
          link.retryAt = null;
        }
        this.#links.set(link.id, link);
      }
      this.#packages.push(pkg);
    }
  }

  save() {
    return this.#store.save();
  }

  toJSON() {
    return { version: LIST_VERSION, packages: this.#packages };
  }

  get packages() {
    return this.#packages;
  }

  getLink(id) {
    return this.#links.get(id);
  }

  getPackage(id) {
    return this.#packages.find((p) => p.id === id);
  }

  /** All links in display order (package order, then link order). */
  *links() {
    for (const pkg of this.#packages) yield* pkg.links;
  }

  /**
   * Add a package of links at the end of the list.
   * @param {{name?: string, directory: string, priority?: number,
   *          links: Array<{url: string, name?: string, displayName?: string, size?: number|null, sizeApprox?: boolean,
   *                        thumbnail?: string, thumbKey?: string,
   *                        pluginId?: string, data?: object, headers?: Record<string,string>,
   *                        checksum?: {algorithm: string, value: string}, priority?: number}>}} input
   *   name: file name chosen by the user (overrides the server's);
   *   displayName: name known so far (e.g. from the link check), replaced by the real one
   * @returns {Package}
   */
  addPackage(input) {
    if (!input.directory) throw new TypeError('directory is required');
    const now = Date.now();
    /** @type {Package} */
    const pkg = {
      id: randomUUID(),
      name: input.name || guessPackageName(input.links) || 'Downloads',
      directory: path.resolve(input.directory),
      priority: input.priority ?? 0,
      addedAt: now,
      links: [],
    };
    for (const l of input.links) {
      new URL(l.url); // throws on an invalid URL
      pkg.links.push({
        id: randomUUID(),
        packageId: pkg.id,
        url: l.url,
        pluginId: l.pluginId ?? 'directhttp',
        data: l.data,
        name: l.name || l.displayName || fileNameFromUrl(l.url) || l.url,
        customName: l.name || null,
        filePath: null,
        state: LinkState.QUEUED,
        enabled: true,
        priority: l.priority ?? 0,
        size: l.size ?? null,
        sizeApprox: Boolean(l.sizeApprox),
        thumbnail: l.thumbnail ?? null,
        thumbKey: l.thumbKey ?? null,
        downloaded: 0,
        error: null,
        retries: 0,
        retryAt: null,
        headers: l.headers,
        checksum: l.checksum,
        addedAt: now,
        finishedAt: null,
      });
    }
    this.#packages.push(pkg);
    for (const link of pkg.links) this.#links.set(link.id, link);
    this.#store.scheduleSave();
    this.emit('added', pkg);
    return pkg;
  }

  /** Change fields of a link. */
  updateLink(id, patch) {
    const link = this.#links.get(id);
    if (!link) return null;
    Object.assign(link, patch);
    this.#store.scheduleSave();
    this.emit('changed', link);
    return link;
  }

  updatePackage(id, patch) {
    const pkg = this.getPackage(id);
    if (!pkg) return null;
    const { links: _ignored, id: _id, ...rest } = patch;
    Object.assign(pkg, rest);
    this.#store.scheduleSave();
    this.emit('reordered');
    return pkg;
  }

  /** Remove links; empty packages are removed too. Returns the removed links. */
  removeLinks(ids) {
    const set = new Set(ids);
    const removed = [];
    for (const pkg of this.#packages) {
      pkg.links = pkg.links.filter((l) => {
        if (!set.has(l.id)) return true;
        removed.push(l);
        this.#links.delete(l.id);
        return false;
      });
    }
    this.#packages = this.#packages.filter((p) => p.links.length > 0);
    if (removed.length) {
      this.#store.scheduleSave();
      this.emit('removed', removed.map((l) => l.id));
    }
    return removed;
  }

  /** Move a package to a new position in the list. */
  movePackage(id, index) {
    const from = this.#packages.findIndex((p) => p.id === id);
    if (from < 0) return;
    const [pkg] = this.#packages.splice(from, 1);
    this.#packages.splice(Math.max(0, Math.min(index, this.#packages.length)), 0, pkg);
    this.#store.scheduleSave();
    this.emit('reordered');
  }

  /** Move links into a package (possibly the same one) at a position. */
  moveLinks(ids, packageId, index) {
    const target = this.getPackage(packageId);
    if (!target) return;
    const set = new Set(ids);
    const moving = [];
    for (const pkg of this.#packages) {
      pkg.links = pkg.links.filter((l) => {
        if (!set.has(l.id)) return true;
        moving.push(l);
        return false;
      });
    }
    for (const l of moving) l.packageId = target.id;
    target.links.splice(Math.max(0, Math.min(index, target.links.length)), 0, ...moving);
    this.#packages = this.#packages.filter((p) => p.links.length > 0);
    this.#store.scheduleSave();
    this.emit('reordered');
  }
}

export function guessPackageName(links) {
  const first = links[0] && (links[0].name || links[0].displayName || fileNameFromUrl(links[0].url));
  if (!first) return null;
  // "movie.part1.rar" / "movie.7z.001" / "movie.mp4" -> "movie"
  return first.replace(/(\.part\d+)?(\.[a-z0-9]{1,5})+$/i, '') || first;
}
