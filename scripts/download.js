#!/usr/bin/env node
// Try the download engine from the terminal:
//   npm run download -- <url> [folder] [--connections 8] [--limit 2M]
// Ctrl+C pauses; run the same command again to resume.
import { parseArgs } from 'node:util';
import { Download, SpeedLimiter } from '../src/engine/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    connections: { type: 'string', short: 'c', default: '8' },
    limit: { type: 'string', short: 'l' },
  },
});

const [url, directory = process.cwd()] = positionals;
if (!url) {
  console.error('Usage: npm run download -- <url> [folder] [--connections 8] [--limit 2M]');
  process.exit(2);
}

const limiters = values.limit ? [new SpeedLimiter(parseSize(values.limit))] : [];
const dl = new Download({ url, directory, connections: Number(values.connections), limiters });

dl.on('state', (s) => process.stdout.write(`\n[${s}]${dl.filePath ? ' ' + dl.filePath : ''}\n`));
dl.on('retry', ({ attempt, error }) => process.stdout.write(`\nretry #${attempt}: ${error.message}\n`));
dl.on('progress', (i) => {
  const pct = i.size ? ((i.downloaded / i.size) * 100).toFixed(1) + '%' : '';
  const eta = i.eta != null ? ` ETA ${i.eta}s` : '';
  process.stdout.write(
    `\r${pct.padStart(6)} ${fmt(i.downloaded)}/${i.size != null ? fmt(i.size) : '?'}  ${fmt(i.speed)}/s  ${i.connections} conn${eta}      `,
  );
});

process.on('SIGINT', () => dl.pause());

const state = await dl.start();
if (dl.error) console.error(`\n${dl.error.code}: ${dl.error.message}`);
process.exit(state === 'completed' ? 0 : 1);

function fmt(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)/i.exec(s);
  if (!m) throw new Error(`Bad size: ${s}`);
  return Math.round(Number(m[1]) * 1024 ** ' KMG'.indexOf((m[2] || ' ').toUpperCase()));
}
