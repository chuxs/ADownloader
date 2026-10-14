import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeMap } from '../src/engine/RangeMap.js';
import { parseContentRange } from '../src/engine/Download.js';
import { fileNameFromContentDisposition, sanitizeFileName } from '../src/engine/filename.js';

test('RangeMap merges overlapping and touching ranges', () => {
  const m = new RangeMap();
  m.add(10, 20);
  m.add(30, 40);
  m.add(20, 30);
  assert.deepEqual(m.toJSON(), [[10, 40]]);
  m.add(0, 5);
  m.add(3, 12);
  assert.deepEqual(m.toJSON(), [[0, 40]]);
  assert.equal(m.covered, 40);
});

test('RangeMap reports missing gaps', () => {
  const m = new RangeMap([
    [0, 10],
    [20, 30],
  ]);
  assert.deepEqual(m.missing(50), [
    [10, 20],
    [30, 50],
  ]);
  assert.equal(m.isComplete(30), false);
  m.add(10, 20);
  assert.equal(m.isComplete(30), true);
});

test('parseContentRange', () => {
  assert.deepEqual(parseContentRange('bytes 0-0/1234'), { start: 0, end: 0, total: 1234 });
  assert.deepEqual(parseContentRange('bytes 5-9/*'), { start: 5, end: 9, total: null });
  assert.deepEqual(parseContentRange('bytes */0'), { start: null, end: null, total: 0 });
  assert.equal(parseContentRange('garbage'), null);
});

test('Content-Disposition parsing', () => {
  assert.equal(fileNameFromContentDisposition('attachment; filename="a b.zip"'), 'a b.zip');
  assert.equal(fileNameFromContentDisposition('attachment; filename=plain.txt'), 'plain.txt');
  assert.equal(
    fileNameFromContentDisposition(`attachment; filename="x.bin"; filename*=UTF-8''%C3%A9t%C3%A9.mp4`),
    'été.mp4',
  );
});

test('sanitizeFileName makes Windows-safe names', () => {
  assert.equal(sanitizeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('name. . '), 'name');
  assert.equal(sanitizeFileName(''), 'download');
});
