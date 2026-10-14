import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DownloadList, LinkState } from '../src/core/DownloadList.js';
import { FolderSplitter, isVideoLink } from '../src/core/FolderSplitter.js';
import { Scheduler } from '../src/core/Scheduler.js';
import { startServer } from './helpers/server.js';

let root;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adl-split-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function videos(folder, n, start = 0) {
  await mkdir(folder, { recursive: true });
  for (let i = start; i < start + n; i++) await writeFile(path.join(folder, `v${i}.mp4`), 'x');
}

test('recognizes video links', () => {
  assert.ok(isVideoLink({ name: 'a.mkv' }));
  assert.ok(isVideoLink({ name: 'Some title', pluginId: 'ytdlp' }));
  assert.ok(!isVideoLink({ name: 'setup.exe', pluginId: 'directhttp' }));
});

test('fills a folder up to the limit, then asks before the next one', async () => {
  const base = path.join(await mkdtemp(path.join(root, 'c-')), 'Trip');
  const asked = [];
  const splitter = new FolderSplitter(async (q) => {
    asked.push(path.basename(q.next));
    return true;
  });
  splitter.configure({ enabled: true, base, limit: 3 });
  await videos(base, 2);

  assert.equal(await splitter.allocate('a'), base); // 3rd video still fits
  assert.equal(await splitter.allocate('b'), `${base} 2`); // full (2 on disk + 1 downloading)
  assert.deepEqual(asked, ['Trip 2']);
  assert.equal(await splitter.allocate('c'), `${base} 2`);
  assert.equal(await splitter.allocate('d'), `${base} 2`);
  assert.equal(await splitter.allocate('e'), `${base} 3`);
  assert.deepEqual(asked, ['Trip 2', 'Trip 3']);
});

test('continues in the newest folder after a restart', async () => {
  const base = path.join(await mkdtemp(path.join(root, 'c-')), 'Clips');
  await videos(base, 3);
  await videos(`${base} 2`, 1);
  const splitter = new FolderSplitter(async () => assert.fail('should not ask'));
  splitter.configure({ enabled: true, base, limit: 3 });
  assert.equal(await splitter.allocate('x'), `${base} 2`);
});

test('ignores yt-dlp intermediate files and unfinished downloads on disk', async () => {
  const base = path.join(await mkdtemp(path.join(root, 'c-')), 'Mix');
  await mkdir(base);
  for (const n of ['a.f137.mp4', 'a.f140.m4a', 'b.mp4.part', 'notes.txt', 'c.zip']) await writeFile(path.join(base, n), 'x');
  const splitter = new FolderSplitter(async () => true);
  splitter.configure({ enabled: true, base, limit: 1 });
  assert.equal(await splitter.countVideos(base), 0);
});

test('one question for many downloads; "not now" stops until restarted', async () => {
  const base = path.join(await mkdtemp(path.join(root, 'c-')), 'Full');
  await videos(base, 2);
  let questions = 0;
  const splitter = new FolderSplitter(async () => {
    questions++;
    return false;
  });
  splitter.configure({ enabled: true, base, limit: 2 });
  const results = await Promise.all(['a', 'b', 'c'].map((id) => splitter.allocate(id)));
  assert.deepEqual(results, [null, null, null]);
  assert.equal(questions, 1);
  assert.deepEqual((await readdir(path.dirname(base))).sort(), ['Full']); // no "Full 2"
  splitter.resetDecline();
  await splitter.allocate('d');
  assert.equal(questions, 2);
});

test('scheduler: videos go to numbered folders, other files stay in the base', async () => {
  const srv = await startServer({ body: Buffer.alloc(20_000, 1) });
  const dir = await mkdtemp(path.join(root, 'c-'));
  const base = path.join(dir, 'Trip');
  try {
    const list = new DownloadList({ file: path.join(dir, 'list.json') });
    const splitter = new FolderSplitter(async () => true);
    splitter.configure({ enabled: true, base, limit: 2 });
    const sched = new Scheduler(list, { maxConcurrent: 2 }, { folders: splitter });
    const names = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4', 'readme.txt'];
    list.addPackage({ directory: base, links: names.map((n) => ({ url: srv.url(`/${n}`) })) });
    sched.start();
    const links = [...list.links()];
    while (!links.every((l) => l.state === LinkState.COMPLETED)) await new Promise((r) => setTimeout(r, 20));
    await sched.close();

    const count = async (f) => (await readdir(f)).filter((n) => n.endsWith('.mp4')).length;
    assert.equal(await count(base), 2);
    assert.equal(await count(`${base} 2`), 2);
    assert.equal(await count(`${base} 3`), 1);
    assert.ok((await readdir(base)).includes('readme.txt') || (await readdir(`${base} 2`)).includes('readme.txt'));
  } finally {
    await srv.close();
  }
});

test('scheduler: "not now" keeps the video queued and stops starting new ones', async () => {
  const srv = await startServer({ body: Buffer.alloc(20_000, 1) });
  const dir = await mkdtemp(path.join(root, 'c-'));
  const base = path.join(dir, 'Full');
  try {
    await videos(base, 1);
    const list = new DownloadList({ file: path.join(dir, 'list.json') });
    const splitter = new FolderSplitter(async () => false);
    splitter.configure({ enabled: true, base, limit: 1 });
    const sched = new Scheduler(list, {}, { folders: splitter });
    const notices = [];
    sched.on('notice', (m) => notices.push(m));
    const pkg = list.addPackage({ directory: base, links: [{ url: srv.url('/new.mp4') }] });
    sched.start();
    while (sched.running) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pkg.links[0].state, LinkState.QUEUED);
    assert.equal(notices.length, 1);
    await sched.close();
  } finally {
    await srv.close();
  }
});
