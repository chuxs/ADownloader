import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Token-bucket speed limit. One instance can be shared by many downloads
 * to enforce a global limit, or given to a single download.
 */
export class SpeedLimiter {
  #rate;
  #tokens;
  #last = Date.now();

  /** @param {number} bytesPerSecond 0 = unlimited */
  constructor(bytesPerSecond = 0) {
    this.#rate = bytesPerSecond;
    this.#tokens = bytesPerSecond;
  }

  get rate() {
    return this.#rate;
  }

  set rate(bytesPerSecond) {
    this.#rate = Math.max(0, bytesPerSecond);
    this.#tokens = Math.min(this.#tokens, this.#rate);
  }

  /** Wait until `bytes` may pass. Resolves immediately when unlimited. */
  async consume(bytes, signal) {
    while (this.#rate > 0) {
      this.#refill();
      if (this.#tokens > 0) {
        // Allow going into debt so chunks larger than one second of budget still pass.
        this.#tokens -= bytes;
        return;
      }
      const waitMs = Math.ceil((-this.#tokens * 1000) / this.#rate) || 10;
      await sleep(Math.min(waitMs, 250), undefined, { signal });
    }
  }

  #refill() {
    const now = Date.now();
    this.#tokens = Math.min(this.#rate, this.#tokens + ((now - this.#last) * this.#rate) / 1000);
    this.#last = now;
  }
}
