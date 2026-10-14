import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Page } from '../src/plugins/Browser.js';
import { dropbox, googleDrive, mediafire, parseSize } from '../src/plugins/builtin/filehosts.js';
import { findFilesInPage } from '../src/plugins/builtin/genericpage.js';
import { videoSize } from '../src/plugins/builtin/ytdlp.js';
import { PluginRegistry } from '../src/plugins/PluginRegistry.js';

/** Plugin context whose browser returns fixed pages. */
function fakeCtx(pages) {
  return {
    signal: undefined,
    log: () => {},
    http: {
      async get(url) {
        const p = pages[url];
        if (!p) throw new Error(`unexpected request ${url}`);
        return new Page(p.url ?? url, p.status ?? 200, new Headers(), p.text);
      },
    },
  };
}

test('URLs go to the right plugin', () => {
  const r = PluginRegistry.withBuiltins();
  const id = (u) => r.match(u)?.id ?? null;
  assert.equal(id('https://www.dropbox.com/scl/fi/abc123/file.zip?rlkey=x&dl=0'), 'dropbox.com');
  assert.equal(id('https://drive.google.com/file/d/1AbC-dEf_/view?usp=sharing'), 'drive.google.com');
  assert.equal(id('https://drive.google.com/open?id=1AbC'), 'drive.google.com');
  assert.equal(id('https://www.mediafire.com/file/abc123xyz/setup.exe/file'), 'mediafire.com');
  assert.equal(id('https://cdn.example.com/live/stream.m3u8?token=1'), 'hls');
  assert.equal(id('https://example.com/file.zip'), null);
});

test('Dropbox: switches the link to direct download', () => {
  assert.equal(
    dropbox.directUrl('https://www.dropbox.com/scl/fi/abc/f.zip?rlkey=k&dl=0'),
    'https://www.dropbox.com/scl/fi/abc/f.zip?rlkey=k&dl=1',
  );
});

test('Google Drive: reads the file id from every link style', () => {
  assert.equal(googleDrive.fileId('https://drive.google.com/file/d/1AbC-dEf_/view'), '1AbC-dEf_');
  assert.equal(googleDrive.fileId('https://drive.google.com/uc?export=download&id=XYZ'), 'XYZ');
});

test('MediaFire: finds the download button, name and size', async () => {
  const url = 'https://www.mediafire.com/file/abc123/tool.zip/file';
  const ctx = fakeCtx({
    [url]: {
      text: `<html><head><title>tool.zip - MediaFire</title></head><body>
        <div class="filename">tool.zip</div>
        <a class="input popsok" aria-label="Download file" href="https://download1234.mediafire.com/xyz/abc123/tool.zip" id="downloadButton" rel="nofollow">
          Download (12.5MB)</a></body></html>`,
    },
  });
  const r = await mediafire.resolve({ url }, ctx);
  assert.equal(r.url, 'https://download1234.mediafire.com/xyz/abc123/tool.zip');
  const c = await mediafire.check({ url }, ctx);
  assert.deepEqual(c, { available: true, name: 'tool.zip', size: parseSize('12.5MB') });
});

test('MediaFire: decodes the scrambled download URL on newer pages', async () => {
  const url = 'https://www.mediafire.com/file/def456/a.rar/file';
  const direct = 'https://download9.mediafire.com/q/def456/a.rar';
  const ctx = fakeCtx({
    [url]: {
      text: `<a id="downloadButton" href="javascript:void(0)" data-scrambled-url="${Buffer.from(direct).toString('base64')}">Download (1 GB)</a>`,
    },
  });
  assert.equal((await mediafire.resolve({ url }, ctx)).url, direct);
});

test('MediaFire: a removed file is reported offline', async () => {
  const url = 'https://www.mediafire.com/file/gone/x.zip/file';
  const ctx = fakeCtx({ [url]: { url: 'https://www.mediafire.com/error.php?errno=320', text: 'File Removed' } });
  await assert.rejects(mediafire.check({ url }, ctx), (e) => e.code === 'OFFLINE');
});

test('video size: exact when known, otherwise estimated from bitrate x duration', () => {
  assert.deepEqual(videoSize({ requested_formats: [{ filesize: 1000 }, { filesize: 500 }] }), { size: 1500, sizeApprox: false });
  // Stream formats without sizes: 2000 kbit/s for 60 s = 15 MB (approx).
  assert.deepEqual(videoSize({ duration: 60, requested_formats: [{ tbr: 1800 }, { abr: 200 }] }), {
    size: 15_000_000,
    sizeApprox: true,
  });
  assert.deepEqual(videoSize({ filesize_approx: 4242 }), { size: 4242, sizeApprox: true });
  assert.deepEqual(videoSize({ duration: 60 }), { size: null, sizeApprox: false });
});

test('finds stream URLs hidden in page scripts', () => {
  const page = new Page(
    'https://videos.test/watch/1',
    200,
    new Headers(),
    `<html><head><title>Cat Video</title></head><body><script>
      var player = {"sources":[{"src":"https:\\/\\/cdn.videos.test\\/hls\\/1\\/master.m3u8?t=abc\\u0026e=99","type":"hls"}]};
    </script></body></html>`,
  );
  const found = findFilesInPage(page);
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'https://cdn.videos.test/hls/1/master.m3u8?t=abc&e=99');
  assert.equal(found[0].pluginId, 'hls');
  assert.equal(found[0].name, 'Cat Video.mp4');
});
