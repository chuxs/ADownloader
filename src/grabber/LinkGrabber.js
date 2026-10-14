import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { toDownloadError } from '../engine/errors.js';
import { JsonStore } from '../core/JsonStore.js';
import { guessPackageName } from '../core/DownloadList.js';
import { PluginRegistry } from '../plugins/PluginRegistry.js';
import { extractUrlsFromText } from '../plugins/html.js';
import { LinkCrawler } from './LinkCrawler.js';

/**
 * @typedef {import('./LinkCrawler.js').CrawledLink & {id: string, packageId: string}} GrabbedLink
 * @typedef {{id: string, name: string, directory: string, links: GrabbedLink[]}} GrabbedPackage
 */

/**
 * The link grabber: links the user added wait here while they are crawled and
 * checked, grouped into packages. The user reviews them, then confirms them
 * into the download list.
 *
 * Events: 'changed' (whenever packages/links change), 'busy' (bool).
 */
export class LinkGrabber extends EventEmitter {
  #registry;
  #list;
  #crawler;
  #defaultDirectory;
  #checkConcurrency;
  /** @type {GrabbedPackage[]} */
  #packages = [];
  /** @type {GrabbedLink[]} */
  #checkQueue = [];
  #checking = 0;
  #crawling = 0;
  #store;
  #controller = new AbortController();

  /**
   * @param {object} opts
   * @param {PluginRegistry} opts.registry
   * @param {import('../core/DownloadList.js').DownloadList} opts.list
   * @param {string} opts.defaultDirectory
   * @param {string} [opts.file] save the grabber contents here
   * @param {number} [opts.checkConcurrency]
   */
  constructor({ registry, list, defaultDirectory, file, checkConcurrency = 8 }) {
    super();
    this.#registry = registry;
    this.#list = list;
    this.#crawler = new LinkCrawler(registry);
    this.#defaultDirectory = defaultDirectory;
    this.#checkConcurrency = checkConcurrency;
    this.#store = file ? new JsonStore(file, () => ({ version: 1, packages: this.#packages })) : null;
  }

  async load() {
    const data = await this.#store?.load();
    this.#packages = data?.packages ?? [];
    for (const pkg of this.#packages) {
      for (const link of pkg.links) if (link.status === 'checking') this.#enqueueCheck(link, true);
    }
    this.#changed();
  }

  save() {
    return this.#store?.save();
  }

  get packages() {
    return this.#packages;
  }

  set defaultDirectory(dir) {
    this.#defaultDirectory = dir;
  }

  /** All links, in display order. */
  *links() {
    for (const pkg of this.#packages) yield* pkg.links;
  }

  updateLink(id, patch) {
    for (const link of this.links()) {
      if (link.id === id) {
        Object.assign(link, patch);
        this.#changed();
        return link;
      }
    }
    return null;
  }

  /** True while links are being crawled or checked. */
  get busy() {
    return this.#crawling > 0 || this.#checking > 0 || this.#checkQueue.length > 0;
  }

  /**
   * Add every URL found in `text`. Resolves when crawling is done; online
   * checks of host-plugin links may still be running (see `busy`).
   * @param {string} text
   * @param {{directory?: string, packageName?: string}} [opts]
   * @returns {Promise<number>} number of links added
   */
  async add(text, { directory, packageName } = {}) {
    const urls = extractUrlsFromText(text);
    if (urls.length === 0) return 0;
    const dir = path.resolve(directory ?? this.#defaultDirectory);
    let count = 0;
    this.#setCrawling(+1);
    try {
      await this.#crawler.crawl(urls, {
        signal: this.#controller.signal,
        packageName,
        onLink: (link) => {
          count++;
          this.#addLink(link, dir);
        },
      });
    } finally {
      this.#setCrawling(-1);
    }
    return count;
  }

