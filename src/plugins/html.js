// Small, dependency-free helpers for pulling links out of text and HTML.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Find every http(s) URL in free text (pasted text, clipboard, etc.). */
export function extractUrlsFromText(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let url = decodeEntities(m[0]);
    // Trailing punctuation usually belongs to the sentence, not the URL...
    while (/[.,;:!?)\]}]$/.test(url)) {
      // ...except a ")" that closes a "(" inside the URL, e.g. wiki/Foo_(bar).
      if (url.endsWith(')') && count(url, '(') >= count(url, ')')) break;
      url = url.slice(0, -1);
    }
    try {
      const normalized = new URL(url).href;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    } catch {
      // not a valid URL
    }
  }
  return out;
}

function count(s, ch) {
  return s.split(ch).length - 1;
}

/** Absolute URLs from href/src attributes in HTML. */
export function extractLinksFromHtml(html, baseUrl) {
  const out = new Set();
  for (const m of html.matchAll(/\b(?:href|src|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!raw || /^(javascript|mailto|data|tel):/i.test(raw) || raw.startsWith('#')) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        u.hash = '';
        out.add(u.href);
      }
    } catch {
      // ignore malformed URLs
    }
  }
  return [...out];
}

/** Content of <meta property|name="..." content="...">. */
export function metaContent(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${esc}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i');
  const b = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${esc}["']`, 'i');
  const m = a.exec(html) ?? b.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

export function pageTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim() : null;
}
