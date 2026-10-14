import { fileNameFromUrl } from '../../engine/filename.js';
import { HlsDownload } from '../../engine/HlsDownload.js';
import { bestVariant, parsePlaylist } from '../../engine/m3u8.js';

/**
 * Plugin for direct HLS stream links (.m3u8), e.g. found inside a web page.
 * @param {import('../../tools/Tools.js').Tools} tools
 * @returns {import('../PluginRegistry.js').Plugin}
 */
export function createHlsPlugin(tools) {
  return {
    id: 'hls',
    name: 'Streaming video (HLS)',
    type: 'host',
    patterns: [/^https?:\/\/[^\s]+\.m3u8(?:[?#]|$)/i],

    async check(link, ctx) {
      const page = await ctx.http.get(link.url, { headers: link.headers });
      let playlist = parsePlaylist(page.text, page.url);
      let bandwidth = null;
      if (playlist.type === 'master') {
        // Same choice as the download: the best variant. Its bitrate x duration ≈ size.
        const variant = bestVariant(playlist.variants);
        if (!variant) return { available: false, error: 'No video streams found' };
        bandwidth = variant.bandwidth;
        const media = await ctx.http.get(variant.url, { headers: link.headers });
        playlist = parsePlaylist(media.text, media.url);
      }
      if (!playlist.endList) return { available: false, error: 'Live streams are not supported' };
      const size = bandwidth && playlist.duration ? Math.round((bandwidth * playlist.duration) / 8) : null;
      const fromUrl = fileNameFromUrl(link.url)?.replace(/\.m3u8$/i, '');
      const name = link.name ?? (fromUrl ? `${fromUrl}.mp4` : undefined);
      return { available: true, name, size, sizeApprox: size != null };
    },

    createDownload(link, opts) {
      return new HlsDownload({ ...opts, url: link.url, headers: link.headers, ffmpeg: tools.ffmpeg, fileName: opts.fileName ?? link.name });
    },
  };
}
