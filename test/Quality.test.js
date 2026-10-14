import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DownloadList } from '../src/core/DownloadList.js';
import { DownloadState } from '../src/engine/Download.js';
import { HlsDownload } from '../src/engine/HlsDownload.js';
import { LinkGrabber } from '../src/grabber/LinkGrabber.js';
import { createHlsPlugin } from '../src/plugins/builtin/hls.js';
import { qualityVariants } from '../src/plugins/builtin/ytdlp.js';
import { PluginRegistry } from '../src/plugins/PluginRegistry.js';
import { nameWithQuality, tierOf } from '../src/plugins/quality.js';

test('sorts resolutions into quality levels', () => {
  assert.equal(tierOf(1920, 1080), '1080');
  assert.equal(tierOf(1920, 800), '1080'); // letterboxed film
  assert.equal(tierOf(1080, 1920), '1080'); // vertical video
  assert.equal(tierOf(1280, 720), '720');
  assert.equal(tierOf(3840, 2160), '2160');
  assert.equal(tierOf(640, 360), '360');
  assert.equal(tierOf(null, 480), '480');
  assert.equal(nameWithQuality('My Trip.mp4', '1080', 'mp4'), 'My Trip (1080p).mp4');
  assert.equal(nameWithQuality('My Trip.mp4', '2160', 'mp4'), 'My Trip (4K).mp4');
  assert.equal(nameWithQuality('My Trip.mp4', 'audio', 'mp3'), 'My Trip (audio).mp3');
});

/** A yt-dlp-like video: separate video and audio formats, plus one combined 360p file. */
const INFO = {
  title: 'Demo',
  duration: 100,
  formats: [
    { format_id: '251', vcodec: 'none', acodec: 'opus', abr: 130, filesize: 1_600_000 },
    { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 1_500_000 },
    { format_id: '18', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', width: 640, height: 360, tbr: 500, ext: 'mp4' },
    { format_id: '135', vcodec: 'avc1.4d401f', acodec: 'none', width: 854, height: 480, filesize: 4_000_000 },
    { format_id: '136', vcodec: 'avc1.4d401f', acodec: 'none', width: 1280, height: 720, filesize: 8_000_000 },
    { format_id: '247', vcodec: 'vp9', acodec: 'none', width: 1280, height: 720, filesize: 7_000_000 },
    { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, fps: 30, filesize: 15_000_000 },
  ],
};

test('yt-dlp: one variant per wanted quality the video offers', () => {
  const v = qualityVariants(INFO, ['2160', '1080', '720', '360', 'audio'], true);
  assert.deepEqual(
    v.map((x) => x.quality),
    ['1080', '720', '360', 'audio'], // no 4K: the video doesn't have it
  );
  const hd = v.find((x) => x.quality === '1080');
  assert.ok(hd.format.startsWith('137+ba/137/'));
  assert.equal(hd.size, 15_000_000 + 1_600_000); // video + best audio
  assert.ok(v.find((x) => x.quality === '720').format.startsWith('136+ba')); // H.264 preferred over VP9
  assert.ok(v.find((x) => x.quality === '360').format.startsWith('18/')); // already has audio
  assert.equal(v.find((x) => x.quality === 'audio').ext, 'mp3');
});

test('yt-dlp without ffmpeg: only files that already contain audio', () => {
  const v = qualityVariants(INFO, ['1080', '720', '360'], false);
  assert.deepEqual(
    v.map((x) => x.quality),
    ['360'],
  );
});

test('Link Grabber replaces a link with its quality variants', async () => {
  const registry = new PluginRegistry();
  registry.register({
    id: 'multi',
    name: 'Multi',
    type: 'host',
    patterns: [/^https:\/\/multi\.test\//],
    async check() {
      return {
        available: true,
        variants: [
          { name: 'Clip (1080p).mp4', size: 100, data: { quality: '1080' } },
          { name: 'Clip (720p).mp4', size: 50, data: { quality: '720' } },
        ],
      };
    },
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'adl-q-'));
  const list = new DownloadList({ file: path.join(dir, 'l.json') });
  const grabber = new LinkGrabber({ registry, list, defaultDirectory: dir });
  await grabber.add('https://multi.test/v/1');
  while (grabber.busy) await new Promise((r) => setTimeout(r, 10));
  const links = grabber.packages.flatMap((p) => p.links);
  assert.deepEqual(
    links.map((l) => [l.name, l.status, l.data.quality]),
    [
      ['Clip (1080p).mp4', 'online', '1080'],
      ['Clip (720p).mp4', 'online', '720'],
    ],
  );
  grabber.confirm();
  assert.deepEqual(
    [...list.links()].map((l) => l.data.quality),
    ['1080', '720'],
  );
  await rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ HLS

let server;
let base;
let root;
const files = new Map();

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adl-qh-'));
  server = createServer((req, res) => {
    const body = files.get(new URL(req.url, 'http://x').pathname);
    if (body == null) return res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Two qualities with different content, 4 segments of 2 s each.
  for (const q of ['720', '360']) {
    let pl = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n';
    for (let i = 0; i < 4; i++) {
      files.set(`/s/${q}/${i}.ts`, randomBytes(1000));
      pl += `#EXTINF:2,\n${i}.ts\n`;
    }
    files.set(`/s/${q}/index.m3u8`, `${pl}#EXT-X-ENDLIST\n`);
  }
  files.set(
    '/s/master.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360/index.m3u8\n',
  );
});

after(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

test('HLS: offers the wanted qualities of a stream and downloads the chosen one', async () => {
  const plugin = createHlsPlugin({ ffmpeg: null }, () => ({ multiple: true, list: ['1080', '720', '360'] }));
  const r = await plugin.check({ url: `${base}/s/master.m3u8`, name: 'Show.mp4' }, PluginRegistry.context());
  assert.deepEqual(
    r.variants.map((v) => [v.name, v.size]),
    [
      ['Show (720p).mp4', 2_000_000], // 2 Mbit/s x 8 s
      ['Show (360p).mp4', 800_000],
    ],
  );

  const low = r.variants[1];
  const dl = new HlsDownload({ url: `${base}/s/master.m3u8`, directory: root, fileName: low.name, variant: low.data.variant });
  assert.equal(await dl.start(), DownloadState.COMPLETED, dl.error?.message);
  const expected = Buffer.concat([0, 1, 2, 3].map((i) => files.get(`/s/360/${i}.ts`)));
  assert.deepEqual(await readFile(dl.filePath), expected);
});

test('HLS: best quality only when several qualities are off', async () => {
  const plugin = createHlsPlugin({ ffmpeg: null });
  const r = await plugin.check({ url: `${base}/s/master.m3u8`, name: 'Show.mp4' }, PluginRegistry.context());
  assert.equal(r.variants, undefined);
  assert.equal(r.size, 2_000_000);
});
