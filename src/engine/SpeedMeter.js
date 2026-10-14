/** Average speed (bytes/second) over a sliding time window. */
export class SpeedMeter {
  #windowMs;
  /** @type {Array<{t: number, bytes: number}>} */
  #samples = [];

  constructor(windowMs = 3000) {
    this.#windowMs = windowMs;
  }

  add(bytes, now = Date.now()) {
    const last = this.#samples.at(-1);
    // Bucket samples per 100ms so the array stays small at high throughput.
    if (last && now - last.t < 100) last.bytes += bytes;
    else this.#samples.push({ t: now, bytes });
    this.#trim(now);
  }

  /** @returns {number} bytes per second */
  speed(now = Date.now()) {
    this.#trim(now);
    if (this.#samples.length === 0) return 0;
    let total = 0;
    for (const s of this.#samples) total += s.bytes;
    const span = Math.max(now - this.#samples[0].t, 1000);
    return Math.round((total * 1000) / span);
  }

  reset() {
    this.#samples = [];
  }

  #trim(now) {
    const cutoff = now - this.#windowMs;
    while (this.#samples.length && this.#samples[0].t < cutoff) this.#samples.shift();
  }
}
