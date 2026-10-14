/** Video quality levels offered when downloading several qualities. */
export const QUALITY_OPTIONS = ['2160', '1440', '1080', '720', '480', '360', 'audio'];

const TIERS = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];

/**
 * Standard quality level ("1080", "720", ...) of a video size.
 * Uses the 16:9 equivalent, so letterboxed 1920x800 counts as 1080p and a
 * vertical 1080x1920 video as 1080p too.
 */
export function tierOf(width, height) {
  const w = width || 0;
  const h = height || 0;
  if (!w && !h) return null;
  const short = Math.min(w || Infinity, h || Infinity);
  const long = Math.max(w, h);
  const p = Math.max(short, Math.round((long * 9) / 16));
  for (const t of [...TIERS].reverse()) if (p <= t * 1.15) return String(t);
  return String(TIERS[0]);
}

export function qualityLabel(q) {
  if (q === 'audio') return 'audio';
  if (q === '2160') return '4K';
  if (q === '4320') return '8K';
  return `${q}p`;
}

/** Add " (1080p)" before the extension, and set the extension. */
export function nameWithQuality(name, quality, ext) {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  return `${base} (${qualityLabel(quality)}).${ext}`;
}

/**
 * Current preferences, read when links are checked.
 * @typedef {{multiple: boolean, list: string[]}} QualityPrefs
 */
export const BEST_ONLY = Object.freeze({ multiple: false, list: [] });
