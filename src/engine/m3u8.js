/**
 * HLS playlist (.m3u8) parser.
 *
 * Master playlists list the available qualities ("variants"); media playlists
 * list the segments of one stream. See RFC 8216.
 */

/** Parse `KEY=value,KEY="quoted, value"` attribute lists. */
export function parseAttributes(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return out;
}

/**
 * @returns {MasterPlaylist|MediaPlaylist}
 *
 * @typedef {{type: 'master', variants: Variant[], media: Rendition[]}} MasterPlaylist
 * @typedef {{url: string, bandwidth: number, width: number|null, height: number|null, codecs: string|null, audio: string|null}} Variant
 * @typedef {{type: string, groupId: string, name: string, default: boolean, url: string|null}} Rendition
 *
 * @typedef {{type: 'media', segments: Segment[], endList: boolean, targetDuration: number, duration: number}} MediaPlaylist
 * @typedef {{url: string, duration: number, sequence: number, key: Key|null,
 *            range: {offset: number, length: number}|null, map: {url: string, range: object|null}|null}} Segment
 * @typedef {{method: string, url: string, iv: Buffer|null}} Key
 */
export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
  const abs = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const media = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttributes(line.slice(18));
        let uri = lines[++i];
        while (uri !== undefined && (uri === '' || uri.startsWith('#'))) uri = lines[++i];
        if (!uri) break;
        const [w, h] = (a.RESOLUTION ?? '').split('x').map(Number);
        variants.push({
          url: abs(uri),
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] ?? a.BANDWIDTH ?? 0),
          width: w || null,
          height: h || null,
          codecs: a.CODECS ?? null,
          audio: a.AUDIO ?? null,
        });
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice(13));
        media.push({
          type: a.TYPE,
          groupId: a['GROUP-ID'],
          name: a.NAME ?? '',
          default: a.DEFAULT === 'YES',
          url: a.URI ? abs(a.URI) : null,
        });
      }
    }
    return { type: 'master', variants, media };
  }

  const segments = [];
  let sequence = 0;
  let targetDuration = 0;
  let endList = false;
  let key = null;
  let map = null;
  let duration = 0;
  let range = null;
  let nextOffset = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice(22));
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.slice(22));
    else if (line === '#EXT-X-ENDLIST') endList = true;
    else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8));
    else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [len, off] = line.slice(17).split('@').map(Number);
      range = { offset: Number.isFinite(off) ? off : nextOffset, length: len };
      nextOffset = range.offset + len;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      key =
        a.METHOD === 'NONE'
          ? null
          : { method: a.METHOD, url: abs(a.URI), iv: a.IV ? Buffer.from(a.IV.replace(/^0x/i, '').padStart(32, '0'), 'hex') : null };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      let mapRange = null;
      if (a.BYTERANGE) {
        const [len, off] = a.BYTERANGE.split('@').map(Number);
        mapRange = { offset: off || 0, length: len };
      }
      map = { url: abs(a.URI), range: mapRange };
    } else if (line && !line.startsWith('#')) {
      segments.push({ url: abs(line), duration, sequence: sequence++, key, range, map });
      duration = 0;
      range = null;
    }
  }
  return {
    type: 'media',
    segments,
    endList,
    targetDuration,
    duration: segments.reduce((s, seg) => s + seg.duration, 0),
  };
}

/** Best quality variant: highest resolution, then highest bitrate. */
export function bestVariant(variants) {
  return [...variants].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)[0] ?? null;
}

/**
 * The variant that best matches a wanted one (same size, then nearest
 * bitrate). Playlists can change slightly between checks and downloads.
 */
export function closestVariant(variants, wanted) {
  const score = (v) =>
    Math.abs((v.height ?? 0) - (wanted.height ?? 0)) * 1e7 +
    Math.abs((v.width ?? 0) - (wanted.width ?? 0)) * 1e7 +
    Math.abs((v.bandwidth ?? 0) - (wanted.bandwidth ?? 0));
  return [...variants].sort((a, b) => score(a) - score(b))[0] ?? null;
}

/** IV for AES-128 when the playlist gives none: the segment's sequence number. */
export function sequenceIv(sequence) {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sequence), 8);
  return iv;
}
