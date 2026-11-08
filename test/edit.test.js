'use strict';
// Insert, delete, replace and cut on real files: the piece table against a plain Buffer model,
// undo and redo, the safe save (new copy, then swap) when the size changes, undo after each kind of save,
// a 4 GB sparse file, symlinks, read-only files and a full disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HexDocument, checkSpace, CHUNK } = require('../src/core/doc');
const { parsePattern } = require('../src/core/bytes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexv-edit-'));
const big = path.join(os.homedir(), 'hex-viewer-work', 'edit-' + process.pid);
fs.mkdirSync(big, { recursive: true });
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(big, { recursive: true, force: true }); });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function rnd(n, seed = 7) { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; }
const all = async d => Buffer.from(await d.read(0, d.size));

test('insert, delete, replace match a Buffer model through 400 random steps with undo and redo', async () => {
  const f = path.join(tmp, 'model.bin'); const data = rnd(5000, 11); fs.writeFileSync(f, data);
  const d = await HexDocument.openFile(f);
  let model = Buffer.from(data);
  const hist = [];
  let x = 99; const r = n => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % Math.max(1, n); };
  for (let step = 0; step < 400; step++) {
    const k = r(10);
    let rec = null, next = model;
    if (k < 3) { const at = r(model.length + 1); const v = rnd(1 + r(40), step); rec = d.insert(at, v); next = Buffer.concat([model.subarray(0, at), v, model.subarray(at)]); }
    else if (k < 5 && model.length) { const a = r(model.length); const b = Math.min(model.length, a + 1 + r(60)); rec = d.delete(a, b); next = Buffer.concat([model.subarray(0, a), model.subarray(b)]); }
    else if (k < 7 && model.length) { const a = r(model.length); const b = Math.min(model.length, a + r(30)); const v = rnd(r(30), step + 5); rec = d.replace(a, b, v); if (rec) next = Buffer.concat([model.subarray(0, a), v, model.subarray(b)]); }
    else if (k < 9 && model.length) { const a = r(model.length); const v = rnd(1 + r(20), step + 9); rec = await d.overwrite(a, v); if (rec) { next = Buffer.from(model); v.copy(next, a, 0, Math.min(v.length, model.length - a)); } }
    else if (hist.length) { const h = hist.pop(); d.apply(h.rec, true); model = h.before; assert.equal(d.size, model.length); continue; }
    if (rec) { hist.push({ rec, before: model }); model = next; }
    assert.equal(d.size, model.length, 'size at step ' + step);
    if (step % 25 === 0) assert.ok((await all(d)).equals(model), 'bytes at step ' + step);
  }
  assert.ok((await all(d)).equals(model));
  // undo everything, then the document is clean again
  while (hist.length) { const h = hist.pop(); d.apply(h.rec, true); model = h.before; }
  assert.ok((await all(d)).equals(data));
  assert.equal(d.dirty, false);
  assert.deepEqual(d.editedIn(0, d.size), []);
  await d.dispose();
});

test('edited marks follow inserted bytes; reads across many pieces; search finds text across an insert', async () => {
  const f = path.join(tmp, 'marks.bin'); fs.writeFileSync(f, Buffer.alloc(100, 0x41));
  const d = await HexDocument.openFile(f);
  d.insert(10, Buffer.from('HEL'));
  d.insert(13, Buffer.from('LO'));
  assert.deepEqual(d.editedIn(0, 200), [10, 11, 12, 13, 14]);
  assert.equal(d.size, 105);
  assert.equal(d.pieces.length, 3, 'typing next to the last insert joins the pieces');
  const p = parsePattern('HELLO', 'text');
  assert.equal((await d.search(p, 0, false, false)).offset, 10);
  const del = d.delete(0, 10);
  assert.equal((await d.search(p, 0, false, false)).offset, 0);
  d.apply(del, true);
  assert.equal(Buffer.from(await d.read(8, 9)).toString(), 'AAHELLOAA');
  await d.dispose();
});

test('save with a size change writes a new copy and swaps it in; mode kept; undo after the save', async () => {
  const f = path.join(tmp, 'grow.bin'); const data = rnd(3 * CHUNK + 123, 5); fs.writeFileSync(f, data); fs.chmodSync(f, 0o640);
  const d = await HexDocument.openFile(f);
  const ins = d.insert(CHUNK - 2, Buffer.from('INSERTED'));
  const del = d.delete(5, 105);
  await d.save();
  const want = Buffer.concat([data.subarray(0, 5), data.subarray(105, CHUNK - 2), Buffer.from('INSERTED'), data.subarray(CHUNK - 2)]);
  assert.equal(sha(fs.readFileSync(f)), sha(want));
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(tmp).filter(n => n.includes('hexviewer')), [], 'no temp file left');
  assert.equal(d.dirty, false);
  // undo the delete after the save: the old bytes come back from the old copy, marked as edits
  d.apply(del, true);
  assert.ok(Buffer.from(await d.read(0, 200)).equals(Buffer.concat([data.subarray(0, 105), want.subarray(5, 100)])));
  assert.equal(d.editedIn(0, 200).length, 100);
  d.apply(ins, true);
  await d.save();
  assert.equal(sha(fs.readFileSync(f)), sha(data), 'undo both and save gives the original file');
  // same-size edit after a size change: patched in place
  const ino = fs.statSync(f).ino;
  await d.overwrite(7, Buffer.from([0xee]));
  await d.save();
  assert.equal(fs.statSync(f).ino, ino, 'same-size save patches in place');
  assert.equal(fs.readFileSync(f)[7], 0xee);
  await d.dispose();
});

