import { toDownloadError } from '../engine/errors.js';
import { PluginRegistry } from '../plugins/PluginRegistry.js';
import { probeUrl } from '../plugins/builtin/directhttp.js';
import { findFilesInPage } from '../plugins/builtin/genericpage.js';

/**
 * A link found by the crawler, before it goes into the download list.
 * @typedef {object} CrawledLink
 * @property {string} url
 * @property {string} pluginId     host plugin that will download it
 * @property {string|null} name
 * @property {number|null} size
 * @property {boolean} [sizeApprox]  size is an estimate
 * @property {'unchecked'|'online'|'offline'} status
 * @property {string|null} error
 * @property {string|null} packageName
 * @property {string} source       the URL the user added that led here
 * @property {string|null} [thumbnail] preview image URL
 * @property {Record<string,string>} [headers]
 * @property {object} [data]
 */

/**
 * Turns URLs into downloadable links:
 * - URLs a host plugin handles become links for that plugin.
 * - URLs a crawler plugin handles are expanded, and the results crawled again.
 * - Other URLs are checked directly: files become direct links; web pages
 *   are searched for files.
 */
export class LinkCrawler {
  #registry;
  #maxDepth;
  #concurrency;

  /**
   * @param {PluginRegistry} registry
   * @param {{maxDepth?: number, concurrency?: number}} [opts]
   */
  constructor(registry, { maxDepth = 3, concurrency = 6 } = {}) {
    this.#registry = registry;
    this.#maxDepth = maxDepth;
    this.#concurrency = concurrency;
  }

  /**
   * @param {string[]} urls
   * @param {{onLink: (link: CrawledLink) => void, signal?: AbortSignal, packageName?: string}} opts
   * @returns {Promise<void>} resolves when everything reachable has been crawled
   */
  async crawl(urls, { onLink, signal, packageName }) {
    const seen = new Set();
    /** @type {Array<{url: string, depth: number, source: string, packageName?: string, name?: string, size?: number, headers?: object}>} */
    const queue = [];
    const enqueue = (item) => {
      if (seen.has(item.url)) return;
      seen.add(item.url);
      queue.push(item);
    };
    for (const url of urls) enqueue({ url, depth: 0, source: url, packageName });

    const ctx = PluginRegistry.context(signal);
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (signal?.aborted) return;
        await this.#process(item, ctx, enqueue, onLink);
      }
    };
    // Workers exit when the queue is momentarily empty while others may still add
    // to it, so keep going until no worker finds anything left.
    while (queue.length && !signal?.aborted) {
      await Promise.all(Array.from({ length: this.#concurrency }, worker));
    }
  }

  async #process(item, ctx, enqueue, onLink) {
    const emit = (fields) =>
      onLink({
        url: item.url,
        name: item.name ?? null,
        size: item.size ?? null,
        status: 'unchecked',
        error: null,
        packageName: item.packageName ?? null,
        source: item.source,
        headers: item.headers,
        thumbnail: item.thumbnail ?? null,
        ...fields,
      });

    const plugin = this.#registry.match(item.url);
    try {
      if (plugin?.type === 'host') {
        emit({ pluginId: plugin.id, data: item.data });
        return;
      }

      if (plugin?.type === 'crawler') {
        if (item.depth >= this.#maxDepth) return;
        const results = await plugin.crawl(item.url, ctx);
        if (results.length === 0) {
          emit({ pluginId: 'directhttp', status: 'offline', error: 'Nothing found at this link' });
        }
        for (const r of results) this.#follow(r, item, enqueue, onLink);
        return;
      }

      // No plugin: find out what the URL is.
      const info = await probeUrl(item.url, { signal: ctx.signal, headers: item.headers }).catch((err) => {
        if (ctx.signal?.aborted) throw err;
        return { available: false, isPage: true, status: toDownloadError(err).message };
      });
      if (info.available && !info.isPage) {
        emit({ pluginId: 'directhttp', status: 'online', name: info.name ?? item.name ?? null, size: info.size });
        return;
      }

      // A web page (or a site that refused us): ask yt-dlp whether it has video on it.
      const video = this.#registry.get('ytdlp');
      if (video?.available?.() && item.depth < this.#maxDepth) {
        try {
          const results = await video.crawl(item.url, ctx);
          if (results.length) {
            for (const r of results) this.#follow(r, item, enqueue, onLink);
            return;
          }
        } catch (err) {
          if (ctx.signal?.aborted) return;
          const e = toDownloadError(err);
          if (e.code !== 'UNSUPPORTED') {
            emit({ pluginId: 'ytdlp', status: 'offline', error: e.message });
            return;
          }
        }
      }

      if (!info.available) {
        const status = typeof info.status === 'number' ? `Server responded ${info.status}` : info.status;
        emit({ pluginId: 'directhttp', status: 'offline', error: status });
        return;
      }
      const results = item.depth < this.#maxDepth ? findFilesInPage(await ctx.http.get(item.url)) : [];
      if (results.length === 0) {
        emit({
          pluginId: 'directhttp',
          status: 'offline',
          error: video?.available?.()
            ? 'No downloadable files or videos found on this page.'
            : 'No downloadable files found. For video sites, install yt-dlp in Settings.',
        });
      }
      for (const r of results) this.#follow(r, item, enqueue, onLink);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      const e = toDownloadError(err);
      emit({ pluginId: plugin?.type === 'host' ? plugin.id : 'directhttp', status: 'offline', error: e.message });
    }
  }

  /** Handle one result of a crawler plugin or page search. */
  #follow(result, parent, enqueue, onLink) {
    const packageName = result.packageName ?? parent.packageName;
    if (result.pluginId) {
      onLink({
        url: result.url,
        pluginId: result.pluginId,
        name: result.name ?? null,
        size: result.size ?? null,
        sizeApprox: Boolean(result.sizeApprox),
        status: result.checked ? 'online' : 'unchecked',
        error: null,
        packageName: packageName ?? null,
        source: parent.source,
        headers: result.headers,
        data: result.data,
        thumbnail: result.thumbnail ?? null,
      });
      return;
    }
    enqueue({
      url: result.url,
      depth: parent.depth + 1,
      source: parent.source,
      packageName,
      name: result.name,
      size: result.size,
      headers: result.headers,
      data: result.data,
      thumbnail: result.thumbnail,
    });
  }
}
