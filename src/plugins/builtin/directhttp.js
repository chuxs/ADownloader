import { fileNameFromContentDisposition, fileNameFromUrl, sanitizeFileName } from '../../engine/filename.js';
import { parseContentRange } from '../../engine/Download.js';
import { BROWSER_USER_AGENT } from '../../engine/constants.js';
import { toDownloadError } from '../../engine/errors.js';

/**
 * Fallback for URLs no site plugin claims. Asks the server for the first byte
 * to learn whether the URL is a file (name, size) or a web page.
 *
 * @returns {Promise<{available: boolean, status: number, url: string, isPage: boolean,
 *                    name: string|null, size: number|null, contentType: string|null}>}
 */
export async function probeUrl(url, { signal, headers = {} } = {}) {
  const timeout = AbortSignal.timeout(30_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept-Encoding': 'identity', Range: 'bytes=0-0', ...headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'follow',
    });
    await res.body?.cancel().catch(() => {});

    const contentType = res.headers.get('content-type');
    let size = null;
    if (res.status === 206) size = parseContentRange(res.headers.get('content-range'))?.total ?? null;
    else if (res.status === 200 && res.headers.get('content-length')) size = Number(res.headers.get('content-length'));

    const disposition = res.headers.get('content-disposition');
    const name = fileNameFromContentDisposition(disposition) ?? fileNameFromUrl(res.url) ?? fileNameFromUrl(url);
    return {
      available: res.ok || res.status === 416,
      status: res.status,
      url: res.url || url,
      // An HTML response without "attachment" is a page to look inside, not a file to save.
      isPage: /text\/html|application\/xhtml/i.test(contentType ?? '') && !/attachment/i.test(disposition ?? ''),
      name: name ? sanitizeFileName(name) : null,
      size,
      contentType,
    };
  } catch (err) {
    throw toDownloadError(err);
  }
}

/** @type {import('../PluginRegistry.js').Plugin} */
export default {
  id: 'directhttp',
  name: 'Direct link',
  type: 'host',
  patterns: [],

  async check(link, ctx) {
    const info = await probeUrl(link.url, { signal: ctx.signal, headers: link.headers });
    if (!info.available) return { available: false, error: `Server responded ${info.status}` };
    return { available: true, name: info.name ?? undefined, size: info.size };
  },
};
