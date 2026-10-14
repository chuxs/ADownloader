const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function bytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : n < 100 ? 1 : 0)} ${UNITS[i]}`;
}

/** Size with "~" in front when it is an estimate. */
export function size(n, approx) {
  const s = bytes(n);
  return s && approx ? `~${s}` : s;
}

export function speed(n) {
  return n ? `${bytes(n)}/s` : '';
}

export function duration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function percent(done, total) {
  if (!total) return null;
  return Math.min(100, (done / total) * 100);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
