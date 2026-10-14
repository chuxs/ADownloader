import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { Download, DownloadState } from '../engine/Download.js';
import { toDownloadError } from '../engine/errors.js';
import { SpeedLimiter } from '../engine/SpeedLimiter.js';
import { PluginRegistry } from '../plugins/PluginRegistry.js';
import { LinkState } from './DownloadList.js';

export const DEFAULT_SETTINGS = Object.freeze({
  /** downloads running at the same time */
  maxConcurrent: 3,
  /** per host name; 0 = no limit */
  maxPerHost: 0,
  /** connections per download */
  connections: 8,
  /** bytes/second for all downloads together; 0 = unlimited */
  speedLimit: 0,
  /** automatic retries after a temporary failure (server down, network lost) */
  autoRetries: 3,
  autoRetryDelayMs: 60_000,
});

/**
 * Runs the download list: starts queued links in order, respecting the
 * concurrency, per-host and speed limits, and records the results.
 *
 * Events: 'running' (bool), 'progress' (linkId, live info), 'notice' (message for the user).
 */
export class Scheduler extends EventEmitter {
  #list;
  #settings;
  #limiter;
  #plugins;
  #folders;
  #running = false;
  /** @type {Map<string, Task>} */
  #active = new Map();
  /** links started with "force start": ignore limits and the running flag */
  #forced = new Set();
  /** what a link becomes after we stop its download: QUEUED, PAUSED, or 'removed' */
  #stopIntent = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  #retryTimers = new Map();
  /** @type {Map<string, object>} latest live info (speed, eta, connections) per active link */
  #live = new Map();

