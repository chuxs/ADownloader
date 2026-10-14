import { decodeEntities, extractLinksFromHtml, metaContent, pageTitle } from '../html.js';

/** File types worth offering when found on an arbitrary web page. */
const FILE_EXTENSIONS = new RegExp(
  '\\.(' +
    [
      // archives
      'zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso|img|r\\d{2}|\\d{3}',
      // video
      'mp4|m4v|mkv|webm|avi|mov|wmv|flv|mpg|mpeg|3gp',
      // audio
      'mp3|m4a|aac|flac|wav|ogg|opus|wma',
      // documents and books
      'pdf|epub|mobi|cbz|cbr|djvu',
      // programs
      'exe|msi|apk|dmg|pkg|deb|rpm|appimage|jar',
      'torrent',
    ].join('|') +
    ')$',
  'i',
);

const VIDEO = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|flv|mpg|mpeg|3gp|m3u8)$/i;

/**
 * Looks inside a web page that no site plugin supports and returns the
 * downloadable files it links to or embeds (videos, archives, ...).
 *
 * @param {import('../Browser.js').Page} page
 * @returns {import('../PluginRegistry.js').CrawlResult[]}
 */
export function findFilesInPage(page) {
  const packageName = metaContent(page.text, 'og:title') ?? pageTitle(page.text) ?? undefined;
  // The page's preview image is a good thumbnail for videos found on it.
  let preview = metaContent(page.text, 'og:image:secure_url') ?? metaContent(page.text, 'og:image');
  try {
    preview = preview ? new URL(preview, page.url).href : undefined;
  } catch {
    preview = undefined;
  }
  const thumbFor = (url) => (VIDEO.test(new URL(url).pathname) ? preview : undefined);

  const found = new Map();
  const add = (url) => {
    try {
      const u = new URL(url, page.url);
      if (!found.has(u.href)) found.set(u.href, { url: u.href, packageName, thumbnail: thumbFor(u.href) });
    } catch {
      // ignore
    }
  };

  // Media declared for link previews (common on video pages).
  for (const key of ['og:video:secure_url', 'og:video:url', 'og:video', 'og:audio:secure_url', 'og:audio']) {
    const v = metaContent(page.text, key);
    if (v && FILE_EXTENSIONS.test(new URL(v, page.url).pathname)) add(v);
  }
  // Links and embedded media pointing at files.
  for (const url of extractLinksFromHtml(page.text, page.url)) {
    if (FILE_EXTENSIONS.test(new URL(url).pathname)) add(url);
  }

  // Nothing linked: video players often keep their stream URL in a script.
  if (found.size === 0) {
    // Undo JSON escaping: "https:\/\/x.com\/a.m3u8?a=1&b=2"
    const text = page.text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4)(?:\?[^\s"'<>\\]*)?(?=["'\s<\\])/gi)) {
      const url = decodeEntities(m[0]);
      if (found.has(url)) continue;
      const isStream = m[1].toLowerCase() === 'm3u8';
      found.set(url, {
        url,
        packageName,
        name: packageName ? `${packageName}.mp4` : undefined,
        pluginId: isStream ? 'hls' : undefined,
        thumbnail: preview,
      });
    }
  }
  return [...found.values()];
}

/** @type {import('../PluginRegistry.js').Plugin} */
export default {
  id: 'genericpage',
  name: 'Web page',
  type: 'crawler',
  patterns: [],

  async crawl(url, ctx) {
    return findFilesInPage(await ctx.http.get(url));
  },
};
