import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DownloadList, LinkState } from '../src/core/DownloadList.js';
import { archivePart, groupArchives } from '../src/extraction/archives.js';
import { ExtractionManager } from '../src/extraction/ExtractionManager.js';
import { extractArchive } from '../src/extraction/extract.js';
import { Tools } from '../src/tools/Tools.js';
import { run } from '../src/tools/process.js';

let root;
const tools = new Tools(path.join(tmpdir(), 'adl-no-tools'));
await tools.refresh();
const sevenZip = tools.sevenZip;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adl-extract-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('recognizes archive parts', () => {
  assert.deepEqual(archivePart('Movie.part1.rar'), { key: 'movie.partn.rar', base: 'Movie', index: 1 });
  assert.equal(archivePart('Movie.part02.rar').index, 2);
  assert.deepEqual(archivePart('data.7z.001'), { key: 'data.7z.nnn', base: 'data', index: 1 });
  assert.equal(archivePart('data.7z.002').index, 2);
  assert.equal(archivePart('old.rar').index, 1);
  assert.equal(archivePart('old.r00').key, archivePart('old.rar').key);
  assert.equal(archivePart('old.r00').index, 2);
  assert.equal(archivePart('src.tar.gz').base, 'src');
  assert.equal(archivePart('video.mp4'), null);
});

test('groups parts and finds the first one', () => {
  const groups = groupArchives(
    ['a.part2.rar', 'a.part1.rar', 'a.part3.rar', 'b.zip', 'c.7z.002', 'notes.txt'].map((name) => ({ name })),
  );
  const a = groups.find((g) => g.base === 'a');
  assert.equal(a.parts.length, 3);
  assert.equal(a.first.name, 'a.part1.rar');
  assert.equal(groups.find((g) => g.base === 'c').first, undefined); // first part missing
  assert.equal(groups.length, 3);
});

/** Make an archive with 7-Zip: returns the folder holding it and the original files. */
async function makeArchive(name, { password, volumeSize } = {}) {
  const src = await mkdtemp(path.join(root, 'src-'));
  const files = { 'readme.txt': Buffer.from('hello'), 'data/blob.bin': randomBytes(300_000) };
  for (const [rel, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await writeFile(path.join(src, rel), data);
  }
  const out = await mkdtemp(path.join(root, 'arc-'));
  const args = ['a', '-y', path.join(out, name), path.join(src, '*')];
  if (password) args.push(`-p${password}`, '-mhe=on');
  if (volumeSize) args.push(`-v${volumeSize}`);
  await run(sevenZip, args);
  return { dir: out, files };
}

const skip = !sevenZip && '7-Zip not installed';

test('extracts a password-protected archive using the saved passwords', { skip }, async () => {
  const { dir, files } = await makeArchive('secret.7z', { password: 'hunter2' });
  const dest = path.join(dir, 'out');
  const { password } = await extractArchive(tools, {
    archive: path.join(dir, 'secret.7z'),
    destination: dest,
    passwords: ['wrong', 'hunter2'],
  });
  assert.equal(password, 'hunter2');
  assert.deepEqual(await readFile(path.join(dest, 'data', 'blob.bin')), files['data/blob.bin']);
});

test('reports a missing password clearly', { skip }, async () => {
  const { dir } = await makeArchive('locked.7z', { password: 'x' });
  await assert.rejects(
    extractArchive(tools, { archive: path.join(dir, 'locked.7z'), destination: path.join(dir, 'out') }),
    /Password protected/,
  );
});

test('extracts a multi-part archive once every part has finished', { skip }, async () => {
  const { dir, files } = await makeArchive('big.7z', { volumeSize: '100k' });
  const parts = (await readdir(dir)).sort(); // big.7z.001, .002, ...
  assert.ok(parts.length >= 3);

  const list = new DownloadList({ file: path.join(dir, 'list.json') });
  const pkg = list.addPackage({ directory: dir, links: parts.map((p) => ({ url: `http://x.test/${p}` })) });
  const mgr = new ExtractionManager(list, tools, { deleteArchivesAfterExtract: true });

  // Finish all parts but one: nothing happens yet.
  const finish = (l) => list.updateLink(l.id, { state: LinkState.COMPLETED, filePath: path.join(dir, l.name) });
  pkg.links.slice(1).forEach(finish);
  await mgr.idle();
  assert.equal(pkg.links[0].extraction, undefined);

  finish(pkg.links[0]);
  await mgr.idle();
  assert.equal(pkg.links[0].extraction.state, 'done', pkg.links[0].extraction.error);
  const dest = path.join(dir, 'big');
  assert.deepEqual(await readFile(path.join(dest, 'readme.txt')), files['readme.txt']);
  assert.deepEqual(await readFile(path.join(dest, 'data', 'blob.bin')), files['data/blob.bin']);
  // Archive parts deleted after extracting.
  assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith('big.7z')), []);
});

test('falls back to tar for a zip when 7-Zip is missing', { skip: !tools.tar && 'tar not installed' }, async () => {
  const src = await mkdtemp(path.join(root, 'zip-'));
  await writeFile(path.join(src, 'a.txt'), 'zip content');
  const zip = path.join(src, 'files.zip');
  await run(tools.tar, ['-a', '-cf', zip, '-C', src, 'a.txt']);
  const dest = path.join(src, 'out');
  await extractArchive({ sevenZip: null, tar: tools.tar }, { archive: zip, destination: dest });
  assert.equal(await readFile(path.join(dest, 'a.txt'), 'utf8'), 'zip content');
});