  /**
   * @param {import('./DownloadList.js').DownloadList} list
   * @param {Partial<typeof DEFAULT_SETTINGS>} [settings]
   * @param {object} [opts]
   * @param {import('../plugins/PluginRegistry.js').PluginRegistry} [opts.plugins] resolves site links to file URLs
   * @param {import('./FolderSplitter.js').FolderSplitter} [opts.folders] spreads videos over numbered folders
   * @param {object} [opts.engine] extra options passed to every Download (tests use this)
   */
  constructor(list, settings = {}, { plugins = null, folders = null, engine = {} } = {}) {
    super();
    this.#list = list;
    this.#settings = { ...DEFAULT_SETTINGS, ...settings };
    this.#limiter = new SpeedLimiter(this.#settings.speedLimit);
    this.#plugins = plugins;
    this.#folders = folders;
    this.engineOptions = engine;
    list.on('added', () => this.#fill());
  }

  get running() {
    return this.#running;
  }

  get settings() {
    return { ...this.#settings };
  }

  /** Ids of links downloading right now. */
  get activeIds() {
    return [...this.#active.keys()];
  }

  /** Total speed of all downloads, bytes/second. */
  get speed() {
    let sum = 0;
    for (const info of this.#live.values()) sum += info.speed;
    return sum;
  }

  /** Live details (speed, eta, connections) for a downloading link. */
  liveInfo(linkId) {
    return this.#live.get(linkId) ?? null;
  }

  setSettings(patch) {
    Object.assign(this.#settings, patch);
    if ('speedLimit' in patch) this.#limiter.rate = this.#settings.speedLimit;
    this.#fill();
  }

  /** Start working through the list. */
  start() {
    if (this.#running) return;
    this.#folders?.resetDecline();
    this.#running = true;
    this.emit('running', true);
    this.#fill();
  }

  /** Stop all downloads; they stay queued and resume on the next start(). */
  async stop() {
    this.#running = false;
    this.#forced.clear();
    this.emit('running', false);
    await Promise.all([...this.#active.keys()].map((id) => this.#stopDownload(id, LinkState.QUEUED)));
  }

  /** Start these links now, even if the scheduler is stopped or full. */
  forceStart(ids) {
    for (const id of ids) {
      const link = this.#list.getLink(id);
      if (!link || link.state === LinkState.COMPLETED || this.#active.has(id)) continue;
      this.#requeue(link);
      this.#forced.add(id);
    }
    this.#fill();
  }

  /** Put paused/failed links back in the queue. */
  resume(ids) {
    for (const id of ids) {
      const link = this.#list.getLink(id);
      if (link && link.state !== LinkState.COMPLETED && !this.#active.has(id)) this.#requeue(link);
    }
    this.#fill();
  }

  /** Pause links; paused links are skipped until resumed. */
  async pause(ids) {
    await Promise.all(
      ids.map(async (id) => {
        this.#forced.delete(id);
        this.#clearRetry(id);
        if (this.#active.has(id)) return this.#stopDownload(id, LinkState.PAUSED);
        const link = this.#list.getLink(id);
        if (link && link.state !== LinkState.COMPLETED) this.#list.updateLink(id, { state: LinkState.PAUSED });
      }),
    );
  }

  /** Enable or disable links; disabled links are skipped. */
  async setEnabled(ids, enabled) {
    if (!enabled) await this.pause(ids.filter((id) => this.#active.has(id)));
    for (const id of ids) this.#list.updateLink(id, { enabled });
    this.#fill();
  }

  /** Delete the file or partial progress and download these links again from the start. */
  async reset(ids) {
    for (const id of ids) {
      this.#clearRetry(id);
      if (this.#active.has(id)) await this.#stopDownload(id, LinkState.QUEUED);
      const link = this.#list.getLink(id);
      if (!link) continue;
      if (link.filePath) {
        if (link.state === LinkState.COMPLETED) await rm(link.filePath, { force: true });
        else await deletePartFiles(link.filePath);
      }
      this.#list.updateLink(id, {
        state: LinkState.QUEUED,
        filePath: null,
        size: null,
        downloaded: 0,
        error: null,
        retries: 0,
        retryAt: null,
        finishedAt: null,
      });
    }
    this.#fill();
  }

  /**
   * Remove links from the list. Unfinished partial files are always deleted;
   * finished files only with deleteFiles.
   */
  async remove(ids, { deleteFiles = false } = {}) {
    for (const id of ids) {
      this.#forced.delete(id);
      this.#clearRetry(id);
      if (this.#active.has(id)) await this.#stopDownload(id, 'removed');
    }
    const removed = this.#list.removeLinks(ids);
    for (const link of removed) {
      if (!link.filePath) continue;
      if (link.state === LinkState.COMPLETED) {
        if (deleteFiles) await rm(link.filePath, { force: true });
      } else {
        await deletePartFiles(link.filePath);
      }
    }
    this.#fill();
  }

  /** Stop everything and save the list. */
  async close() {
    await this.stop();
    for (const id of [...this.#retryTimers.keys()]) this.#clearRetry(id);
    await this.#list.save();
  }

  // ---------------------------------------------------------------- internals

  #requeue(link) {
    this.#clearRetry(link.id);
    this.#list.updateLink(link.id, {
      state: LinkState.QUEUED,
      enabled: true,
      error: null,
      retries: 0,
      retryAt: null,
    });
  }

  /** Start as many queued links as the limits allow. */
  #fill() {
    // Forced links first, ignoring every limit.
    for (const id of this.#forced) {
      const link = this.#list.getLink(id);
      if (link?.state === LinkState.QUEUED && !this.#active.has(id)) this.#launch(link);
    }
    if (!this.#running) return;

    const { maxConcurrent, maxPerHost } = this.#settings;
    const perHost = new Map();
    for (const id of this.#active.keys()) {
      const host = hostOf(this.#list.getLink(id)?.url);
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
    }

    for (const link of this.#candidates()) {
      if (this.#active.size >= maxConcurrent) break;
      const host = hostOf(link.url);
      if (maxPerHost > 0 && (perHost.get(host) ?? 0) >= maxPerHost) continue;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      this.#launch(link);
    }
  }

  /** Queued, enabled links: highest priority first, otherwise list order. */
  #candidates() {
    const out = [];
    let order = 0;
    for (const pkg of this.#list.packages) {
      for (const link of pkg.links) {
        if (link.state === LinkState.QUEUED && link.enabled && !this.#active.has(link.id)) {
          out.push({ link, prio: Math.max(link.priority, pkg.priority), order: order++ });
        }
      }
    }
    out.sort((a, b) => b.prio - a.prio || a.order - b.order);
    return out.map((c) => c.link);
  }

  #launch(link) {
    /** @type {Task} */
    const task = { controller: new AbortController(), download: null, error: null, done: null };
    this.#active.set(link.id, task);
    this.#list.updateLink(link.id, { state: LinkState.DOWNLOADING, error: null, retryAt: null });
    task.done = this.#runTask(link, task).then((final) => this.#onFinished(link.id, task, final));
  }

  /** Ask the plugin for the file URL, then download it. Resolves with a DownloadState. */
  async #runTask(link, task) {
    const signal = task.controller.signal;
    let source = { url: link.url, headers: link.headers, name: undefined };

    const pluginLink = { url: link.url, name: link.name, size: link.size, headers: link.headers, data: link.data };
    let plugin = this.#plugins?.get(link.pluginId);
    if (plugin?.resolve) {
      try {
        const ctx = PluginRegistry.context(signal);
        const r = await plugin.resolve(pluginLink, ctx);
        source = { url: r.url, headers: { ...link.headers, ...r.headers }, name: r.name };
        // A file host may hand out a stream instead of a file.
        if (r.type === 'hls') plugin = this.#plugins.get('hls');
      } catch (err) {
        if (signal.aborted) return DownloadState.PAUSED;
        task.error = toDownloadError(err);
        return DownloadState.FAILED;
      }
    }
    if (signal.aborted) return DownloadState.PAUSED;

    const pkg = this.#list.getPackage(link.packageId);
    let directory = pkg.directory;
    if (!link.filePath && this.#folders?.appliesTo(link, pkg)) {
      directory = await this.#folders.allocate(link.id);
      if (directory === null) {
        // The user didn't want another folder: keep the link queued and start
        // nothing new until "Start all".
        this.#stopIntent.set(link.id, LinkState.QUEUED);
        if (this.#running) {
          this.#running = false;
          this.emit('running', false);
          this.emit('notice', 'Downloads stopped: the video folder is full. Press "Start all" to continue in a new folder.');
        }
        return DownloadState.PAUSED;
      }
      if (signal.aborted) return DownloadState.PAUSED;
    }

    const options = {
      ...this.engineOptions,
      ...(link.filePath
        ? { filePath: link.filePath }
        : { directory, fileName: link.customName ?? source.name }),
      connections: this.#settings.connections,
      limiters: [this.#limiter],
    };
    let dl;
    try {
      dl = plugin?.createDownload
        ? plugin.createDownload({ ...pluginLink, url: source.url, headers: source.headers }, options)
        : new Download({ ...options, url: source.url, headers: source.headers, checksum: link.checksum });
    } catch (err) {
      task.error = toDownloadError(err);
      return DownloadState.FAILED;
    }
    task.download = dl;

    dl.on('progress', (info) => {
      this.#live.set(link.id, { speed: info.speed, eta: info.eta, connections: info.connections, phase: info.phase ?? null });
      const patch = { downloaded: info.downloaded };
      // Keep the size from the link check until the downloader knows one.
      if (info.size != null) patch.size = info.size;
      // The HTTP engine's size comes from the server: exact.
      if (dl instanceof Download && info.size != null) patch.sizeApprox = false;
      if (info.filePath && info.filePath !== link.filePath) {
        patch.filePath = info.filePath;
        patch.name = path.basename(info.filePath);
      }
      this.#list.updateLink(link.id, patch);
      this.emit('progress', link.id, this.#live.get(link.id));
    });

    const final = await dl.start();
    task.error = dl.error;
    return final;
  }

  #onFinished(id, task, final) {
    this.#folders?.release(id); // before #fill(), so a finished video isn't counted twice
    this.#active.delete(id);
    this.#live.delete(id);
    this.#forced.delete(id);
    const intent = this.#stopIntent.get(id);
    this.#stopIntent.delete(id);
    const link = this.#list.getLink(id);

    if (link && intent !== 'removed') {
      if (final === DownloadState.COMPLETED) {
        const exact = task.download?.info.size;
        this.#list.updateLink(id, {
          state: LinkState.COMPLETED,
          finishedAt: Date.now(),
          error: null,
          sizeApprox: false,
          ...(exact != null ? { size: exact, downloaded: exact } : {}),
        });
      } else if (final === DownloadState.PAUSED) {
        this.#list.updateLink(id, { state: intent ?? LinkState.PAUSED });
      } else if (final === DownloadState.FAILED) {
        this.#handleFailure(link, task.error);
      }
    }
    this.#fill();
  }

  #handleFailure(link, error) {
    const err = { code: error?.code ?? 'UNKNOWN', message: error?.message ?? 'Unknown error' };
    const { autoRetries, autoRetryDelayMs } = this.#settings;
    if (error?.retryable && link.retries < autoRetries) {
      const retryAt = Date.now() + autoRetryDelayMs;
      this.#list.updateLink(link.id, { state: LinkState.WAITING, error: err, retries: link.retries + 1, retryAt });
      const timer = setTimeout(() => {
        this.#retryTimers.delete(link.id);
        if (this.#list.getLink(link.id)?.state === LinkState.WAITING) {
          this.#list.updateLink(link.id, { state: LinkState.QUEUED, retryAt: null });
          this.#fill();
        }
      }, autoRetryDelayMs);
      timer.unref?.();
      this.#retryTimers.set(link.id, timer);
    } else {
      this.#list.updateLink(link.id, { state: LinkState.FAILED, error: err });
    }
  }

  async #stopDownload(id, intent) {
    const task = this.#active.get(id);
    if (!task) return;
    this.#stopIntent.set(id, intent);
    task.controller.abort(); // stops a plugin that is still resolving
    if (task.download) {
      if (intent === 'removed') await task.download.cancel({ deleteFile: false });
      else await task.download.pause();
    }
    await task.done; // #onFinished has run once this resolves
  }

  #clearRetry(id) {
    clearTimeout(this.#retryTimers.get(id));
    this.#retryTimers.delete(id);
  }
}

/**
 * @typedef {object} Task  one running link
 * @property {AbortController} controller
 * @property {Download|null} download  null while the plugin is still resolving
 * @property {import('../engine/errors.js').DownloadError|null} error
 * @property {Promise<void>|null} done
 */

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function deletePartFiles(filePath) {
  await rm(`${filePath}.part`, { force: true });
  await rm(`${filePath}.part.json`, { force: true });
}
