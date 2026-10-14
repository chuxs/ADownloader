import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DownloadList, LinkState } from '../src/core/DownloadList.js';
import { Thumbnails } from '../src/core/Thumbnails.js';
import { run, which } from '../src/tools/process.js';

const ffmpeg = await which('ffmpeg');
let root;
let server;
let base;
let jpeg;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adl-thumb-'));
  if (ffmpeg) {
    await run(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', path.join(root, 'img.jpg')]);
    jpeg = await readFile(path.join(root, 'img.jpg'));
  } else {
    // A 1x1 JPEG is enough when ffmpeg is missing.
    jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  }
  server = createServer((req, res) => {
    if (req.url === '/thumb.jpg') res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(jpeg);
    else if (req.url === '/page.html') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>');
    else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

async function waitFor(cond, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('downloads a remote thumbnail once and gives the link a key', async () => {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const list = new DownloadList({ file: path.join(dir, 'list.json') });
  const thumbs = new Thumbnails(path.join(dir, 'cache'), { ffmpeg: null }, [list]);
  const pkg = list.addPackage({
    directory: dir,
    links: [
      { url: 'https://v.test/1', thumbnail: `${base}/thumb.jpg` },
      { url: 'https://v.test/2', thumbnail: `${base}/thumb.jpg` }, // same image
      { url: 'https://v.test/3', thumbnail: `${base}/page.html` }, // not an image
    ],
  });
  await waitFor(() => pkg.links[0].thumbKey && pkg.links[1].thumbKey);
  assert.equal(pkg.links[0].thumbKey, pkg.links[1].thumbKey);
  assert.deepEqual(await readFile(thumbs.fileFor(pkg.links[0].thumbKey)), jpeg);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pkg.links[2].thumbKey, null);
  assert.equal((await readdir(path.join(dir, 'cache'))).length, 1);
});

test('only serves files from its own folder', () => {
  const thumbs = new Thumbnails(path.join(root, 'cache'), { ffmpeg: null }, []);
  assert.equal(thumbs.fileFor('../secret.txt'), null);
  assert.equal(thumbs.fileFor('..\\..\\x.jpg'), null);
  assert.ok(thumbs.fileFor('abcdef1234.jpg'));
});

test('cleanup removes thumbnails nothing uses', async () => {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const list = new DownloadList({ file: path.join(dir, 'list.json') });
  const thumbs = new Thumbnails(path.join(dir, 'cache'), { ffmpeg: null }, [list]);
  const pkg = list.addPackage({ directory: dir, links: [{ url: 'https://v.test/1', thumbnail: `${base}/thumb.jpg` }] });
  await waitFor(() => pkg.links[0].thumbKey);
  list.removeLinks([pkg.links[0].id]);
  await thumbs.cleanup();
  assert.deepEqual(await readdir(path.join(dir, 'cache')), []);
});

test('grabs a frame from a finished video', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const video = path.join(dir, 'clip.mp4');
  await run(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', video]);
  const list = new DownloadList({ file: path.join(dir, 'list.json') });
  const thumbs = new Thumbnails(path.join(dir, 'cache'), { ffmpeg }, [list]);
  const pkg = list.addPackage({ directory: dir, links: [{ url: 'https://x.test/clip.mp4' }] });
  const link = pkg.links[0];
  list.updateLink(link.id, { state: LinkState.COMPLETED, filePath: video });
  await waitFor(() => link.thumbKey);
  const probe = await run(path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'), [
    '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', thumbs.fileFor(link.thumbKey),
  ]);
  assert.equal(probe.stdout.trim(), '320,180'); // scaled down, aspect kept
});
