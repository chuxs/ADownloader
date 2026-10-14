import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DownloadList, LinkState } from '../src/core/DownloadList.js';
import { Scheduler } from '../src/core/Scheduler.js';
import { LinkGrabber } from '../src/grabber/LinkGrabber.js';
import { extractLinksFromHtml, extractUrlsFromText, metaContent } from '../src/plugins/html.js';
import { PluginError } from '../src/plugins/PluginError.js';
import { PluginRegistry } from '../src/plugins/PluginRegistry.js';

const FILE = randomBytes(200 * 1024);
let root;
let server;
let base;

/** A tiny website: an HTML page linking to files, an empty page, and file URLs. */
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adl-grab-'));
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Holiday Videos</title>
        <meta property="og:video" content="/media/clip.mp4"></head><body>
        <a href="/files/photos.zip">Photos</a>
        <a href='files/album.part1.rar'>Part 1</a>
        <a href="/files/album.part2.rar?dl=1&amp;x=2">Part 2</a>
        <a href="/about.html">About</a><a href="javascript:void(0)">x</a>
        <video><source src="/media/clip.mp4" type="video/mp4"></video>
        </body></html>`);
    } else if (url.pathname === '/empty.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Nothing here</body></html>');
    } else if (url.pathname.startsWith('/files/') || url.pathname.startsWith('/media/')) {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : FILE.length - 1;
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${FILE.length}`,
          'Content-Length': end - start + 1,
        });
        res.end(FILE.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': FILE.length });
        res.end(FILE);
      }
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(root, { recursive: true, force: true });
});

/** Fake site plugins: a file host and a folder service that lists file-host links. */
function testRegistry() {
  const registry = PluginRegistry.withBuiltins();
  registry.register({
    id: 'fakehost',
    name: 'Fake Host',
    type: 'host',
    patterns: [/^https?:\/\/fakehost\.test\/file\/\w+/],
    async check(link) {
      const id = link.url.split('/').at(-1);
      if (id === 'gone') throw new PluginError('OFFLINE', 'File was deleted');
      return { available: true, name: `video-${id}.mp4`, size: FILE.length };
    },
    async resolve(link) {
      const id = link.url.split('/').at(-1);
      return { url: `${base}/files/real-${id}.bin`, name: `video-${id}.mp4` };
    },
  });
  registry.register({
    id: 'fakefolder',
    name: 'Fake Folder',
    type: 'crawler',
    patterns: [/^https?:\/\/fakefolder\.test\//],
    async crawl() {
      return [
        { url: 'http://fakehost.test/file/aa', packageName: 'My Folder' },
        { url: 'http://fakehost.test/file/bb', packageName: 'My Folder' },
      ];
    },
  });
  return registry;
}

async function setup() {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const registry = testRegistry();
  const list = new DownloadList({ file: path.join(dir, 'list.json') });
  const grabber = new LinkGrabber({ registry, list, defaultDirectory: path.join(dir, 'out') });
  return { dir, registry, list, grabber };
}

async function idle(grabber) {
  while (grabber.busy) await new Promise((r) => setTimeout(r, 10));
}

function allLinks(grabber) {
  return grabber.packages.flatMap((p) => p.links);
}

// ------------------------------------------------------------------ html helpers

test('extracts URLs from pasted text', () => {
  const text = `Get it here: https://example.com/a.zip, or (https://example.com/b.rar).
    Wiki: https://en.wikipedia.org/wiki/Foo_(bar). Dup: https://example.com/a.zip
    Encoded: https://example.com/c?x=1&amp;y=2`;
  assert.deepEqual(extractUrlsFromText(text), [
    'https://example.com/a.zip',
    'https://example.com/b.rar',
    'https://en.wikipedia.org/wiki/Foo_(bar)',
    'https://example.com/c?x=1&y=2',
  ]);
});

test('extracts links and meta tags from HTML', () => {
  const html = `<a href="/x.zip">x</a><img src='img/y.png'><a href="#top">t</a>
    <meta content="Clip" property="og:title">`;
  assert.deepEqual(extractLinksFromHtml(html, 'https://site.test/dir/page'), [
    'https://site.test/x.zip',
    'https://site.test/dir/img/y.png',
  ]);
  assert.equal(metaContent(html, 'og:title'), 'Clip');
});

// ------------------------------------------------------------------ crawling

test('a direct file link is checked and gets its name and size', async () => {
  const { grabber } = await setup();
  assert.equal(await grabber.add(`${base}/files/report.pdf`), 1);
  const [link] = allLinks(grabber);
  assert.equal(link.pluginId, 'directhttp');
  assert.equal(link.status, 'online');
  assert.equal(link.name, 'report.pdf');
  assert.equal(link.size, FILE.length);
});

test('an unsupported web page is searched for files', async () => {
  const { grabber } = await setup();
  await grabber.add(`${base}/page.html`);
  const names = allLinks(grabber)
    .map((l) => l.name)
    .sort();
  assert.deepEqual(names, ['album.part1.rar', 'album.part2.rar', 'clip.mp4', 'photos.zip']);
  assert.ok(allLinks(grabber).every((l) => l.status === 'online'));
  // All found on one page: one package named after the page.
  assert.deepEqual(
    grabber.packages.map((p) => p.name),
    ['Holiday Videos'],
  );
});

test('a page without files and a missing file are reported offline', async () => {
  const { grabber } = await setup();
  await grabber.add(`${base}/empty.html ${base}/files-missing/x.zip`);
  const links = allLinks(grabber);
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.status === 'offline'));
  assert.match(links.find((l) => l.url.endsWith('empty.html')).error, /No downloadable files/);
});

