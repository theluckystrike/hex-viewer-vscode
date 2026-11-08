'use strict';
// HexDocument on real files: range reads, edits, undo, save in place, search across 1 MB chunks,
// a 4 GB sparse file, and hostile files (empty, truncated while open, no permission, symlink loop).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HexDocument, CHUNK } = require('../src/core/doc');
const { parsePattern } = require('../src/core/bytes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexv-doc-'));
// Large sparse fixtures go in ~/hex-viewer-work (not the temp folder) and are deleted after the run.
const big = path.join(os.homedir(), 'hex-viewer-work', 'test-' + process.pid);
fs.mkdirSync(big, { recursive: true });
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(big, { recursive: true, force: true }); });
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function rnd(n, seed = 7) { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; }

test('range reads, edits overlay, undo and redo', async () => {
  const f = path.join(tmp, 'a.bin'); fs.writeFileSync(f, rnd(200000));
  const d = await HexDocument.openFile(f);
  assert.equal(d.size, 200000);
  const orig = Buffer.from(await d.read(1000, 16));
  assert.deepEqual(orig, fs.readFileSync(f).subarray(1000, 1016));
  const rec = await d.overwrite(1004, Uint8Array.from([1, 2, 3]));
  const now = await d.read(1000, 16);
  assert.deepEqual([...now.subarray(4, 7)], [1, 2, 3]);
  assert.deepEqual(d.editedIn(0, 2000), [1004, 1005, 1006]);
  d.apply(rec, true);
  assert.deepEqual(Buffer.from(await d.read(1000, 16)), orig);
  assert.deepEqual(d.editedIn(0, 2000), []);
  d.apply(rec, false);
  assert.deepEqual([...(await d.read(1004, 3))], [1, 2, 3]);
  assert.equal(await d.overwrite(1004, Uint8Array.from([1, 2, 3])), null, 'same bytes are not an edit');
  const lastB = (await d.read(199999, 1))[0];
  assert.equal((await d.overwrite(199999, Uint8Array.from([lastB ^ 1, 9]))).after.length, 1, 'overwrite never grows the file');
  assert.equal((await d.read(199990, 100)).length, 10);
  await d.dispose();
});

test('save patches only the edited bytes; sha256 matches a patched copy; undo after save', async () => {
  const f = path.join(tmp, 's.bin'); const data = rnd(3 * CHUNK + 77, 3); fs.writeFileSync(f, data);
  const d = await HexDocument.openFile(f);
  const r1 = await d.overwrite(10, Uint8Array.from([0xaa]));
  await d.overwrite(CHUNK + 5, Uint8Array.from([0xbb, 0xcc]));
  const r3 = await d.overwrite(3 * CHUNK + 76, Uint8Array.from([0xdd]));
  d.apply(r3, true); // undo one of the three
  await d.save();
  const want = Buffer.from(data); want[10] = 0xaa; want[CHUNK + 5] = 0xbb; want[CHUNK + 6] = 0xcc;
  assert.equal(sha(f), crypto.createHash('sha256').update(want).digest('hex'));
  assert.equal(fs.statSync(f).size, data.length);
  // undo after save makes the byte an edit again with the old value
  d.apply(r1, true);
  assert.deepEqual([...(await d.read(10, 1))], [data[10]]);
  assert.deepEqual(d.editedIn(0, 20), [10]);
  const out = path.join(tmp, 'copy.bin');
  await d.saveAsFile(out);
  want[10] = data[10];
  assert.equal(sha(out), crypto.createHash('sha256').update(want).digest('hex'));
  await d.dispose();
});

test('search: forward, backward, wrap, wildcard, ignore case, across a 1 MB chunk edge', async () => {
  const f = path.join(tmp, 'find.bin'); const data = Buffer.alloc(3 * CHUNK + 100, 0x11);
  const pat = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x13, 0x37]);
  const at = [CHUNK - 3, 2 * CHUNK + 10]; // the first one crosses the chunk edge
  for (const o of at) pat.copy(data, o);
  Buffer.from('Hello World').copy(data, 500);
  fs.writeFileSync(f, data);
  const d = await HexDocument.openFile(f);
  const p = parsePattern('de ad be ef 13 37', 'hex');
  assert.equal((await d.search(p, 0, false, true)).offset, at[0]);
  assert.equal((await d.search(p, at[0] + 1, false, true)).offset, at[1]);
  const w = await d.search(p, at[1] + 1, false, true);
  assert.equal(w.offset, at[0]); assert.equal(w.wrapped, true);
  assert.equal((await d.search(p, data.length, true, true)).offset, at[1]);
  assert.equal((await d.search(p, at[1] - 1, true, true)).offset, at[0]);
  assert.equal((await d.search(parsePattern('de ?? be ef ?? 37', 'hex'), 0, false, true)).offset, at[0]);
  assert.equal((await d.search(parsePattern('hello world', 'text', true), 0, false, true)).offset, 500);
  assert.equal((await d.search(parsePattern('hello world', 'text', false), 0, false, true)).offset, -1);
  // an unsaved edit is found too
  await d.overwrite(4000, Uint8Array.from([0xca, 0xfe, 0xf0, 0x0d]));
  assert.equal((await d.search(parsePattern('cafef00d', 'hex'), 0, false, false)).offset, 4000);
  let stops = 0;
  const c = await d.search(parsePattern('99 99 99', 'hex'), 0, false, false, () => ++stops > 1);
  assert.equal(c.cancelled, true);
  await d.dispose();
});

