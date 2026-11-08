'use strict';
// Byte compare: next and previous difference, sizes that differ, identical files, a 4 GB sparse pair, cancel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HexDocument } = require('../src/core/doc');
const { findDiff, diffStats, CHUNK } = require('../src/core/compare');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexv-cmp-'));
const big = path.join(os.homedir(), 'hex-viewer-work', 'cmp-' + process.pid);
fs.mkdirSync(big, { recursive: true });
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(big, { recursive: true, force: true }); });
const mem = b => HexDocument.fromBytes(Uint8Array.from(b), null);

test('next and previous difference, areas, and a chunk edge', async () => {
  const n = 3 * CHUNK + 10;
  const a = Buffer.alloc(n, 1), b = Buffer.alloc(n, 1);
  b[5] = 2; b[6] = 2; b[CHUNK - 1] = 9; b[CHUNK] = 9; b[n - 1] = 0;
  const A = mem(a), B = mem(b);
  assert.equal((await findDiff(A, B, 0, false)).offset, 5);
  assert.equal((await findDiff(A, B, 7, false)).offset, CHUNK - 1);
  assert.equal((await findDiff(A, B, CHUNK + 1, false)).offset, n - 1);
  assert.equal((await findDiff(A, B, n, false)).offset, -1);
  assert.equal((await findDiff(A, B, n - 2, true)).offset, CHUNK);
  assert.equal((await findDiff(A, B, 4, true)).offset, -1);
  const s = await diffStats(A, B);
  assert.equal(s.bytes, 5); assert.equal(s.runs, 3); assert.equal(s.first, 5); assert.equal(s.last, n - 1); assert.equal(s.identical, false);
  assert.ok(s.map.some(Boolean));
});

test('sizes differ: the tail counts as one differing area; identical and empty files', async () => {
  const A = mem([1, 2, 3, 4, 5, 6]), B = mem([1, 2, 3]);
  assert.equal((await findDiff(A, B, 0, false)).offset, 3);
  assert.equal((await findDiff(A, B, 5, true)).offset, 5);
  assert.equal((await findDiff(B, A, 99, true)).offset, 5);
  const s = await diffStats(A, B);
  assert.deepEqual([s.bytes, s.runs, s.first, s.last], [3, 1, 3, 5]);
  const s2 = await diffStats(mem([7, 7]), mem([7, 7]));
  assert.equal(s2.identical, true); assert.equal(s2.first, -1);
  const s3 = await diffStats(mem([]), mem([]));
  assert.equal(s3.identical, true);
  assert.equal((await findDiff(mem([]), mem([1]), 0, false)).offset, 0);
});

test('4 GB sparse pair: finds the one differing byte near the end and counts it; cancel stops a scan', async () => {
  const size = 4 * 1024 ** 3 + 5;
  const fa = path.join(big, 'a.bin'), fb = path.join(big, 'b.bin');
  for (const f of [fa, fb]) { const h = fs.openSync(f, 'w'); fs.ftruncateSync(h, size); fs.closeSync(h); }
  const h = fs.openSync(fb, 'r+'); fs.writeSync(h, Buffer.from([0x42]), 0, 1, size - 3); fs.closeSync(h);
  const A = await HexDocument.openFile(fa), B = await HexDocument.openFile(fb);
  let t0 = Date.now();
  const r = await findDiff(A, B, 0, false);
  assert.equal(r.offset, size - 3);
  const fwdMs = Date.now() - t0;
  assert.equal((await findDiff(A, B, size - 1, true)).offset, size - 3, 'backward from the end');
  let stop = false; setTimeout(() => { stop = true; }, 200);
  t0 = Date.now();
  const c = await diffStats(A, B, () => stop);
  assert.equal(c.cancelled, true);
  assert.ok(Date.now() - t0 < 2000, 'cancel takes effect quickly');
  console.log(`# 4 GB forward scan to the last difference: ${fwdMs} ms`);
  await A.dispose(); await B.dispose();
  fs.rmSync(fa); fs.rmSync(fb);
});

test('compare panel message checks', () => {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? {} : orig.call(this, req, ...rest); };
  const { validate } = require('../src/compare.js');
  Module._load = orig;
  assert.equal(validate({ type: 'read', offset: -1, length: 5 }), null);
  assert.equal(validate({ type: 'read', offset: 0, length: 2 << 20 }), null);
  assert.equal(validate({ type: 'diff', from: 1.5, id: 1 }), null);
  assert.deepEqual(validate({ type: 'diff', from: 3, id: 2, backward: 1 }), { type: 'diff', from: 3, backward: true, id: 2 });
  assert.equal(validate({ type: 'nope' }), null);
  assert.equal(validate(null), null);
});
