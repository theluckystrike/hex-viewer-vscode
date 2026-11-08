'use strict';
// The open file and its unsaved edits. No vscode import, so tests run it on real files.
// Local files are read in ranges (fs read at an offset), never as a whole. Other file systems
// (remote, virtual) come in through a reader callback with a size cap set by the caller.
//
// Edits are kept as a piece table: the document is a list of pieces, each a range of a file version
// ("layer") or a small block of bytes in memory. Overwrite, insert and delete only split and splice
// pieces, so inserting one byte into a 4 GB file costs the same as into a 4 KB file. Undo records keep
// the pieces they removed. A saved-over file version stays readable for undo: a save in place keeps
// the old bytes of the patched ranges, a save that changes the size writes a new file next to the old
// one, swaps it in, and keeps the old file open until the tab closes.
const fs = require('fs');
const path = require('path');
const { preparePattern, findForward, findBackward, lowerAscii } = require('./bytes');

const CHUNK = 1 << 20; // 1 MB per read while searching or saving
const MAX_PATCH = 256 << 20; // larger edited areas are saved as a new copy, not patched in place
const SPACE_MARGIN = 16 << 20;
const JOIN_MEM = 1 << 16; // new bytes next to each other are joined into one block up to 64 KB

class FileSource {
  constructor(fsPath) { this.path = fsPath; this.fh = null; this.detached = false; }
  async handle() {
    if (!this.fh) {
      if (this.detached) throw new Error('The older copy of this file is no longer open, so this step cannot be undone.');
      this.fh = await fs.promises.open(this.path, 'r');
    }
    return this.fh;
  }
  async stat() { return fs.promises.stat(this.path); }
  async read(offset, length) {
    if (length <= 0) return new Uint8Array(0);
    const fh = await this.handle();
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got);
  }
  async writable() {
    try { await fs.promises.access(this.path, fs.constants.W_OK); return true; } catch { return false; }
  }
  async reopen() { if (!this.detached) await this.close(); }
  async close() { const fh = this.fh; this.fh = null; if (fh) try { await fh.close(); } catch {} }
}

class MemorySource {
  constructor(bytes, writeAll) { this.bytes = bytes; this.writeAll = writeAll || null; }
  async stat() { return { size: this.bytes.length }; }
  async read(offset, length) {
    const end = Math.min(this.bytes.length, offset + Math.max(0, length));
    return offset >= end ? new Uint8Array(0) : this.bytes.slice(offset, end);
  }
  async writable() { return !!this.writeAll; }
  async reopen() {}
  async close() {}
}

/**
 * One version of the file content. The current layer reads the source. After a save in place the old
 * layer reads the new layer and puts the saved-over bytes back on top (overlay), so undo records that
 * point into it still see the old content.
 */
class Layer {
  constructor(source, size) { this.source = source; this.size = size; this.base = null; this.overlay = []; }
  async read(offset, length) {
    let b = this.base ? await this.base.read(offset, length) : await this.source.read(offset, length);
    if (!this.overlay.length || !b.length) return b;
    const end = offset + b.length;
    let copied = false;
    for (const o of this.overlay) {
      const s = Math.max(offset, o.start), e = Math.min(end, o.start + o.bytes.length);
      if (s >= e) continue;
      if (!copied) { b = Uint8Array.from(b); copied = true; }
      b.set(o.bytes.subarray(s - o.start, e - o.start), s - offset);
    }
    return b;
  }
}

const isMem = p => p.src instanceof Uint8Array;
const piecesLen = ps => ps.reduce((n, p) => n + p.len, 0);

class HexDocument {
  /** source: FileSource or MemorySource. size: bytes at open time. */
  constructor(source, size) {
    this.source = source;
    this.cur = new Layer(source, size);
    this.size = size;
    this.pieces = size ? [{ src: this.cur, start: 0, len: size }] : [];
    this._starts = null;
    this.sources = new Set([source]);
    this.gen = 0; // bumps on save and revert
  }

  static async openFile(fsPath) {
    const src = new FileSource(fsPath);
    const st = await src.stat();
    if (st.isDirectory && st.isDirectory()) throw Object.assign(new Error('This is a folder, not a file.'), { code: 'EISDIR' });
    await src.handle(); // fails here with EACCES when the file cannot be read
    return new HexDocument(src, st.size);
  }

