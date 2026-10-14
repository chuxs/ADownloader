import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DownloadState } from '../src/engine/Download.js';
import { HlsDownload } from '../src/engine/HlsDownload.js';
import { bestVariant, parsePlaylist, sequenceIv } from '../src/engine/m3u8.js';
import { createHlsPlugin } from '../src/plugins/builtin/hls.js';
import { PluginRegistry } from '../src/plugins/PluginRegistry.js';
import { run, which } from '../src/tools/process.js';

let root;
let server;
let base;
/** path -> Buffer | string served by the test server */
const files = new Map();

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adl-hls-'));
  server = createServer((req, res) => {
    const body = files.get(new URL(req.url, 'http://x').pathname);
    if (body == null) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(root, { recursive: true, force: true });
});

test('parses master playlists and picks the best quality', () => {
  const master = parsePlaylist(
    `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
https://cdn.test/1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p.m3u8`,
    'https://site.test/video/master.m3u8',
  );
  assert.equal(master.type, 'master');
  assert.equal(master.variants.length, 3);
  assert.equal(master.variants[0].codecs, 'avc1.4d401e,mp4a.40.2');
  assert.equal(bestVariant(master.variants).url, 'https://cdn.test/1080p.m3u8');
  assert.equal(master.media[0].url, 'https://site.test/video/audio/en.m3u8');
});

test('parses media playlists with keys and byte ranges', () => {
  const media = parsePlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000000A
#EXTINF:4.0,
seg0.ts
#EXT-X-KEY:METHOD=NONE
#EXT-X-BYTERANGE:1000@0
#EXTINF:3.5,
all.ts
#EXT-X-BYTERANGE:500
#EXTINF:2,
all.ts
#EXT-X-ENDLIST`,
    'https://site.test/v/index.m3u8',
  );
  assert.equal(media.type, 'media');
  assert.equal(media.endList, true);
  assert.equal(media.segments.length, 3);
  assert.equal(media.segments[0].sequence, 7);
  assert.equal(media.segments[0].key.url, 'https://site.test/v/key.bin');
  assert.equal(media.segments[0].key.iv.readUInt8(15), 10);
  assert.equal(media.segments[1].key, null);
  assert.deepEqual(media.segments[2].range, { offset: 1000, length: 500 });
  assert.equal(media.duration, 9.5);
});

/** Serve a stream of random "segments", AES-128 encrypted like real HLS. */
function serveEncryptedStream(prefix, segmentCount) {
  const key = randomBytes(16);
  const plain = [];
  let playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n`;
  for (let i = 0; i < segmentCount; i++) {
    const data = randomBytes(50_000 + i * 1000);
    plain.push(data);
    const cipher = createCipheriv('aes-128-cbc', key, sequenceIv(i));
    files.set(`${prefix}/seg${i}.ts`, Buffer.concat([cipher.update(data), cipher.final()]));
    playlist += `#EXTINF:2.0,\nseg${i}.ts\n`;
  }
  files.set(`${prefix}/key.bin`, key);
  files.set(`${prefix}/index.m3u8`, `${playlist}#EXT-X-ENDLIST\n`);
  files.set(`${prefix}/master.m3u8`, `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nindex.m3u8\n`);
  return Buffer.concat(plain);
}

test('downloads and decrypts an encrypted stream (no ffmpeg: saves .ts)', async () => {
  const expected = serveEncryptedStream('/enc', 12);
  const dir = await mkdtemp(path.join(root, 'case-'));
  const dl = new HlsDownload({ url: `${base}/enc/master.m3u8`, directory: dir, fileName: 'My Clip.mp4', ffmpeg: null });
  assert.equal(await dl.start(), DownloadState.COMPLETED, dl.error?.message);
  assert.equal(path.basename(dl.filePath), 'My Clip.ts');
  assert.deepEqual(await readFile(dl.filePath), expected);
  assert.deepEqual(await readdir(dir), ['My Clip.ts']); // temp segment folder removed
});

test('pause keeps finished segments; resume only fetches the rest', async () => {
  const expected = serveEncryptedStream('/resume', 40);
  const dir = await mkdtemp(path.join(root, 'case-'));
  let requests = 0;
  server.on('request', (req) => {
    if (req.url.startsWith('/resume/seg')) requests++;
  });
  const first = new HlsDownload({ url: `${base}/resume/index.m3u8`, directory: dir, fileName: 'r.ts', connections: 1 });
  first.start();
  while (first.info.segments.done < 10) await new Promise((r) => setTimeout(r, 2));
  await first.pause();
  assert.equal(first.state, DownloadState.PAUSED);
  const doneBefore = first.info.segments.done;

  requests = 0;
  const second = new HlsDownload({ url: `${base}/resume/index.m3u8`, filePath: first.filePath, connections: 4 });
  assert.equal(await second.start(), DownloadState.COMPLETED, second.error?.message);
  assert.deepEqual(await readFile(second.filePath), expected);
  // Only the missing segments (+1: the request in flight at pause may arrive after the reset).
  assert.ok(requests <= 40 - doneBefore + 1, `segment requests: ${requests}, done before: ${doneBefore}`);
});

test('link check estimates the size of a stream', async () => {
  serveEncryptedStream('/est', 30); // 30 segments x 2 s = 60 s
  files.set('/est/master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nindex.m3u8\n');
  const plugin = createHlsPlugin({ ffmpeg: null });
  const r = await plugin.check({ url: `${base}/est/master.m3u8` }, PluginRegistry.context());
  assert.deepEqual(r, { available: true, name: 'master.mp4', size: 15_000_000, sizeApprox: true }); // 2 Mbit/s x 60 s
});

test('fails clearly on a live stream', async () => {
  files.set('/live/index.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n');
  const dl = new HlsDownload({ url: `${base}/live/index.m3u8`, directory: root });
  assert.equal(await dl.start(), DownloadState.FAILED);
  assert.equal(dl.error.code, 'LIVE_STREAM');
});

const ffmpeg = await which('ffmpeg');

test('with ffmpeg: a real HLS video becomes a playable .mp4', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  // Make a real 4-second test video split into HLS segments.
  const src = await mkdtemp(path.join(root, 'src-'));
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
    '-hls_time', '1', '-hls_playlist_type', 'vod', path.join(src, 'index.m3u8'),
  ]);
  for (const name of await readdir(src)) files.set(`/real/${name}`, await readFile(path.join(src, name)));

  const dir = await mkdtemp(path.join(root, 'case-'));
  const dl = new HlsDownload({ url: `${base}/real/index.m3u8`, directory: dir, fileName: 'Test Video', ffmpeg });
  assert.equal(await dl.start(), DownloadState.COMPLETED, dl.error?.message);
  assert.equal(path.basename(dl.filePath), 'Test Video.mp4');

  const probe = await run(path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'), [
    '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type', '-of', 'json', dl.filePath,
  ]);
  const info = JSON.parse(probe.stdout);
  assert.match(info.format.format_name, /mp4/);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.5, `duration ${info.format.duration}`);
  assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
});
