import { EventEmitter } from 'node:events';
import { JsonStore } from '../core/JsonStore.js';

/** User settings, saved as settings.json in the app data folder. */
export class Settings extends EventEmitter {
  #values;
  #store;

  /**
   * @param {string} file
   * @param {object} defaults
   */
  constructor(file, defaults) {
    super();
    this.#values = { ...defaults };
    this.defaults = Object.freeze({ ...defaults });
    this.#store = new JsonStore(file, () => this.#values, 300);
  }

  async load() {
    const saved = await this.#store.load();
    if (saved) {
      for (const key of Object.keys(this.defaults)) {
        if (key in saved && typeof saved[key] === typeof this.defaults[key]) this.#values[key] = saved[key];
      }
    }
  }

  get values() {
    return { ...this.#values };
  }

  get(key) {
    return this.#values[key];
  }

  /** Change settings; unknown keys and wrong types are ignored. */
  set(patch) {
    const changed = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in this.defaults) || typeof value !== typeof this.defaults[key]) continue;
      if (this.#values[key] === value) continue;
      this.#values[key] = value;
      changed[key] = value;
    }
    if (Object.keys(changed).length) {
      this.#store.scheduleSave();
      this.emit('changed', changed);
    }
    return this.values;
  }

  save() {
    return this.#store.save();
  }
}
