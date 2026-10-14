import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Download, DownloadState, SpeedLimiter } from '../src/engine/index.js';
import { startServer } from './helpers/server.js';

const KB = 1024;
let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'adl-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freshDir() {
  return mkdtemp(path.join(dir, 'case-'));
}

/** Small chunks so a 5MB test file really splits across connections. */
const fast = { minChunkSize: 256 * KB, writeBufferSize: 128 * KB, retryDelayMs: 10 };

test('downloads over several connections and the file is byte-identical', async () => {
  const srv = await startServer();
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url(), directory: d, connections: 4, ...fast });
    assert.equal(await dl.start(), DownloadState.COMPLETED);
    assert.deepEqual(await readFile(dl.filePath), srv.state.body);
    assert.ok(srv.state.maxActive > 1, `expected parallel connections, got ${srv.state.maxActive}`);
    assert.equal(dl.info.resumable, true);
    assert.deepEqual(await readdir(d), ['file.bin']); // no .part / .part.json left behind
  } finally {
    await srv.close();
  }
});

test('falls back to one connection when the server has no range support', async () => {
  const srv = await startServer({ ranges: false });
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url(), directory: d, connections: 4, ...fast });
    assert.equal(await dl.start(), DownloadState.COMPLETED);
    assert.deepEqual(await readFile(dl.filePath), srv.state.body);
    assert.equal(srv.state.maxActive, 1);
    assert.equal(dl.info.resumable, false);
  } finally {
    await srv.close();
  }
});

test('pause keeps progress and a new Download resumes from it', async () => {
  const srv = await startServer({ chunkDelayMs: 5 });
  const d = await freshDir();
  try {
    const first = new Download({ url: srv.url(), directory: d, connections: 3, ...fast, saveIntervalMs: 50 });
    first.start();
    await waitFor(() => first.info.downloaded > 1024 * KB);
    await first.pause();
    assert.equal(first.state, DownloadState.PAUSED);
    const doneBefore = first.info.downloaded;
    assert.ok((await readdir(d)).includes('file.bin.part.json'));

    // Simulates an app restart: only the saved file path is known.
    const second = new Download({ url: srv.url(), filePath: first.filePath, connections: 3, ...fast });
    let resumedFrom = null;
    second.on('state', (s) => {
      if (s === DownloadState.DOWNLOADING && resumedFrom == null) resumedFrom = second.info.downloaded;
    });
    assert.equal(await second.start(), DownloadState.COMPLETED);
    assert.equal(resumedFrom, doneBefore);
    assert.deepEqual(await readFile(second.filePath), srv.state.body);
  } finally {
    await srv.close();
  }
});

test('retries temporary server errors', async () => {
  const srv = await startServer({ failFirst: 3 });
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url(), directory: d, connections: 2, ...fast });
    const retries = [];
    dl.on('retry', (r) => retries.push(r.error.code));
    assert.equal(await dl.start(), DownloadState.COMPLETED);
    assert.ok(retries.length >= 3);
    assert.ok(retries.every((c) => c === 'HTTP_STATUS'));
    assert.deepEqual(await readFile(dl.filePath), srv.state.body);
  } finally {
    await srv.close();
  }
});

test('reconnects when the server keeps dropping connections', async () => {
  const srv = await startServer({ cutAfter: 300 * KB });
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url(), directory: d, connections: 2, ...fast });
    assert.equal(await dl.start(), DownloadState.COMPLETED);
    assert.deepEqual(await readFile(dl.filePath), srv.state.body);
  } finally {
    await srv.close();
  }
});

test('uses fewer connections when the server refuses extra ones (429)', async () => {
  const srv = await startServer({ maxConnections: 2, chunkDelayMs: 1 });
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url(), directory: d, connections: 6, ...fast });
    const limits = [];
    dl.on('connections', (n) => limits.push(n));
    assert.equal(await dl.start(), DownloadState.COMPLETED, dl.error?.message);
    assert.deepEqual(await readFile(dl.filePath), srv.state.body);
    assert.ok(limits.length > 0 && limits.at(-1) <= 2, `limits: ${limits}`);
  } finally {
    await srv.close();
  }
});

test('restarts from scratch if the file changed on the server', async () => {
  const srv = await startServer({ etag: '"v1"', chunkDelayMs: 5 });
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url(), directory: d, connections: 2, ...fast });
    dl.start();
    await waitFor(() => dl.info.downloaded > 512 * KB);
    await dl.pause();

    srv.state.body = randomBytes(3 * 1024 * KB);
    srv.state.etag = '"v2"';
    assert.equal(await dl.start(), DownloadState.COMPLETED);
    assert.deepEqual(await readFile(dl.filePath), srv.state.body);
  } finally {
    await srv.close();
  }
});

test('uses the server file name and never overwrites an existing file', async () => {
  const srv = await startServer({ body: randomBytes(10 * KB), disposition: 'attachment; filename="report.pdf"' });
  const d = await freshDir();
  try {
    const a = new Download({ url: srv.url(), directory: d });
    const b = new Download({ url: srv.url(), directory: d });
    await a.start();
    await b.start();
    assert.equal(path.basename(a.filePath), 'report.pdf');
    assert.equal(path.basename(b.filePath), 'report (1).pdf');
  } finally {
    await srv.close();
  }
});

test('verifies the checksum', async () => {
  const srv = await startServer({ body: randomBytes(50 * KB) });
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url(), directory: d, checksum: { algorithm: 'sha256', value: '00' } });
    assert.equal(await dl.start(), DownloadState.FAILED);
    assert.equal(dl.error.code, 'CHECKSUM_MISMATCH');
  } finally {
    await srv.close();
  }
});

test('does not retry a missing file (404)', async () => {
  const server = createServer((req, res) => res.writeHead(404).end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const dl = new Download({
      url: `http://127.0.0.1:${server.address().port}/nope.bin`,
      directory: await freshDir(),
      retryDelayMs: 10,
    });
    let retried = false;
    dl.on('retry', () => (retried = true));
    assert.equal(await dl.start(), DownloadState.FAILED);
    assert.equal(dl.error.status, 404);
    assert.equal(retried, false);
  } finally {
    server.close();
  }
});

test('handles an empty file', async () => {
  const srv = await startServer({ body: Buffer.alloc(0) });
  const d = await freshDir();
  try {
    const dl = new Download({ url: srv.url('/empty.txt'), directory: d });
    assert.equal(await dl.start(), DownloadState.COMPLETED);
    assert.equal((await readFile(dl.filePath)).length, 0);
  } finally {
    await srv.close();
  }
});

test('respects a speed limit', async () => {
  const srv = await startServer({ body: randomBytes(1536 * KB) });
  const d = await freshDir();
  try {
    const limiter = new SpeedLimiter(600 * KB);
    const dl = new Download({ url: srv.url(), directory: d, limiters: [limiter], ...fast });
    const t0 = Date.now();
    assert.equal(await dl.start(), DownloadState.COMPLETED);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 1000, `finished too fast: ${elapsed}ms`);
  } finally {
    await srv.close();
  }
});

async function waitFor(cond, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