  /**
   * Move links into the download list. Offline links are left behind.
   * @param {{packageIds?: string[], linkIds?: string[]}} [which] default: everything
   * @returns {import('../core/DownloadList.js').Package[]} the new download-list packages
   */
  confirm({ packageIds, linkIds } = {}) {
    const all = !packageIds && !linkIds;
    const pkgSet = new Set(packageIds);
    const linkSet = new Set(linkIds);
    const created = [];
    const moved = [];

    for (const pkg of this.#packages) {
      const links = pkg.links.filter(
        (l) => l.status !== 'offline' && (all || pkgSet.has(pkg.id) || linkSet.has(l.id)),
      );
      if (links.length === 0) continue;
      created.push(
        this.#list.addPackage({
          name: pkg.name,
          directory: pkg.directory,
          links: links.map((l) => ({
            url: l.url,
            displayName: l.name ?? undefined,
            size: l.size,
            sizeApprox: l.sizeApprox,
            thumbnail: l.thumbnail,
            thumbKey: l.thumbKey,
            pluginId: l.pluginId,
            headers: l.headers,
            data: l.data,
          })),
        }),
      );
      moved.push(...links.map((l) => l.id));
    }
    this.remove(moved);
    return created;
  }

  /** Remove links (and packages left empty). */
  remove(linkIds) {
    const set = new Set(linkIds);
    for (const pkg of this.#packages) pkg.links = pkg.links.filter((l) => !set.has(l.id));
    this.#checkQueue = this.#checkQueue.filter((l) => !set.has(l.id));
    this.#packages = this.#packages.filter((p) => p.links.length > 0);
    this.#changed();
  }

  removePackages(packageIds) {
    const set = new Set(packageIds);
    this.remove(this.#packages.filter((p) => set.has(p.id)).flatMap((p) => p.links.map((l) => l.id)));
  }

  clear() {
    this.remove(this.#packages.flatMap((p) => p.links.map((l) => l.id)));
  }

  updatePackage(id, { name, directory }) {
    const pkg = this.#packages.find((p) => p.id === id);
    if (!pkg) return;
    if (name) pkg.name = name;
    if (directory) pkg.directory = path.resolve(directory);
    this.#changed();
  }

  /** Stop crawling and checking. */
  abort() {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#checkQueue = [];
  }

  // ---------------------------------------------------------------- internals

  #addLink(crawled, directory) {
    const name = crawled.packageName ?? guessPackageName([{ name: crawled.name, url: crawled.url }]) ?? 'Various';
    let pkg = this.#packages.find((p) => p.name === name && p.directory === directory);
    if (!pkg) {
      pkg = { id: randomUUID(), name, directory, links: [] };
      this.#packages.push(pkg);
    }
    /** @type {GrabbedLink} */
    const link = { ...crawled, id: randomUUID(), packageId: pkg.id };
    pkg.links.push(link);
    if (link.status === 'unchecked') this.#enqueueCheck(link);
    this.#changed();
  }

  #enqueueCheck(link, front = false) {
    const plugin = this.#registry.get(link.pluginId);
    if (!plugin?.check) return; // can't be checked; stays "unchecked" but is downloadable
    link.status = 'checking';
    if (front) this.#checkQueue.unshift(link);
    else this.#checkQueue.push(link);
    this.#pumpChecks();
  }

  #pumpChecks() {
    while (this.#checking < this.#checkConcurrency && this.#checkQueue.length) {
      const link = this.#checkQueue.shift();
      this.#checking++;
      this.#check(link).finally(() => {
        this.#checking--;
        this.#pumpChecks();
        if (!this.busy) this.emit('busy', false);
      });
    }
  }

  async #check(link) {
    const plugin = this.#registry.get(link.pluginId);
    const ctx = PluginRegistry.context(this.#controller.signal);
    try {
      const r = await plugin.check(link, ctx);
      if (r.available && r.variants?.length) {
        this.#replaceWithVariants(link, r);
        return;
      }
      link.status = r.available ? 'online' : 'offline';
      link.error = r.available ? null : (r.error ?? 'File not found');
      if (r.name) link.name = r.name;
      if (r.thumbnail && !link.thumbnail) link.thumbnail = r.thumbnail;
      if (r.size != null) {
        link.size = r.size;
        link.sizeApprox = Boolean(r.sizeApprox);
      }
    } catch (err) {
      const e = toDownloadError(err);
      // A failed check is not proof the file is gone; only OFFLINE says so.
      link.status = e.code === 'OFFLINE' ? 'offline' : 'unchecked';
      link.error = e.message;
    }
    this.#changed();
  }

  /** One link becomes several (e.g. one per video quality), in the same place. */
  #replaceWithVariants(link, result) {
    const pkg = this.#packages.find((p) => p.id === link.packageId);
    if (!pkg) return;
    const index = pkg.links.indexOf(link);
    if (index < 0) return; // removed while being checked
    const variants = result.variants.map((v) => ({
      ...link,
      id: randomUUID(),
      url: v.url ?? link.url,
      name: v.name ?? link.name,
      size: v.size ?? null,
      sizeApprox: Boolean(v.sizeApprox),
      data: v.data,
      thumbnail: link.thumbnail ?? v.thumbnail ?? result.thumbnail ?? null,
      thumbKey: link.thumbKey ?? null,
      status: 'online',
      error: null,
    }));
    pkg.links.splice(index, 1, ...variants);
    this.#changed();
  }

  #setCrawling(delta) {
    const wasBusy = this.busy;
    this.#crawling += delta;
    if (wasBusy !== this.busy) this.emit('busy', this.busy);
  }

  #changed() {
    this.#store?.scheduleSave();
    this.emit('changed');
  }
}
