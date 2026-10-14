/**
 * Recognize archive files and multi-part archive sets from file names.
 *
 * Returns {key, base, index} where `key` groups the parts of one archive,
 * `base` is the name without archive extensions, and `index` 1 marks the
 * part to open (7-Zip finds the others itself).
 */
export function archivePart(fileName) {
  let m;
  // movie.part1.rar, movie.part01.rar
  if ((m = /^(.*)\.part0*(\d+)\.rar$/i.exec(fileName))) {
    return { key: `${m[1]}.partN.rar`.toLowerCase(), base: m[1], index: Number(m[2]) };
  }
  // movie.7z.001, movie.zip.001, movie.rar.001
  if ((m = /^(.*)\.(7z|zip|rar)\.0*(\d+)$/i.exec(fileName))) {
    return { key: `${m[1]}.${m[2]}.NNN`.toLowerCase(), base: m[1], index: Number(m[3]) };
  }
  // Old-style RAR volumes: movie.rar (first), movie.r00, movie.r01, ...
  if ((m = /^(.*)\.r(\d{2,3})$/i.exec(fileName))) {
    return { key: `${m[1]}.rar`.toLowerCase(), base: m[1], index: Number(m[2]) + 2 };
  }
  // Split ZIP: movie.z01, movie.z02, ... with movie.zip (7-Zip opens the .zip)
  if ((m = /^(.*)\.z(\d{2})$/i.exec(fileName))) {
    return { key: `${m[1]}.zip`.toLowerCase(), base: m[1], index: Number(m[2]) + 1 };
  }
  // Single archives (or the first part of the two styles above).
  if ((m = /^(.*?)\.(tar\.gz|tar\.bz2|tar\.xz|tar\.zst|tgz|tar|zip|7z|rar)$/i.exec(fileName))) {
    return { key: `${m[1]}.${m[2]}`.toLowerCase(), base: m[1], index: 1 };
  }
  return null;
}

/**
 * Group files into archives.
 * @param {Array<{name: string}>} files
 * @returns {Array<{key: string, base: string, first: object, parts: object[]}>}
 *   `first` is undefined when the first part is not in the list.
 */
export function groupArchives(files) {
  const groups = new Map();
  for (const f of files) {
    const p = archivePart(f.name);
    if (!p) continue;
    if (!groups.has(p.key)) groups.set(p.key, { key: p.key, base: p.base, first: undefined, parts: [] });
    const g = groups.get(p.key);
    g.parts.push(f);
    if (p.index === 1) g.first = f;
  }
  return [...groups.values()];
}
