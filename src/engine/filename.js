import { access } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Make a string safe to use as a file name on Windows, macOS and Linux. */
export function sanitizeFileName(name, fallback = 'download') {
  let clean = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!clean) clean = fallback;
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  // Keep within common 255-byte limits while preserving the extension.
  if (Buffer.byteLength(clean) > 240) {
    const ext = path.extname(clean).slice(0, 20);
    let base = clean.slice(0, clean.length - ext.length);
    while (Buffer.byteLength(base + ext) > 240) base = base.slice(0, -1);
    clean = base + ext;
  }
  return clean;
}

/** Parse the file name from a Content-Disposition header (RFC 6266 / 5987). */
export function fileNameFromContentDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      const charset = star[1].trim().toLowerCase() || 'utf-8';
      const bytes = Buffer.from(
        star[2].trim().replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
        'latin1',
      );
      return new TextDecoder(charset === 'iso-8859-1' ? 'latin1' : charset).decode(bytes);
    } catch {
      // fall through to plain filename=
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1].trim() : null;
}

export function fileNameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a path in `dir` for `name` that is not taken by a finished file or an
 * unfinished download (.part file or .hls folder), adding " (1)", " (2)", ...
 */
export async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    const taken = await Promise.all([candidate, `${candidate}.part`, `${candidate}.hls`].map(exists));
    if (!taken.some(Boolean)) return candidate;
  }
}
