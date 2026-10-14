import { rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { LinkState } from '../core/DownloadList.js';
import { groupArchives } from './archives.js';
import { extractArchive } from './extract.js';

export const DEFAULT_EXTRACTION_SETTINGS = Object.freeze({
  autoExtract: true,
  /** extract into a folder named after the archive */
  extractToSubfolder: true,
  deleteArchivesAfterExtract: false,
  /** one password per line, tried in order */
  archivePasswords: '',
});

/**
 * Extracts archives once all their parts have finished downloading, one at a
 * time. Progress and results are stored on the link of the archive's first
 * part as `extraction: {state, progress, error, destination}`.
 */
export class ExtractionManager {
  #list;
  #tools;
  #settings;
  #queue = [];
  #busy = false;
  #controller = new AbortController();

  /**
   * @param {import('../core/DownloadList.js').DownloadList} list
   * @param {{sevenZip: string|null, tar: string|null}} tools
   * @param {Partial<typeof DEFAULT_EXTRACTION_SETTINGS>} [settings]
   */
  constructor(list, tools, settings = {}) {
    this.#list = list;
    this.#tools = tools;
    this.#settings = { ...DEFAULT_EXTRACTION_SETTINGS, ...settings };
    list.on('changed', (link) => {
      if (link.state === LinkState.COMPLETED && !link.extraction && this.#settings.autoExtract) this.#scan(link.packageId);
    });
    // Extractions interrupted by closing the app start over.
    const interrupted = [...list.links()].filter((l) => ['queued', 'running'].includes(l.extraction?.state));
    for (const link of interrupted) list.updateLink(link.id, { extraction: undefined });
    if (interrupted.length) this.extractNow(interrupted.map((l) => l.id));
  }

  setSettings(patch) {
    Object.assign(this.#settings, patch);
  }

  /** Extract (again) the archives these links belong to, even with auto-extract off. */
  extractNow(linkIds) {
    const pkgIds = new Set(linkIds.map((id) => this.#list.getLink(id)?.packageId).filter(Boolean));
    for (const pkgId of pkgIds) this.#scan(pkgId, new Set(linkIds));
  }

  /** Wait for the queue to empty (used by tests and on shutdown). */
  async idle() {
    while (this.#busy || this.#queue.length) await new Promise((r) => setTimeout(r, 20));
  }

  stop() {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#queue = [];
  }

  /** Queue every archive in the package whose parts have all finished. */
  #scan(packageId, onlyLinks = null) {
    const pkg = this.#list.getPackage(packageId);
    if (!pkg) return;
    for (const archive of groupArchives(pkg.links)) {
      const first = archive.first;
      if (!first) continue;
      if (onlyLinks && !archive.parts.some((l) => onlyLinks.has(l.id))) continue;
      if (!archive.parts.every((l) => l.state === LinkState.COMPLETED && l.filePath)) continue;
      const st = first.extraction?.state;
      if (!onlyLinks && st) continue; // already queued, running or done
      if (st === 'queued' || st === 'running') continue;
      this.#list.updateLink(first.id, { extraction: { state: 'queued', progress: 0, error: null } });
      this.#queue.push({ firstId: first.id, base: archive.base, partIds: archive.parts.map((l) => l.id) });
    }
    this.#pump();
  }

  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (let job = this.#queue.shift(); job; job = this.#queue.shift()) await this.#run(job);
    } finally {
      this.#busy = false;
    }
  }

  async #run(job) {
    const first = this.#list.getLink(job.firstId);
    if (!first?.filePath) return;
    const dir = path.dirname(first.filePath);
    const destination = this.#settings.extractToSubfolder ? path.join(dir, job.base) : dir;
    const update = (extraction) => this.#list.updateLink(job.firstId, { extraction: { destination, ...extraction } });

    update({ state: 'running', progress: 0, error: null });
    let lastReport = 0;
    try {
      await extractArchive(this.#tools, {
        archive: first.filePath,
        destination,
        passwords: this.#settings.archivePasswords.split(/\r?\n/).map((p) => p.trim()),
        signal: this.#controller.signal,
        onProgress: (progress) => {
          if (Date.now() - lastReport > 250 || progress === 100) {
            lastReport = Date.now();
            update({ state: 'running', progress, error: null });
          }
        },
      });
      update({ state: 'done', progress: 100, error: null });
      if (this.#settings.deleteArchivesAfterExtract) await this.#deleteParts(job.partIds);
    } catch (err) {
      update({ state: 'failed', progress: 0, error: err.message });
    }
  }

  async #deleteParts(ids) {
    for (const id of ids) {
      const link = this.#list.getLink(id);
      if (!link?.filePath) continue;
      if (await stat(link.filePath).catch(() => null)) await rm(link.filePath, { force: true });
    }
  }
}