test('4 GB sparse file: opens fast, reads the last row, finds a pattern near the end', async () => {
  const f = path.join(big, 'big4g.bin');
  const size = 4 * 1024 ** 3 + 16;
  const fd = fs.openSync(f, 'w'); fs.ftruncateSync(fd, size); fs.writeSync(fd, Buffer.from('ENDMARK!'), 0, 8, size - 8); fs.writeSync(fd, Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0xca, 0xfe]), 0, 6, 0xfffffffd); fs.closeSync(fd);
  const t0 = Date.now();
  const d = await HexDocument.openFile(f);
  const last = await d.read(size - 16, 16);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `open + last read took ${ms} ms`);
  assert.equal(Buffer.from(last.subarray(8)).toString(), 'ENDMARK!');
  const r = await d.search(parsePattern('fe ed fa ce ca fe', 'hex'), 0xfff00000, false, false);
  assert.equal(r.offset, 0xfffffffd);
  await d.overwrite(size - 1, Uint8Array.from([0x3f]));
  await d.save();
  const tail = Buffer.alloc(1); const fd2 = fs.openSync(f, 'r'); fs.readSync(fd2, tail, 0, 1, size - 1); fs.closeSync(fd2);
  assert.equal(tail[0], 0x3f);
  await d.dispose();
  fs.rmSync(f);
});

test('hostile: empty file, truncated while open, no permission, symlink loop, folder', async () => {
  const e = path.join(tmp, 'empty.bin'); fs.writeFileSync(e, '');
  const d0 = await HexDocument.openFile(e);
  assert.equal(d0.size, 0); assert.equal((await d0.read(0, 100)).length, 0);
  assert.equal((await d0.search(parsePattern('00', 'hex'), 0, false, true)).offset, -1);
  assert.equal(await d0.overwrite(0, Uint8Array.from([1])), null);
  await d0.dispose();

  const t = path.join(tmp, 'trunc.bin'); fs.writeFileSync(t, rnd(10 * 1024 * 1024));
  const d1 = await HexDocument.openFile(t);
  fs.truncateSync(t, 1024);
  const r = await d1.read(5 * 1024 * 1024, 4096);
  assert.equal(r.length, 0, 'reads past the new end return no bytes, no throw');
  assert.equal(await d1.refresh(), 1024);
  assert.equal(d1.size, 1024);
  await d1.overwrite(10, Uint8Array.from([1]));
  fs.truncateSync(t, 5);
  await assert.rejects(d1.save(), /shorter/);
  await d1.dispose();

  if (process.getuid && process.getuid() !== 0) {
    const n = path.join(tmp, 'noperm.bin'); fs.writeFileSync(n, 'secret'); fs.chmodSync(n, 0o000);
    await assert.rejects(HexDocument.openFile(n), e => e.code === 'EACCES');
    fs.chmodSync(n, 0o644);
    const ro = path.join(tmp, 'ro.bin'); fs.writeFileSync(ro, 'abc'); fs.chmodSync(ro, 0o444);
    const d2 = await HexDocument.openFile(ro);
    assert.equal(await d2.writable(), false);
    await d2.dispose(); fs.chmodSync(ro, 0o644);
  }
  const l = path.join(tmp, 'loop'); fs.symlinkSync('loop', l);
  await assert.rejects(HexDocument.openFile(l), e => e.code === 'ELOOP');
  await assert.rejects(HexDocument.openFile(tmp), e => e.code === 'EISDIR');
});

test('backup round trip and memory source', async () => {
  const d = HexDocument.fromBytes(Uint8Array.from([1, 2, 3, 4]), async () => {});
  await d.overwrite(1, Uint8Array.from([9]));
  const j = await d.backupJson();
  const d2 = HexDocument.fromBytes(Uint8Array.from([1, 2, 3, 4]), null);
  d2.restoreBackup(j);
  assert.deepEqual([...(await d2.read(0, 4))], [1, 9, 3, 4]);
  assert.equal(await d2.writable(), false);
  let written = null;
  const d3 = HexDocument.fromBytes(Uint8Array.from([1, 2, 3]), async b => { written = b; });
  await d3.overwrite(2, Uint8Array.from([7]));
  await d3.save();
  assert.deepEqual([...written], [1, 2, 7]);
});

test('search: a 4,096-byte wildcard pattern on zeros does not block the event loop and can be cancelled (VER8)', async () => {
  const f = path.join(tmp, 'zeros-3mb.bin');
  const data = Buffer.alloc(3 * 1024 * 1024); data[data.length - 1] = 1; fs.writeFileSync(f, data);
  const d = await HexDocument.openFile(f);
  const p = parsePattern('?? ' + '00 '.repeat(4094) + '01', 'hex');
  assert.ok(p.ok && p.mask);
  // the only match ends at the last byte; found both ways and in small slices
  let maxGap = 0, last = Date.now();
  const lag = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);
  const t0 = Date.now();
  const r = await d.search(p, 0, false, false, () => Date.now() - t0 > 1500);
  clearInterval(lag);
  assert.ok(maxGap < 400, `event loop blocked for ${maxGap} ms`);
  assert.ok(r.cancelled || r.offset === data.length - 4096, JSON.stringify(r));
  assert.ok(Date.now() - t0 < 4000, `cancel took ${Date.now() - t0} ms`);
  // backward from the end finds it quickly (the match is right there)
  assert.equal((await d.search(p, data.length, true, false)).offset, data.length - 4096);
  // a short wildcard pattern still finds the same match forward
  assert.equal((await d.search(parsePattern('00 ?? 01', 'hex'), 0, false, false)).offset, data.length - 3);
  await d.dispose();
});