test('save through a symlink keeps the link and changes the target', async () => {
  const target = path.join(tmp, 'target.bin'); fs.writeFileSync(target, Buffer.from('0123456789'));
  const link = path.join(tmp, 'link.bin'); fs.symlinkSync(target, link);
  const d = await HexDocument.openFile(link);
  d.insert(10, Buffer.from('AB'));
  await d.save();
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a link');
  assert.equal(fs.readFileSync(target, 'utf8'), '0123456789AB');
  await d.dispose();
});

test('a failed save leaves the file as it was: full disk and read-only folder', async () => {
  await assert.rejects(checkSpace(tmp, Number.MAX_SAFE_INTEGER), e => e.code === 'ENOSPC' && /Nothing was changed/.test(e.message));
  if (process.getuid && process.getuid() !== 0) {
    const dir = path.join(tmp, 'rodir'); fs.mkdirSync(dir);
    const f = path.join(dir, 'x.bin'); fs.writeFileSync(f, 'hello');
    fs.chmodSync(dir, 0o555);
    const d = await HexDocument.openFile(f);
    d.insert(0, Buffer.from('>>'));
    await assert.rejects(d.save());
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
    assert.deepEqual(fs.readdirSync(dir), ['x.bin']);
    assert.equal(d.dirty, true, 'edits stay after a failed save');
    fs.chmodSync(dir, 0o755);
    await d.save();
    assert.equal(fs.readFileSync(f, 'utf8'), '>>hello');
    await d.dispose();
  }
});

test('file changed on disk before a size-changing save: refused, nothing written', async () => {
  const f = path.join(tmp, 'race.bin'); fs.writeFileSync(f, rnd(4096));
  const d = await HexDocument.openFile(f);
  d.insert(0, Buffer.from([1, 2, 3]));
  fs.appendFileSync(f, 'more');
  await assert.rejects(d.save(), /longer/);
  assert.equal(fs.statSync(f).size, 4100);
  await d.dispose();
});

test('backup v2 round trip with inserts and deletes; v1 backups still restore', async () => {
  const f = path.join(tmp, 'bk.bin'); fs.writeFileSync(f, Buffer.from('abcdefghij'));
  const d = await HexDocument.openFile(f);
  d.insert(3, Buffer.from('XYZ')); d.delete(0, 1); await d.overwrite(8, Buffer.from('!'));
  const expect = await all(d);
  const j = await d.backupJson();
  const d2 = await HexDocument.openFile(f);
  d2.restoreBackup(j);
  assert.ok((await all(d2)).equals(expect));
  const d3 = await HexDocument.openFile(f);
  d3.restoreBackup(JSON.stringify({ v: 1, size: 10, edits: [[0, 65], [99, 1], [-1, 2], [2, 300]] }));
  assert.equal((await all(d3)).toString(), 'Abcdefghij');
  const d4 = await HexDocument.openFile(f);
  d4.restoreBackup(JSON.stringify({ v: 2, size: 10, pieces: [[5, 999]] }));
  assert.equal((await all(d4)).toString(), 'abcdefghij', 'a backup that points past the file is ignored');
  for (const x of [d, d2, d3, d4]) await x.dispose();
});

test('4 GB sparse file: insert at the start and delete near the end are instant; last bytes read right', async () => {
  const f = path.join(big, 'huge.bin');
  const size = 4 * 1024 ** 3 + 17;
  const fh = fs.openSync(f, 'w'); fs.ftruncateSync(fh, size); fs.writeSync(fh, Buffer.from('TAILMARK'), 0, 8, size - 8); fs.closeSync(fh);
  const d = await HexDocument.openFile(f);
  const t0 = Date.now();
  d.insert(0, Buffer.from('HEAD'));
  d.delete(size - 100, size - 90);
  assert.ok(Date.now() - t0 < 50, 'edits do not touch the file');
  assert.equal(d.size, size + 4 - 10);
  assert.equal(Buffer.from(await d.read(d.size - 8, 8)).toString(), 'TAILMARK');
  assert.equal(Buffer.from(await d.read(0, 6)).toString('latin1'), 'HEAD\0\0');
  const r = await d.search(parsePattern('TAILMARK', 'text'), d.size - CHUNK, false, false);
  assert.equal(r.offset, d.size - 8);
  await d.dispose();
  fs.rmSync(f);
});