  static fromBytes(bytes, writeAll) { return new HexDocument(new MemorySource(bytes, writeAll), bytes.length); }

  get isFile() { return this.source instanceof FileSource; }

  /** True when the content differs from the current file version (unsaved edits). */
  get dirty() {
    const p = this.pieces;
    if (this.size !== this.cur.size) return true;
    return !(p.length === 0 || (p.length === 1 && p[0].src === this.cur && p[0].start === 0));
  }

  starts() {
    if (!this._starts) {
      const s = new Float64Array(this.pieces.length);
      let n = 0;
      for (let i = 0; i < this.pieces.length; i++) { s[i] = n; n += this.pieces[i].len; }
      this._starts = s;
    }
    return this._starts;
  }

  /** Index of the piece that holds `offset` (offset < size). */
  pieceAt(offset) {
    const s = this.starts();
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m] <= offset) lo = m; else hi = m - 1; }
    return lo;
  }

  /** Bytes [offset, offset+length). Shorter than asked when the file ends (or shrank on disk). */
  async read(offset, length) {
    const len = Math.max(0, Math.min(length, this.size - offset));
    if (len <= 0 || offset < 0) return new Uint8Array(0);
    let i = this.pieceAt(offset);
    const s = this.starts();
    const p0 = this.pieces[i];
    const in0 = offset - s[i];
    if (in0 + len <= p0.len) {
      return isMem(p0) ? p0.src.slice(p0.start + in0, p0.start + in0 + len) : p0.src.read(p0.start + in0, len);
    }
    const out = new Uint8Array(len);
    let pos = 0;
    for (; pos < len && i < this.pieces.length; i++) {
      const p = this.pieces[i];
      const inner = pos === 0 ? in0 : 0;
      const take = Math.min(p.len - inner, len - pos);
      if (isMem(p)) out.set(p.src.subarray(p.start + inner, p.start + inner + take), pos);
      else {
        const b = await p.src.read(p.start + inner, take);
        out.set(b, pos);
        if (b.length < take) return out.subarray(0, pos + b.length);
      }
      pos += take;
    }
    return out;
  }

  /** Offsets in [offset, offset+length) that hold new bytes (typed, pasted, inserted, or put back by undo after a save). */
  editedIn(offset, length, limit = 1 << 20) {
    const out = [];
    if (!this.dirty || length <= 0 || offset >= this.size) return out;
    const end = Math.min(this.size, offset + length);
    const s = this.starts();
    for (let i = this.pieceAt(Math.max(0, offset)); i < this.pieces.length && s[i] < end; i++) {
      const p = this.pieces[i];
      if (p.src === this.cur) continue; // bytes of the file on disk (also when shifted by an insert) are not marked
      const a = Math.max(offset, s[i]), b = Math.min(end, s[i] + p.len);
      for (let o = a; o < b; o++) { if (out.length >= limit) return out; out.push(o); }
    }
    return out;
  }

  /** Split so that a piece starts at `offset`; returns that piece index (pieces.length at the end). */
  _split(offset) {
    if (offset >= this.size) return this.pieces.length;
    const i = this.pieceAt(offset);
    const s = this.starts()[i];
    if (s === offset) return i;
    const p = this.pieces[i], k = offset - s;
    this.pieces.splice(i, 1, { src: p.src, start: p.start, len: k }, { src: p.src, start: p.start + k, len: p.len - k });
    this._starts = null;
    return i + 1;
  }

  /** Replace `delLen` bytes at `offset` with the pieces `ins`. Returns the removed pieces. */
  _splice(offset, delLen, ins) {
    const a = this._split(offset);
    const b = delLen > 0 ? this._split(offset + delLen) : a;
    const removed = this.pieces.splice(a, b - a, ...ins.filter(p => p.len > 0));
    this._starts = null;
    this.size += piecesLen(ins) - delLen;
    // Join neighbours that continue each other (typing byte after byte, or undo putting a piece back).
    if (this.pieces.length > 1) {
      const lo = Math.max(1, a - 1), hi = Math.min(this.pieces.length - 1, a + ins.length + 1);
      for (let i = hi; i >= lo; i--) {
        const x = this.pieces[i - 1], y = this.pieces[i];
        if (!x || !y) continue;
        if (x.src === y.src && x.start + x.len === y.start) this.pieces.splice(i - 1, 2, { src: x.src, start: x.start, len: x.len + y.len });
        else if (isMem(x) && isMem(y) && x.len + y.len <= JOIN_MEM) {
          const b = new Uint8Array(x.len + y.len);
          b.set(x.src.subarray(x.start, x.start + x.len)); b.set(y.src.subarray(y.start, y.start + y.len), x.len);
          this.pieces.splice(i - 1, 2, { src: b, start: 0, len: b.length });
        }
      }
    }
    return removed;
  }

  _record(offset, delLen, bytes, kind) {
    const ins = bytes && bytes.length ? [{ src: bytes, start: 0, len: bytes.length }] : [];
    const removed = this._splice(offset, delLen, ins);
    return { kind, offset, removed, inserted: ins, after: bytes || new Uint8Array(0), gen: this.gen };
  }

  /**
   * Overwrite bytes at `offset` with `values`. Returns the undo record or null when nothing changed.
   * Bytes past the end of the file are dropped (overwrite never grows the file).
   */
  async overwrite(offset, values) {
    if (offset < 0 || offset >= this.size) return null;
    const n = Math.min(values.length, this.size - offset);
    if (n <= 0) return null;
    const before = await this.read(offset, n);
    if (before.length < n) throw new Error('The file got shorter on disk. Close and open it again before you edit.');
    const after = Uint8Array.from(values.subarray ? values.subarray(0, n) : values.slice(0, n));
    let same = true;
    for (let i = 0; i < n; i++) if (before[i] !== after[i]) { same = false; break; }
    if (same) return null;
    const rec = this._record(offset, n, after, 'overwrite');
    rec.before = Uint8Array.from(before);
    return rec;
  }

  /** Insert `values` before `offset` (offset = size appends). */
  insert(offset, values) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.size || !values || !values.length) return null;
    return this._record(offset, 0, Uint8Array.from(values), 'insert');
  }

  /** Delete bytes [start, end). */
  delete(start, end) {
    end = Math.min(end, this.size);
    if (!(start >= 0) || end <= start) return null;
    return this._record(start, end - start, null, 'delete');
  }

  /** Replace bytes [start, end) with `values` (any length) in one undo step. */
  replace(start, end, values) {
    end = Math.min(end, this.size);
    if (!(start >= 0) || start > this.size || end < start) return null;
    if (end === start && (!values || !values.length)) return null;
    return this._record(start, end - start, values && values.length ? Uint8Array.from(values) : null, 'replace');
  }

  /** Apply (undo = false) or roll back (undo = true) a record from overwrite, insert, delete or replace. */
  apply(rec, undo) {
    if (undo) this._splice(rec.offset, piecesLen(rec.inserted), rec.removed);
    else this._splice(rec.offset, piecesLen(rec.removed), rec.inserted);
  }

  async writable() { return this.source.writable(); }

  /** Ranges (logical offsets) whose bytes do not come from the current file version at the same offset. */
  _patchRanges() {
    const s = this.starts(), out = [];
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!isMem(p) && p.src === this.cur && p.start === s[i]) continue;
      const last = out[out.length - 1];
      if (last && last.offset + last.len === s[i]) last.len += p.len; else out.push({ offset: s[i], len: p.len });
    }
    return out;
  }

  _canPatchInPlace() {
    if (this.size !== this.cur.size) return false;
    const s = this.starts();
    let total = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!isMem(p) && p.src === this.cur && p.start !== s[i]) return false;
      if (isMem(p) || p.src !== this.cur) total += p.len;
    }
    return total <= MAX_PATCH;
  }

  /**
   * Write the edits into the file. When the size is the same, only the edited bytes are written in place.
   * When the size changes, the whole file is written to a new file in the same folder, which then
   * replaces the old one (a failed save leaves the old file as it was).
   */
  async save() {
    if (!this.dirty) return;
    if (this.source instanceof FileSource) {
      const st = await this.source.stat();
      if (st.size !== this.cur.size) throw new Error(`The file on disk is now ${st.size} bytes, ${st.size < this.cur.size ? 'shorter' : 'longer'} than the ${this.cur.size} bytes it had when it was read. Nothing was saved. Close and open the file again.`);
      if (this._canPatchInPlace()) await this._savePatch();
      else await this._saveCopy(st);
    } else {
      if (!this.source.writeAll) throw new Error('This file system is read-only.');
      const all = Uint8Array.from(await this.read(0, this.size));
      await this.source.writeAll(all);
      this._newVersion(new MemorySource(all, this.source.writeAll), all.length, false);
    }
  }

  _newVersion(source, size, sameSource) {
    if (!sameSource) this.sources.add(source);
    this.source = source;
    this.cur = new Layer(source, size);
    this.size = size;
    this.pieces = size ? [{ src: this.cur, start: 0, len: size }] : [];
    this._starts = null;
    this.gen++;
  }

  async _savePatch() {
    const ranges = this._patchRanges();
    const old = this.cur;
    const saved = [];
    for (const r of ranges) {
      const b = await old.read(r.offset, r.len);
      if (b.length < r.len) throw new Error('The file got shorter on disk. Nothing was saved.');
      saved.push({ start: r.offset, bytes: Uint8Array.from(b) });
    }
    // From here the old version reads the new one plus the saved-over bytes, so undo still sees it.
    const next = new Layer(this.source, this.size);
    old.base = next; old.overlay = saved;
    const fh = await fs.promises.open(this.source.path, 'r+');
    const done = [];
    try {
      for (const r of ranges) {
        for (let off = r.offset; off < r.offset + r.len; off += CHUNK) {
          const n = Math.min(CHUNK, r.offset + r.len - off);
          const b = await this.read(off, n);
          if (b.length < n) throw new Error('The file got shorter while it was saved.');
          await fh.write(b, 0, n, off);
          done.push(off);
        }
      }
      await fh.sync();
    } catch (e) {
      // Put the old bytes back where they were already written, then report.
      try { for (const o of saved) await fh.write(o.bytes, 0, o.bytes.length, o.start); await fh.sync(); } catch {}
      old.base = null; old.overlay = [];
      await fh.close();
      throw e;
    }
    await fh.close();
    this._newVersion(this.source, this.size, true);
  }

  async _saveCopy(st) {
    const real = await fs.promises.realpath(this.source.path);
    const dir = path.dirname(real);
    await checkSpace(dir, this.size);
    const tmp = path.join(dir, `.${path.basename(real)}.hexviewer-${process.pid}-${Date.now()}.tmp`);
    const fh = await fs.promises.open(tmp, 'wx', st.mode & 0o777);
    try {
      for (let off = 0; off < this.size; off += CHUNK) {
        const n = Math.min(CHUNK, this.size - off);
        const b = await this.read(off, n);
        if (b.length < n) throw new Error('The file got shorter on disk while it was saved. Nothing was changed.');
        await fh.write(b, 0, n, off);
      }
      await fh.sync();
      await fh.close();
      try { await fs.promises.chmod(tmp, st.mode & 0o7777); } catch {}
    } catch (e) {
      try { await fh.close(); } catch {}
      await fs.promises.rm(tmp, { force: true });
      throw e;
    }
    const oldSource = this.source;
    try {
      await fs.promises.rename(tmp, real);
    } catch (e) {
      // Windows does not replace a file that is open. Close the old copy and try once more.
      if (!/^(EPERM|EACCES|EBUSY)$/.test(e.code || '')) { await fs.promises.rm(tmp, { force: true }); throw e; }
      await oldSource.close();
      try { await fs.promises.rename(tmp, real); } catch (e2) { await fs.promises.rm(tmp, { force: true }); throw e2; }
    }
    // The old file stays open (its bytes are still on disk until the tab closes), so undo can read it.
    oldSource.detached = true;
    this._newVersion(new FileSource(this.source.path), this.size, false);
  }

  /** Write the whole file with edits to another local path, in 1 MB pieces. */
  async saveAsFile(targetPath) {
    await checkSpace(path.dirname(targetPath), this.size);
    const tmp = targetPath + '.hexviewer-tmp';
    const fh = await fs.promises.open(tmp, 'w');
    try {
      for (let off = 0; off < this.size; off += CHUNK) {
        const b = await this.read(off, Math.min(CHUNK, this.size - off));
        if (b.length < Math.min(CHUNK, this.size - off)) throw new Error('The file got shorter while it was copied.');
        await fh.write(b, 0, b.length, off);
      }
      await fh.sync();
    } catch (e) { await fh.close(); await fs.promises.rm(tmp, { force: true }); throw e; }
    await fh.close();
    await fs.promises.rename(tmp, targetPath);
  }

  /** All bytes with edits, for non-local Save As. Callers cap the size. */
  async readAll() { return this.read(0, this.size); }

  _reset() {
    this.size = this.cur.size;
    this.pieces = this.size ? [{ src: this.cur, start: 0, len: this.size }] : [];
    this._starts = null;
  }

  revert() { this._reset(); this.gen++; }

  /** Re-read the size from disk (after a change on disk). Edits stay. Returns the new size. */
  async refresh() {
    await this.source.reopen();
    const st = await this.source.stat();
    const oldCur = this.cur.size, n = st.size;
    const wasDirty = this.dirty;
    this.cur.size = n;
    if (!wasDirty || this.pieces.length === 0) { this._reset(); return this.size; }
    const aligned = this.size === oldCur;
    const s = this.starts();
    const out = [];
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (isMem(p) || p.src !== this.cur) { if (!aligned || s[i] < n) out.push(p); continue; }
      const len = Math.min(p.len, n - p.start);
      if (len > 0) out.push(len === p.len ? p : { src: p.src, start: p.start, len });
    }
    let size = piecesLen(out);
    if (aligned && n > oldCur && size === oldCur) { out.push({ src: this.cur, start: oldCur, len: n - oldCur }); size = n; }
    if (aligned && size > n) {
      // edits past the new end of the file are dropped
      let cut = size - n;
      while (cut > 0 && out.length) { const last = out[out.length - 1]; if (last.len <= cut) { out.pop(); cut -= last.len; } else { out[out.length - 1] = { src: last.src, start: last.start, len: last.len - cut }; cut = 0; } }
      size = n;
    }
    this.pieces = out; this.size = size; this._starts = null;
    return this.size;
  }

  /** Unsaved edits as JSON for hot exit. Edits over 256 MB of new bytes are not backed up. */
  async backupJson() {
    if (!this.dirty) return JSON.stringify({ v: 2, size: this.cur.size, pieces: null });
    const s = this.starts(), out = [];
    let mem = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!isMem(p) && p.src === this.cur) { out.push([p.start, p.len]); continue; }
      mem += p.len;
      if (mem > MAX_PATCH) return JSON.stringify({ v: 2, size: this.cur.size, tooLarge: true });
      const b = isMem(p) ? p.src.subarray(p.start, p.start + p.len) : await this.read(s[i], p.len);
      out.push(Buffer.from(b.buffer, b.byteOffset, b.length).toString('base64'));
    }
    return JSON.stringify({ v: 2, size: this.cur.size, pieces: out });
  }

  restoreBackup(json) {
    const d = JSON.parse(json);
    if (!d) return;
    if (d.v === 1 && Array.isArray(d.edits)) {
      for (const [k, v] of d.edits) {
        if (Number.isSafeInteger(k) && k >= 0 && k < this.size && Number.isInteger(v) && v >= 0 && v <= 255) this._splice(k, 1, [{ src: Uint8Array.of(v), start: 0, len: 1 }]);
      }
      return;
    }
    if (d.v !== 2 || !Array.isArray(d.pieces) || d.size !== this.cur.size) return;
    const out = [];
    for (const x of d.pieces) {
      if (typeof x === 'string') { const b = new Uint8Array(Buffer.from(x, 'base64')); if (b.length) out.push({ src: b, start: 0, len: b.length }); }
      else if (Array.isArray(x) && Number.isSafeInteger(x[0]) && Number.isSafeInteger(x[1]) && x[0] >= 0 && x[1] > 0 && x[0] + x[1] <= this.cur.size) out.push({ src: this.cur, start: x[0], len: x[1] });
      else return;
    }
    this.pieces = out; this.size = piecesLen(out); this._starts = null;
  }

  /**
   * Find `pattern` (from parsePattern) starting at `from` (forward: first match at >= from; backward: last match
   * at <= from). wrap: continue from the other end once. shouldStop(): true to cancel. progress(done, total).
   * Returns { offset } or { offset: -1, cancelled? }.
   */
  async search(pattern, from, backward, wrap, shouldStop = () => false, progress = () => {}) {
    const pp = preparePattern(pattern);
    const len = pp.len;
    const size = this.size;
    if (len > size) return { offset: -1 };
    const plain = !pp.mask;
    const needle = Buffer.from(pp.pat);
    let scanned = 0, lastReport = Date.now();
    const lower = b => { const c = Buffer.from(b); for (let i = 0; i < c.length; i++) c[i] = lowerAscii(c[i]); return c; };
    const prep = b => (pp.ic ? lower(b) : Buffer.from(b.buffer, b.byteOffset, b.length));
    const tick = async n => {
      scanned += n;
      if (Date.now() - lastReport > 250) { lastReport = Date.now(); progress(scanned, size); await new Promise(r => setImmediate(r)); }
    };
    // A wildcard pattern is checked byte by byte, so a long one on uniform data (zeros) costs up to len
    // compares per position. Scan such chunks in slices of about 4M compares and yield in between, so the
    // extension host stays responsive and a cancel takes effect within one slice.
    const slice = Math.max(1024, Math.floor((4 << 20) / len));
    const STOP = -2;
    let lastYield = Date.now();
    const sliced = async (fn, s0, end, stepBy) => {
      for (let s = s0; stepBy > 0 ? s < end : s > end; s += stepBy) {
        const i = fn(s);
        if (i >= 0) return i;
        if (Date.now() - lastYield > 30) {
          await new Promise(r => setImmediate(r)); lastYield = Date.now();
          if (shouldStop()) return STOP;
        }
      }
      return -1;
    };
    // forward over [a, b): matches starting in [a, b)
    const fwd = async (a, b) => {
      for (let pos = a; pos < b; pos += CHUNK) {
        if (shouldStop()) return { offset: -1, cancelled: true };
        const want = Math.min(CHUNK, b - pos) + len - 1;
        const buf = prep(await this.read(pos, want));
        const lim = Math.min(buf.length, (b - pos) + len - 1);
        const i = plain ? buf.subarray(0, lim).indexOf(needle) : await sliced(s => findForward(buf, pp, s, Math.min(lim, s + slice + len - 1)), 0, lim - len + 1, slice);
        if (i === STOP) return { offset: -1, cancelled: true };
        if (i >= 0 && pos + i < b) return { offset: pos + i };
        await tick(Math.min(CHUNK, b - pos));
      }
      return null;
    };
    // backward over match starts in [a, b] (inclusive b)
    const bwd = async (a, b) => {
      for (let top = b; top >= a; top -= CHUNK) {
        if (shouldStop()) return { offset: -1, cancelled: true };
        const start = Math.max(a, top - CHUNK + 1);
        const buf = prep(await this.read(start, top - start + len));
        const i = plain ? buf.lastIndexOf(needle, top - start) : await sliced(s => findBackward(buf, pp, s, Math.max(0, s - slice + 1)), top - start, -1, -slice);
        if (i === STOP) return { offset: -1, cancelled: true };
        if (i >= 0 && start + i >= a) return { offset: start + i };
        await tick(top - start + 1);
      }
      return null;
    };
    const lastStart = size - len;
    from = Math.max(0, Math.min(from, lastStart + (backward ? 0 : 1)));
    let r;
    if (!backward) {
      r = await fwd(from, lastStart + 1);
      if (!r && wrap && from > 0) { r = await fwd(0, Math.min(from + len - 1, lastStart + 1)); if (r) r.wrapped = true; }
    } else {
      r = from >= 0 ? await bwd(0, Math.min(from, lastStart)) : null;
      if (!r && wrap && from < lastStart) { r = await bwd(from + 1, lastStart); if (r) r.wrapped = true; }
    }
    progress(size, size);
    return r || { offset: -1 };
  }

  async dispose() { for (const s of this.sources) await s.close(); }
}

/** Throws a plain message when the folder's disk has less free space than `need` bytes plus a margin. */
async function checkSpace(dir, need) {
  if (!fs.promises.statfs) return;
  let free;
  try { const s = await fs.promises.statfs(dir); free = Number(s.bavail) * Number(s.bsize); } catch { return; }
  if (free < need + SPACE_MARGIN) {
    const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    throw Object.assign(new Error(`Not enough free disk space to save safely: the new file needs ${mb(need)} and the disk has ${mb(free)} free. Nothing was changed.`), { code: 'ENOSPC' });
  }
}

module.exports = { HexDocument, FileSource, MemorySource, Layer, CHUNK, MAX_PATCH, checkSpace };
