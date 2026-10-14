import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * Local file server for tests.
 * @param {object} [o]
 * @param {Buffer} [o.body]
 * @param {boolean} [o.ranges] honour Range requests (default true)
 * @param {string} [o.etag]
 * @param {string} [o.disposition] Content-Disposition header
 * @param {number} [o.failFirst] answer the first N data requests with 503
 * @param {number} [o.chunkDelayMs] delay between 64KB writes (slow server)
 * @param {number} [o.cutAfter] close every data response after this many bytes
 * @param {number} [o.maxConnections] answer 429 when more data connections than this are open
 */
export async function startServer(o = {}) {
  const state = {
    body: o.body ?? randomBytes(5 * 1024 * 1024 + 123),
    etag: o.etag,
    requests: 0,
    rangeRequests: 0,
    bytesSent: 0,
    active: 0,
    maxActive: 0,
    failures: o.failFirst ?? 0,
  };

  const server = createServer(async (req, res) => {
    state.requests++;
    const body = state.body;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const isProbe = req.headers.range === 'bytes=0-0';

    if (!isProbe && o.maxConnections && state.active >= o.maxConnections) {
      res.writeHead(429).end();
      return;
    }
    if (!isProbe && state.failures > 0) {
      state.failures--;
      res.writeHead(503).end();
      return;
    }

    const headers = { 'Content-Type': 'application/octet-stream' };
    if (state.etag) headers.ETag = state.etag;
    if (o.disposition) headers['Content-Disposition'] = o.disposition;

    let start = 0;
    let end = body.length - 1;
    const ifRange = req.headers['if-range'];
    const honour = o.ranges !== false && range && (!ifRange || ifRange === state.etag);
    if (honour) {
      state.rangeRequests++;
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      headers['Accept-Ranges'] = 'bytes';
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
    } else {
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
    }

    if (!isProbe) {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
    }
    let closed = false;
    res.on('close', () => {
      closed = true;
      if (!isProbe) state.active--;
    });

    let sent = 0;
    for (let pos = start; pos <= end && !closed; pos += 64 * 1024) {
      const piece = body.subarray(pos, Math.min(pos + 64 * 1024, end + 1));
      if (o.cutAfter != null && !isProbe && sent + piece.length > o.cutAfter) {
        res.write(piece.subarray(0, o.cutAfter - sent));
        res.socket.destroy();
        return;
      }
      sent += piece.length;
      state.bytesSent += piece.length;
      if (!res.write(piece)) await new Promise((r) => res.once('drain', r));
      if (o.chunkDelayMs) await new Promise((r) => setTimeout(r, o.chunkDelayMs));
    }
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state,
    url: (p = '/file.bin') => `http://127.0.0.1:${port}${p}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
