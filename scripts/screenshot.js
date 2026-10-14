// Developer tool: run the app with sample data and live downloads from a local
// test server, save a screenshot of each tab, then exit.
//   node scripts/screenshot.js <output folder>
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';

import { DownloadList } from '../src/core/DownloadList.js';
import { run, which } from '../src/tools/process.js';
import { startServer } from '../test/helpers/server.js';

const outDir = path.resolve(process.argv[2] ?? 'screenshots');
const mode = process.argv[3] ?? 'tabs'; // 'tabs' or 'split' (numbered video folders)
const MB = 1024 * 1024;

const srv = await startServer({ body: Buffer.alloc(150 * MB, 1), chunkDelayMs: 15 });
const userData = await mkdtemp(path.join(tmpdir(), 'adl-shot-'));
const downloads = path.join(userData, 'out');

if (mode === 'split') {
  // "Trip" already holds 3 of 3 videos; one more video is queued for it.
  const trip = path.join(downloads, 'Trip');
  await mkdir(trip, { recursive: true });
  for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) await writeFile(path.join(trip, n), 'x');
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({ downloadDir: downloads, startOnLaunch: true, useYtDlp: false, splitFolders: true, splitFolderBase: trip, splitFolderLimit: 3 }),
  );
  const list = new DownloadList({ file: path.join(userData, 'downloadlist.json') });
  list.addPackage({ name: 'Trip videos', directory: trip, links: [{ url: srv.url('/Day 4 - Beach.mp4') }, { url: srv.url('/Day 5 - Hike.mp4') }] });
  await list.save();
  await launch();
  const { readdir } = await import('node:fs/promises');
  console.log('folders:', (await readdir(downloads)).join(', '));
  console.log('Trip 2:', (await readdir(path.join(downloads, 'Trip 2')).catch(() => [])).join(', '));
  await srv.close();
  await rm(userData, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

await writeFile(
  path.join(userData, 'settings.json'),
  JSON.stringify({ downloadDir: downloads, startOnLaunch: true, maxConcurrent: 2, connections: 4, useYtDlp: false }),
);

// Sample download list: one package downloading, one finished, one with a failure.
const list = new DownloadList({ file: path.join(userData, 'downloadlist.json') });
const movie = list.addPackage({
  name: 'Ubuntu 26.04 Desktop',
  directory: downloads,
  links: [{ url: srv.url('/ubuntu-26.04-desktop-amd64.iso') }, { url: srv.url('/ubuntu-26.04-desktop-amd64.iso.sha256') }],
});
const music = list.addPackage({
  name: 'Podcast Archive',
  directory: downloads,
  links: [{ url: srv.url('/episode-101.mp3') }, { url: srv.url('/episode-102.mp3') }, { url: srv.url('/episode-103.mp3') }],
});
for (const l of music.links) {
  list.updateLink(l.id, { state: 'completed', size: 48 * MB + 1234, downloaded: 48 * MB + 1234, filePath: path.join(downloads, l.name) });
}
const archive = list.addPackage({
  name: 'Game Mods',
  directory: downloads,
  links: [{ url: srv.url('/mods.part1.rar') }, { url: srv.url('/mods.part2.rar') }],
});
for (const l of archive.links) {
  list.updateLink(l.id, { state: 'completed', size: 95 * MB, downloaded: 95 * MB, filePath: path.join(downloads, l.name) });
}
list.updateLink(archive.links[0].id, { extraction: { state: 'done', progress: 100, error: null } });

// Finished videos with thumbnails (test pictures made by ffmpeg, if installed).
const thumbDir = path.join(userData, 'thumbnails');
await mkdir(thumbDir, { recursive: true });
const ffmpeg = await which('ffmpeg');
const pictures = ['testsrc2', 'smptebars', 'mandelbrot', 'rgbtestsrc'];
if (ffmpeg) {
  for (const p of pictures) {
    await run(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', `${p}=size=640x360`, '-frames:v', '1', path.join(thumbDir, `demo-${p}.jpg`)]);
  }
}
const videos = list.addPackage({
  name: 'Travel Vlog',
  directory: downloads,
  links: ['Day 1 - Arrival.mp4', 'Day 2 - Mountains.mp4', 'Day 3 - City at night.mp4'].map((name) => ({
    url: srv.url(`/${encodeURIComponent(name)}`),
  })),
});
videos.links.forEach((l, i) => {
  list.updateLink(l.id, {
    state: 'completed',
    size: (210 + i * 37) * MB,
    downloaded: (210 + i * 37) * MB,
    filePath: path.join(downloads, l.name),
    thumbKey: ffmpeg ? `demo-${pictures[i]}.jpg` : null,
  });
});
const tools = list.addPackage({
  name: 'Dev Tools',
  directory: downloads,
  links: [{ url: srv.url('/node-v24-x64.msi') }, { url: 'http://127.0.0.1:1/missing/setup.exe' }],
});
list.updateLink(tools.links[1].id, {
  state: 'failed',
  error: { code: 'HTTP_STATUS', message: 'Server responded 404 Not Found' },
});
void movie;
await list.save();

await writeFile(
  path.join(userData, 'linkgrabber.json'),
  JSON.stringify({
    version: 1,
    packages: [
      {
        id: 'g1',
        name: 'Holiday Videos',
        directory: downloads,
        links: [
          { id: 'a', packageId: 'g1', url: 'https://example.com/media/beach.mp4', name: 'beach.mp4', size: 734 * MB, status: 'online', pluginId: 'directhttp', thumbKey: ffmpeg ? 'demo-rgbtestsrc.jpg' : null },
          { id: 'b', packageId: 'g1', url: 'https://example.com/media/sunset.mp4', name: 'sunset.mp4', size: 512 * MB, status: 'online', pluginId: 'directhttp' },
          { id: 'c', packageId: 'g1', url: 'https://example.com/media/old.mp4', name: 'old.mp4', size: null, status: 'offline', error: 'Server responded 404', pluginId: 'directhttp' },
        ],
      },
      {
        id: 'g2',
        name: '7-Zip',
        directory: downloads,
        links: [{ id: 'd', packageId: 'g2', url: 'https://www.7-zip.org/a/7z2604-x64.exe', name: '7z2604-x64.exe', size: 1.6 * MB, status: 'online', pluginId: 'directhttp' }],
      },
    ],
  }),
);

const code = await launch();
await srv.close();
await rm(userData, { recursive: true, force: true }).catch(() => {});
console.log(`Screenshots in ${outDir} (exit ${code})`);

function launch() {
  const env = { ...process.env, ADL_USER_DATA: userData, ADL_SCREENSHOT_DIR: outDir, ADL_SCREENSHOT_MODE: mode };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ['.'], { stdio: 'inherit', env });
  return new Promise((r) => child.on('exit', r));
}
