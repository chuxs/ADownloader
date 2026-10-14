import { Browser } from './Browser.js';
import directHttp from './builtin/directhttp.js';
import fileHosts from './builtin/filehosts.js';
import genericPage from './builtin/genericpage.js';
import { createHlsPlugin } from './builtin/hls.js';
import { createYtDlpPlugin } from './builtin/ytdlp.js';

/**
 * A plugin teaches ADownloader about one website (or a kind of link).
 *
 * @typedef {object} Plugin
 * @property {string} id         unique, e.g. "example.com"
 * @property {string} name       shown to the user
 * @property {'host'|'crawler'} type
 *   host: links that point at one downloadable file (e.g. a file-host page)
 *   crawler: links that lead to more links (folders, playlists, link protectors)
 * @property {RegExp[]} patterns URLs this plugin handles. Empty = fallback plugin.
 *
 * @property {(url: string, ctx: PluginContext) => Promise<CrawlResult[]>} [crawl]
 *   crawler: return the links found behind `url`.
 * @property {(link: PluginLink, ctx: PluginContext) => Promise<CheckResult>} [check]
 *   host: is the file online, and what is its name/size? Runs in the link grabber.
 * @property {(link: PluginLink, ctx: PluginContext) => Promise<ResolveResult>} [resolve]
 *   host: return the direct file URL. Runs right before each download starts,
 *   because direct URLs from file hosts usually expire.
 * @property {(link: PluginLink, opts: object) => object} [createDownload]
 *   host: download with something other than the HTTP engine (HLS streams, yt-dlp).
 *   Returns an object with the same interface as engine/Download.js.
 *
 * @typedef {object} CrawlResult
 * @property {string} url
 * @property {string} [name]
 * @property {number} [size]
 * @property {boolean} [sizeApprox] size is an estimate (e.g. bitrate x duration)
 * @property {string} [packageName]
 * @property {string} [thumbnail] preview image URL
 * @property {string} [pluginId]  set to skip matching and hand the link to this host plugin
 * @property {boolean} [checked]  name/size are already known, skip the online check
 * @property {Record<string,string>} [headers]
 * @property {object} [data]      plugin-private data saved with the link
 *
 * @typedef {{url: string, name?: string, size?: number|null, headers?: Record<string,string>, data?: object}} PluginLink
 * @typedef {{available: boolean, name?: string, size?: number|null, sizeApprox?: boolean, thumbnail?: string, error?: string}} CheckResult
 * @typedef {{url: string, name?: string, headers?: Record<string,string>, type?: 'hls'}} ResolveResult
 *   type 'hls': the URL is a stream playlist, downloaded by the HLS plugin
 * @typedef {{http: Browser, signal: AbortSignal|undefined, log: (...args: unknown[]) => void}} PluginContext
 */

export class PluginRegistry {
  /** @type {Map<string, Plugin>} */
  #plugins = new Map();

  /**
   * Registry with the built-in plugins.
   * @param {import('../tools/Tools.js').Tools} [tools] enables yt-dlp video sites and ffmpeg for streams
   */
  static withBuiltins(tools = null) {
    const r = new PluginRegistry();
    for (const p of fileHosts) r.register(p);
    r.register(createHlsPlugin(tools ?? { ffmpeg: null }));
    r.register(createYtDlpPlugin(tools ?? { ytdlp: null, ffmpeg: null }));
    r.register(directHttp);
    r.register(genericPage);
    return r;
  }

  /** @param {Plugin} plugin */
  register(plugin) {
    if (!plugin?.id || !plugin.name) throw new TypeError('plugin needs an id and a name');
    if (plugin.type !== 'host' && plugin.type !== 'crawler') throw new TypeError(`${plugin.id}: bad type`);
    if (!Array.isArray(plugin.patterns)) throw new TypeError(`${plugin.id}: patterns must be an array`);
    if (plugin.type === 'crawler' && typeof plugin.crawl !== 'function') {
      throw new TypeError(`${plugin.id}: crawler plugins need crawl()`);
    }
    this.#plugins.set(plugin.id, plugin);
  }

  get(id) {
    return this.#plugins.get(id) ?? null;
  }

  list() {
    return [...this.#plugins.values()];
  }

  /** The site-specific plugin for a URL, or null if none matches. */
  match(url) {
    for (const p of this.#plugins.values()) {
      if (p.patterns.some((re) => re.test(url))) return p;
    }
    return null;
  }

  /** @returns {PluginContext} */
  static context(signal, log = () => {}) {
    return { http: new Browser({ signal }), signal, log };
  }
}
