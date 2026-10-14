import { fileNameFromUrl } from '../../engine/filename.js';
import { HlsDownload } from '../../engine/HlsDownload.js';
import { bestVariant, parsePlaylist } from '../../engine/m3u8.js';
import { BEST_ONLY, nameWithQuality, tierOf } from '../quality.js';

/**
 * Plugin for direct HLS stream links (.m3u8), e.g. found inside a web page.
 * @param {import('../../tools/Tools.js').Tools} tools
 * @param {() => import('../quality.js').QualityPrefs} [prefs] which qualities to offer
 * @returns {import('../PluginRegistry.js').Plugin}
 */
export function createHlsPlugin(tools, prefs = () => BEST_ONLY) {
  return {
    id: 'hls',
    name: 'Streaming video (HLS)',
    type: 'host',
    patterns: [/^https?:\/\/[^\s]+\.m3u8(?:[?#]|$)/i],

    async check(link, ctx) {
      const page = await ctx.http.get(link.url, { headers: link.headers });
      const master = parsePlaylist(page.text, page.url);
      let playlist = master;
      let bandwidth = null;
      if (master.type === 'master') {
        // Same choice as the download: the best variant. Its bitrate x duration ≈ size.
        const variant = bestVariant(master.variants);
        if (!variant) return { available: false, error: 'No video streams found' };
        bandwidth = variant.bandwidth;
        const media = await ctx.http.get(variant.url, { headers: link.headers });
        playlist = parsePlaylist(media.text, media.url);
      }
      if (!playlist.endList) return { available: false, error: 'Live streams are not supported' };

      const fromUrl = fileNameFromUrl(link.url)?.replace(/\.m3u8$/i, '');
      const name = link.name ?? (fromUrl ? `${fromUrl}.mp4` : 'video.mp4');
      const sizeFor = (bps) => (bps && playlist.duration ? Math.round((bps * playlist.duration) / 8) : null);

      // Several qualities wanted: one link per wanted quality the stream offers.
      const p = prefs();
      if (master.type === 'master' && p.multiple && p.list.length && !link.data?.variant) {
        const byTier = new Map();
        for (const v of master.variants) {
          const tier = tierOf(v.width, v.height);
          if (tier && (!byTier.has(tier) || v.bandwidth > byTier.get(tier).bandwidth)) byTier.set(tier, v);
        }
        const variants = p.list
          .filter((q) => byTier.has(q))
          .map((q) => {
            const v = byTier.get(q);
            const size = sizeFor(v.bandwidth);
            return {
              name: nameWithQuality(name, q, 'mp4'),
              size,
              sizeApprox: size != null,
              data: { variant: { width: v.width, height: v.height, bandwidth: v.bandwidth }, quality: q },
            };
          });
        if (variants.length) return { available: true, variants };
      }

      const size = sizeFor(bandwidth);
      return { available: true, name, size, sizeApprox: size != null };
    },

    createDownload(link, opts) {
      return new HlsDownload({
        ...opts,
        url: link.url,
        headers: link.headers,
        ffmpeg: tools.ffmpeg,
        fileName: opts.fileName ?? link.name,
        variant: link.data?.variant,
      });
    },
  };
}
