import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DownloadList, LinkState } from '../src/core/DownloadList.js';
import { Scheduler } from '../src/core/Scheduler.js';
import { startServer } from './helpers/server.js';

const KB = 1024;
const engine = { minChunkSize: 128 * KB, writeBufferSize: 64 * KB, retryDelayMs: 10, saveIntervalMs: 50, progressIntervalMs: 50 };
let root;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adl-sched-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup(serverOpts = {}, settings = {}) {
  const srv = await startServer({ body: Buffer.alloc(600 * KB, 7), ...serverOpts });
  const dir = await mkdtemp(path.join(root, 'case-'));
  const listFile = path.join(dir, 'downloadlist.json');
  const list = new DownloadList({ file: listFile, saveDelayMs: 20 });
  const sched = new Scheduler(list, { connections: 2, ...settings }, { engine });
  const addFiles = (names, extra = {}) =>
    list.addPackage({ directory: path.join(dir, 'out'), links: names.map((n) => ({ url: srv.url(`/${n}`) })), ...extra });
  return { srv, dir, listFile, list, sched, addFiles };
}

function states(list) {
  return [...list.links()].map((l) => l.state);
}

async function waitFor(cond, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('downloads every link and never runs more than maxConcurrent', async () => {
  const { srv, dir, list, sched, addFiles } = await setup({ chunkDelayMs: 2 }, { maxConcurrent: 2 });
  try {
    addFiles(['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin']);
    let maxSeen = 0;
    list.on('changed', () => (maxSeen = Math.max(maxSeen, sched.activeIds.length)));
    sched.start();
    await waitFor(() => states(list).every((s) => s === LinkState.COMPLETED));
    assert.equal(maxSeen, 2);
    const files = (await readdir(path.join(dir, 'out'))).sort();
    assert.deepEqual(files, ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin']);
    assert.deepEqual(await readFile(path.join(dir, 'out', 'c.bin')), srv.state.body);
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('higher priority starts first', async () => {
  const { srv, list, sched, addFiles } = await setup({}, { maxConcurrent: 1 });
  try {
    const pkg = addFiles(['a.bin', 'b.bin', 'c.bin']);
    list.updateLink(pkg.links[2].id, { priority: 2 });
    const started = [];
    list.on('changed', (l) => {
      if (l.state === LinkState.DOWNLOADING && !started.includes(l.url)) started.push(l.url);
    });
    sched.start();
    await waitFor(() => states(list).every((s) => s === LinkState.COMPLETED));
    assert.deepEqual(
      started.map((u) => u.split('/').at(-1)),
      ['c.bin', 'a.bin', 'b.bin'],
    );
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('respects the per-host limit', async () => {
  const { srv, list, sched, addFiles } = await setup({ chunkDelayMs: 2 }, { maxConcurrent: 3, maxPerHost: 1 });
  try {
    addFiles(['a.bin', 'b.bin', 'c.bin']);
    let maxSeen = 0;
    list.on('changed', () => (maxSeen = Math.max(maxSeen, sched.activeIds.length)));
    sched.start();
    await waitFor(() => states(list).every((s) => s === LinkState.COMPLETED));
    assert.equal(maxSeen, 1);
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('stop, app restart, start: downloads resume where they were', async () => {
  const { srv, dir, listFile, list, sched, addFiles } = await setup({ chunkDelayMs: 40 }, { maxConcurrent: 2 });
  try {
    addFiles(['a.bin', 'b.bin']);
    sched.start();
    await waitFor(() => [...list.links()].some((l) => l.downloaded > 128 * KB));
    await sched.close();
    const progress = [...list.links()].map((l) => l.downloaded);
    assert.ok(progress.some((p) => p > 0));
    assert.deepEqual(states(list), [LinkState.QUEUED, LinkState.QUEUED]);

    // "Restart": a new list and scheduler read the saved file.
    const list2 = new DownloadList({ file: listFile, saveDelayMs: 20 });
    await list2.load();
    assert.deepEqual(
      [...list2.links()].map((l) => l.downloaded),
      progress,
    );
    const sched2 = new Scheduler(list2, { connections: 2 }, { engine });
    sched2.start();
    await waitFor(() => states(list2).every((s) => s === LinkState.COMPLETED));
    await sched2.close();
    assert.deepEqual(await readFile(path.join(dir, 'out', 'a.bin')), srv.state.body);
    assert.deepEqual(await readFile(path.join(dir, 'out', 'b.bin')), srv.state.body);
  } finally {
    await srv.close();
  }
});

test('a crash while downloading leaves links queued on next load', async () => {
  const { srv, listFile, list, sched, addFiles } = await setup({ chunkDelayMs: 10 });
  try {
    addFiles(['a.bin']);
    sched.start();
    await waitFor(() => [...list.links()][0].state === LinkState.DOWNLOADING);
    await list.save(); // saved mid-download, as if the app died right after
    const list2 = new DownloadList({ file: listFile });
    await list2.load();
    assert.equal([...list2.links()][0].state, LinkState.QUEUED);
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('pause and resume a single link', async () => {
  const { srv, list, sched, addFiles } = await setup({ chunkDelayMs: 10 });
  try {
    const pkg = addFiles(['a.bin', 'b.bin']);
    const [a, b] = pkg.links;
    sched.start();
    await waitFor(() => a.state === LinkState.DOWNLOADING);
    await sched.pause([a.id]);
    assert.equal(a.state, LinkState.PAUSED);
    await waitFor(() => b.state === LinkState.COMPLETED);
    assert.equal(a.state, LinkState.PAUSED); // stays paused
    sched.resume([a.id]);
    await waitFor(() => a.state === LinkState.COMPLETED);
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('temporary failures wait and retry automatically', async () => {
  // Every data request fails 4 times; the engine gives up after 1 retry, the scheduler retries later.
  const { srv, list, sched, addFiles } = await setup({ failFirst: 4 }, { autoRetries: 5, autoRetryDelayMs: 30 });
  sched.engineOptions = { ...engine, maxRetries: 1 };
  try {
    const pkg = addFiles(['a.bin']);
    const seen = new Set();
    list.on('changed', (l) => seen.add(l.state));
    sched.start();
    await waitFor(() => pkg.links[0].state === LinkState.COMPLETED);
    assert.ok(seen.has(LinkState.WAITING));
    assert.ok(pkg.links[0].retries >= 1);
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('gives up after the automatic retries are used', async () => {
  const { srv, sched, addFiles } = await setup({ failFirst: 1000 }, { autoRetries: 1, autoRetryDelayMs: 10 });
  sched.engineOptions = { ...engine, maxRetries: 0 };
  try {
    const pkg = addFiles(['a.bin']);
    sched.start();
    await waitFor(() => pkg.links[0].state === LinkState.FAILED);
    assert.equal(pkg.links[0].error.code, 'HTTP_STATUS');
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('force start works while the scheduler is stopped', async () => {
  const { srv, sched, addFiles } = await setup();
  try {
    const pkg = addFiles(['a.bin', 'b.bin']);
    sched.forceStart([pkg.links[1].id]);
    await waitFor(() => pkg.links[1].state === LinkState.COMPLETED);
    assert.equal(pkg.links[0].state, LinkState.QUEUED);
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('remove deletes partial files; finished files only when asked', async () => {
  const { srv, dir, list, sched, addFiles } = await setup({ chunkDelayMs: 40 });
  try {
    const out = path.join(dir, 'out');
    const pkg = addFiles(['done.bin', 'partial.bin'], { name: 'Mixed' });
    const [done, partial] = pkg.links;
    sched.forceStart([done.id]);
    await waitFor(() => done.state === LinkState.COMPLETED);
    sched.forceStart([partial.id]);
    await waitFor(() => partial.downloaded > 64 * KB);

    await sched.remove([partial.id]);
    assert.deepEqual(await readdir(out), ['done.bin']);
    await sched.remove([done.id]);
    assert.deepEqual(await readdir(out), ['done.bin']); // kept by default
    assert.equal(list.packages.length, 0);
  } finally {
    await sched.close();
    await srv.close();
  }
});

test('reset downloads a link again from zero', async () => {
  const { srv, sched, addFiles } = await setup();
  try {
    const pkg = addFiles(['a.bin']);
    const link = pkg.links[0];
    sched.start();
    await waitFor(() => link.state === LinkState.COMPLETED);
    const before = srv.state.bytesSent;
    await sched.reset([link.id]);
    await waitFor(() => link.state === LinkState.COMPLETED);
    assert.ok(srv.state.bytesSent - before >= srv.state.body.length);
  } finally {
    await sched.close();
    await srv.close();
  }
});