test('site plugins: crawler expands a folder, host plugin checks each file', async () => {
  const { grabber } = await setup();
  await grabber.add('folder: http://fakefolder.test/abc and http://fakehost.test/file/gone');
  await idle(grabber);
  const byUrl = Object.fromEntries(allLinks(grabber).map((l) => [l.url, l]));
  assert.equal(byUrl['http://fakehost.test/file/aa'].status, 'online');
  assert.equal(byUrl['http://fakehost.test/file/aa'].name, 'video-aa.mp4');
  assert.equal(byUrl['http://fakehost.test/file/bb'].pluginId, 'fakehost');
  assert.equal(byUrl['http://fakehost.test/file/gone'].status, 'offline');
  assert.ok(grabber.packages.some((p) => p.name === 'My Folder' && p.links.length === 2));
});

// ------------------------------------------------------------------ end to end

test('confirmed links download, using the plugin to find the real file', async () => {
  const { dir, registry, list, grabber } = await setup();
  await grabber.add('http://fakefolder.test/abc http://fakehost.test/file/gone');
  await idle(grabber);

  const created = grabber.confirm();
  assert.equal(created.length, 1); // the offline link stayed behind
  assert.equal(allLinks(grabber).length, 1);
  assert.equal(allLinks(grabber)[0].status, 'offline');

  const sched = new Scheduler(list, { connections: 2 }, { plugins: registry, engine: { retryDelayMs: 10 } });
  sched.start();
  const links = [...list.links()];
  while (!links.every((l) => l.state === LinkState.COMPLETED)) {
    assert.ok(!links.some((l) => l.state === LinkState.FAILED), links.map((l) => l.error?.message).join());
    await new Promise((r) => setTimeout(r, 20));
  }
  await sched.close();

  const out = path.join(dir, 'out');
  assert.deepEqual(await readFile(path.join(out, 'video-aa.mp4')), FILE);
  assert.deepEqual(await readFile(path.join(out, 'video-bb.mp4')), FILE);
});

test('a plugin error fails the download with its message', async () => {
  const { registry, list } = await setup();
  registry.register({
    id: 'brokenhost',
    name: 'Broken',
    type: 'host',
    patterns: [/brokenhost\.test/],
    async resolve() {
      throw new PluginError('ACCOUNT_REQUIRED', 'Premium account needed');
    },
  });
  list.addPackage({ directory: root, links: [{ url: 'http://brokenhost.test/f/1', pluginId: 'brokenhost' }] });
  const sched = new Scheduler(list, {}, { plugins: registry });
  sched.start();
  const [link] = [...list.links()];
  while (link.state !== LinkState.FAILED) await new Promise((r) => setTimeout(r, 10));
  await sched.close();
  assert.deepEqual(link.error, { code: 'ACCOUNT_REQUIRED', message: 'Premium account needed' });
});
