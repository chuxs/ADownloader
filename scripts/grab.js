#!/usr/bin/env node
// Try the link grabber from the terminal:
//   npm run grab -- "<url or text with links>"                 list what was found
//   npm run grab -- "<url>" --download "C:/Users/me/Downloads"  ...and download it all
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { DownloadList, LinkState } from '../src/core/DownloadList.js';
import { Scheduler } from '../src/core/Scheduler.js';
import { LinkGrabber } from '../src/grabber/LinkGrabber.js';
import { PluginRegistry } from '../src/plugins/PluginRegistry.js';
import { Tools } from '../src/tools/Tools.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { download: { type: 'string', short: 'd' } },
});
if (!positionals.length) {
  console.error('Usage: npm run grab -- "<url>" [--download <folder>]');
  process.exit(2);
}

const tmp = await mkdtemp(path.join(tmpdir(), 'adl-grab-'));
// Same tools folder as the app (Electron's userData on Windows is %APPDATA%\adownloader).
const tools = new Tools(path.join(process.env.APPDATA ?? path.join(homedir(), '.config'), 'adownloader', 'tools'));
await tools.refresh();
if (!tools.ytdlp) {
  console.log('Installing yt-dlp for video sites...');
  await tools.installYtDlp().catch((err) => console.log(`(yt-dlp not available: ${err.message})`));
}
const registry = PluginRegistry.withBuiltins(tools);
const list = new DownloadList({ file: path.join(tmp, 'list.json') });
const grabber = new LinkGrabber({ registry, list, defaultDirectory: values.download ?? process.cwd() });

console.log('Looking for files...');
await grabber.add(positionals.join(' '));
while (grabber.busy) await new Promise((r) => setTimeout(r, 50));

for (const pkg of grabber.packages) {
  console.log(`\n📦 ${pkg.name}`);
  for (const l of pkg.links) {
    const size = l.size != null ? ` (${l.sizeApprox ? '~' : ''}${(l.size / 1024 / 1024).toFixed(1)} MB)` : '';
    const status = l.status === 'offline' ? `  ✗ ${l.error}` : '';
    console.log(`   ${l.status === 'offline' ? '✗' : '✓'} ${l.name ?? l.url}${size}${status}`);
  }
}

if (values.download) {
  const created = grabber.confirm();
  if (created.length) {
    const sched = new Scheduler(list, {}, { plugins: registry });
    sched.start();
    const links = created.flatMap((p) => p.links);
    const done = (l) => l.state === LinkState.COMPLETED || l.state === LinkState.FAILED;
    while (!links.every(done)) {
      const got = links.reduce((s, l) => s + l.downloaded, 0);
      process.stdout.write(`\rDownloading ${links.filter(done).length}/${links.length} files, ${(got / 1024 / 1024).toFixed(1)} MB   `);
      await new Promise((r) => setTimeout(r, 250));
    }
    await sched.close();
    console.log('\n');
    for (const l of links) console.log(l.state === LinkState.COMPLETED ? `✓ ${l.filePath}` : `✗ ${l.name}: ${l.error?.message}`);
  }
}
await rm(tmp, { recursive: true, force: true });
