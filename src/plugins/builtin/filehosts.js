// Plugins for popular file-sharing sites.
import { decodeEntities, metaContent, pageTitle } from '../html.js';
import { PluginError } from '../PluginError.js';
import { probeUrl } from './directhttp.js';

/** Check by asking the direct file URL for its first byte. */
async function checkDirect(url, ctx) {
  const info = await probeUrl(url, { signal: ctx.signal });
  if (!info.available) return { available: false, error: `Server responded ${info.status}` };
  if (info.isPage) return { available: false, error: 'The file is not public, or was removed' };
  return { available: true, name: info.name ?? undefined, size: info.size };
}

/** Dropbox shared links: switching ?dl=0 to ?dl=1 gives the file itself. */
export const dropbox = {
  id: 'dropbox.com',
  name: 'Dropbox',
  type: 'host',
  patterns: [/^https?:\/\/(www\.)?dropbox\.com\/(s|scl\/fi|sh)\//i],

  directUrl(url) {
    const u = new URL(url);
    u.searchParams.set('dl', '1');
    return u.href;
  },
  check(link, ctx) {
    return checkDirect(dropbox.directUrl(link.url), ctx);
  },
  async resolve(link) {
    return { url: dropbox.directUrl(link.url) };
  },
};

/** Public Google Drive files. Large files show a "can't scan for viruses" page first. */
export const googleDrive = {
  id: 'drive.google.com',
  name: 'Google Drive',
  type: 'host',
  patterns: [
    /^https?:\/\/drive\.google\.com\/file\/d\/[\w-]+/i,
    /^https?:\/\/(drive|docs)\.google\.com\/(open|uc)\?(.*&)?id=[\w-]+/i,
    /^https?:\/\/drive\.usercontent\.google\.com\/(download|uc)\?(.*&)?id=[\w-]+/i,
  ],

  fileId(url) {
    return /\/file\/d\/([\w-]+)/.exec(url)?.[1] ?? new URL(url).searchParams.get('id');
  },

  /** Direct URL, following the virus-scan warning page if Google shows it. */
  async directUrl(link, ctx) {
    const id = googleDrive.fileId(link.url);
    const first = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download`;
    const info = await probeUrl(first, { signal: ctx.signal });
    if (info.available && !info.isPage) return { url: first, name: info.name, size: info.size };

    const page = await ctx.http.get(first, { allowErrors: true });
    if (page.status === 404) throw new PluginError('OFFLINE', 'File not found');
    if (/accounts\.google\.com|ServiceLogin/i.test(page.url)) {
      throw new PluginError('ACCOUNT_REQUIRED', 'This file is not shared publicly');
    }
    if (/quota|too many users/i.test(page.text)) {
      throw new PluginError('WAIT', 'Google Drive download limit reached for this file; try later', { retryAfterMs: 60 * 60_000 });
    }
    // Warning page: a form whose hidden fields make up the real download URL.
    const form = /<form[^>]+id="download-form"[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(page.text);
    if (!form) throw new PluginError('PLUGIN_DEFECT', 'Google Drive page not recognized');
    const action = new URL(decodeEntities(form[1]), page.url);
    for (const m of form[2].matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
      const name = /name="([^"]+)"/.exec(m[0])?.[1];
      const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
      if (name) action.searchParams.set(name, decodeEntities(value));
    }
    const nameSize = /<span class="uc-name-size"><a[^>]*>([^<]+)<\/a>\s*\(([^)]+)\)/i.exec(page.text);
    return { url: action.href, name: nameSize ? decodeEntities(nameSize[1]) : undefined, sizeText: nameSize?.[2] };
  },

  async check(link, ctx) {
    const r = await googleDrive.directUrl(link, ctx);
    return { available: true, name: r.name, size: r.size ?? parseSize(r.sizeText) };
  },
  async resolve(link, ctx) {
    const r = await googleDrive.directUrl(link, ctx);
    return { url: r.url, name: r.name };
  },
};

/** MediaFire: the file page has a download button with the direct URL. */
export const mediafire = {
  id: 'mediafire.com',
  name: 'MediaFire',
  type: 'host',
  patterns: [/^https?:\/\/(www\.)?mediafire\.com\/(file|file_premium|download|view)\/\w+/i, /^https?:\/\/(www\.)?mediafire\.com\/\?\w+/i],

  async page(link, ctx) {
    const page = await ctx.http.get(link.url, { allowErrors: true });
    if (page.status === 404 || /error\.php|\/file_removed|File Removed|Invalid or Deleted File/i.test(page.url + page.text)) {
      throw new PluginError('OFFLINE', 'File was removed');
    }
    const button = /<a[^>]+id="downloadButton"[^>]*>/i.exec(page.text)?.[0] ?? '';
    let url = /href="(https?:\/\/[^"]+)"/i.exec(button)?.[1] ?? null;
    // Newer pages hide the URL base64-encoded in data-scrambled-url.
    const scrambled = /data-scrambled-url="([^"]+)"/i.exec(button)?.[1];
    if (!url && scrambled) url = Buffer.from(scrambled, 'base64').toString('utf8');
    const name =
      /<div class="filename">([^<]+)<\/div>/i.exec(page.text)?.[1] ??
      metaContent(page.text, 'og:title') ??
      pageTitle(page.text)?.replace(/\s*-\s*MediaFire.*$/i, '');
    const sizeText = /Download\s*\(([\d.,]+\s*[KMGT]?B)\)/i.exec(page.text)?.[1];
    return { url: url && decodeEntities(url), name: name && decodeEntities(name.trim()), size: parseSize(sizeText) };
  },

  async check(link, ctx) {
    const p = await mediafire.page(link, ctx);
    return { available: true, name: p.name ?? undefined, size: p.size };
  },
  async resolve(link, ctx) {
    const p = await mediafire.page(link, ctx);
    if (!p.url) throw new PluginError('PLUGIN_DEFECT', 'MediaFire download button not found');
    return { url: p.url, name: p.name ?? undefined };
  },
};

/** "12.3 MB", "512K", "1,2 GB" -> bytes (approximate). */
export function parseSize(text) {
  const m = /([\d.,]+)\s*([KMGT]?)i?B?/i.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Math.round(n * 1024 ** ' KMGT'.indexOf((m[2] || ' ').toUpperCase()));
}

export default [dropbox, googleDrive, mediafire];
