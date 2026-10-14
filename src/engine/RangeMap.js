/**
 * Sorted set of non-overlapping, half-open byte ranges [start, end).
 * Used to remember which parts of a file are already on disk.
 */
export class RangeMap {
  /** @type {Array<[number, number]>} */
  #ranges = [];

  /** @param {Array<[number, number]>} [ranges] */
  constructor(ranges = []) {
    for (const [start, end] of ranges) this.add(start, end);
  }

  /** Mark [start, end) as covered, merging with touching/overlapping ranges. */
  add(start, end) {
    if (end <= start) return;
    const out = [];
    let s = start;
    let e = end;
    let placed = false;
    for (const r of this.#ranges) {
      if (r[1] < s) {
        out.push(r);
      } else if (r[0] > e) {
        if (!placed) {
          out.push([s, e]);
          placed = true;
        }
        out.push(r);
      } else {
        s = Math.min(s, r[0]);
        e = Math.max(e, r[1]);
      }
    }
    if (!placed) out.push([s, e]);
    this.#ranges = out;
  }

  /** Total number of covered bytes. */
  get covered() {
    let sum = 0;
    for (const [s, e] of this.#ranges) sum += e - s;
    return sum;
  }

  /**
   * Ranges inside [0, total) that are not covered yet.
   * @returns {Array<[number, number]>}
   */
  missing(total) {
    const gaps = [];
    let cursor = 0;
    for (const [s, e] of this.#ranges) {
      if (s >= total) break;
      if (s > cursor) gaps.push([cursor, s]);
      cursor = Math.max(cursor, e);
    }
    if (cursor < total) gaps.push([cursor, total]);
    return gaps;
  }

  isComplete(total) {
    return this.missing(total).length === 0;
  }

  clear() {
    this.#ranges = [];
  }

  toJSON() {
    return this.#ranges.map((r) => [r[0], r[1]]);
  }
}
