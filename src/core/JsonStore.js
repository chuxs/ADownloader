import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A JSON file written atomically (temp file + rename) with debounced saves,
 * so a crash mid-write never leaves a half-written file behind.
 */
export class JsonStore {
  #file;
  #delayMs;
  #timer = null;
  #writing = Promise.resolve();
  #getData;

  /**
   * @param {string} file
   * @param {() => unknown} getData returns the data to save
   * @param {number} [delayMs] debounce delay for scheduleSave()
   */
  constructor(file, getData, delayMs = 1000) {
    this.#file = file;
    this.#getData = getData;
    this.#delayMs = delayMs;
  }

  /** @returns {Promise<any|null>} parsed contents, or null if missing/corrupt */
  async load() {
    for (const f of [this.#file, `${this.#file}.bak`]) {
      try {
        return JSON.parse(await readFile(f, 'utf8'));
      } catch {
        // try the backup
      }
    }
    return null;
  }

  scheduleSave() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.save();
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  /** Save now (cancels a pending debounced save). */
  save() {
    clearTimeout(this.#timer);
    this.#timer = null;
    const json = JSON.stringify(this.#getData(), null, 1);
    // A failed earlier save must not block later ones.
    this.#writing = this.#writing.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, json);
      // Keep the previous version as a backup in case the new file is damaged.
      await rename(this.#file, `${this.#file}.bak`).catch(() => {});
      await rename(tmp, this.#file);
    });
    return this.#writing;
  }
}
