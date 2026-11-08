'use strict';
// The open file and its unsaved byte edits. No vscode import, so tests run it on real files.
// Local files are read in ranges (fs read at an offset), never as a whole. Other file systems
// (remote, virtual) come in through a reader callback with a size cap set by the caller.
const fs = require('fs');
const { preparePattern, findForward, findBackward, lowerAscii } = require('./bytes');

const CHUNK = 1 << 20; // 1 MB per read while searching or saving

class FileSource {
  constructor(fsPath) { this.path = fsPath; this.fh = null; }
  async handle() {
    if (!this.fh) this.fh = await fs.promises.open(this.path, 'r');
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
  async reopen() { await this.close(); }
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

class HexDocument {
  /** source: FileSource or MemorySource. size: bytes at open time. */
  constructor(source, size) {
    this.source = source;
    this.size = size;
    this.edits = new Map(); // offset -> byte value that differs from (or was typed over) the file on disk
    this._sorted = null;
    this.gen = 0; // bumps on save and revert: older undo records then write values instead of dropping edits
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

  sortedEdits() {
    if (!this._sorted) this._sorted = Float64Array.from(this.edits.keys()).sort();
    return this._sorted;
  }

  /** Put the unsaved edits over bytes read from `offset`. */
  overlay(bytes, offset) {
    if (!this.edits.size || !bytes.length) return bytes;
    const keys = this.sortedEdits();
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < offset) lo = m + 1; else hi = m; }
    const end = offset + bytes.length;
    let copied = false;
    for (let i = lo; i < keys.length && keys[i] < end; i++) {
      if (!copied) { bytes = Uint8Array.from(bytes); copied = true; }
      bytes[keys[i] - offset] = this.edits.get(keys[i]);
    }
    return bytes;
  }

  /** Bytes [offset, offset+length) with edits applied. Shorter than asked when the file ends (or shrank on disk). */
  async read(offset, length) {
    const len = Math.max(0, Math.min(length, this.size - offset));
    const raw = await this.source.read(offset, len);
    return this.overlay(raw, offset);
  }

  /** Edited offsets in [offset, offset+length), for highlighting. */
  editedIn(offset, length) {
    if (!this.edits.size) return [];
    const keys = this.sortedEdits();
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < offset) lo = m + 1; else hi = m; }
    const out = [];
    for (let i = lo; i < keys.length && keys[i] < offset + length; i++) out.push(keys[i]);
    return out;
  }

  /**
   * Overwrite bytes at `offset` with `values`. Returns the undo record { offset, before, after } or null when
   * nothing changed. Bytes past the end of the file are dropped (overwrite never grows the file).
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
    const prev = new Uint8Array(n);
    for (let i = 0; i < n; i++) prev[i] = this.edits.has(offset + i) ? 1 : 0;
    const rec = { offset, before: Uint8Array.from(before), after, prev, gen: this.gen };
    this.apply(rec, false);
    return rec;
  }

  /** Apply (undo = false) or roll back (undo = true) a record from overwrite(). */
  apply(rec, undo) {
    const v = undo ? rec.before : rec.after;
    // Undo in the same save generation drops the edit mark where there was none, so the byte is plain again.
    const drop = undo && rec.prev && rec.gen === this.gen;
    for (let i = 0; i < v.length; i++) {
      if (drop && !rec.prev[i]) this.edits.delete(rec.offset + i);
      else this.edits.set(rec.offset + i, v[i]);
    }
    this._sorted = null;
  }

  async writable() { return this.source.writable(); }

  /** Write the edits into the file. Local files are patched in place (only the edited bytes are written). */
  async save() {
    if (!this.edits.size) return;
    if (this.source instanceof FileSource) {
      const st = await this.source.stat();
      const keys = this.sortedEdits();
      if (keys[keys.length - 1] >= st.size) throw new Error(`The file on disk is now ${st.size} bytes, shorter than the edits. Nothing was saved.`);
      await this.source.close();
      const fh = await fs.promises.open(this.source.path, 'r+');
      try {
        for (let i = 0; i < keys.length;) {
          let j = i;
          while (j + 1 < keys.length && keys[j + 1] === keys[j] + 1 && j - i < CHUNK) j++;
          const buf = Buffer.alloc(j - i + 1);
          for (let k = i; k <= j; k++) buf[k - i] = this.edits.get(keys[k]);
          await fh.write(buf, 0, buf.length, keys[i]);
          i = j + 1;
        }
        await fh.sync();
      } finally { await fh.close(); }
    } else {
      if (!this.source.writeAll) throw new Error('This file system is read-only.');
      const all = this.overlay(await this.source.read(0, this.size), 0);
      await this.source.writeAll(all);
      this.source.bytes = all;
    }
    this.edits.clear();
    this._sorted = null;
    this.gen++;
  }

  /** Write the whole file with edits to another local path, in 1 MB pieces. */
  async saveAsFile(targetPath) {
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

  revert() { this.edits.clear(); this._sorted = null; this.gen++; }

  /** Re-read the size from disk (after a change on disk). Returns the new size. */
  async refresh() {
    await this.source.reopen();
    const st = await this.source.stat();
    this.size = st.size;
    return st.size;
  }

  backupJson() {
    const keys = this.sortedEdits();
    return JSON.stringify({ v: 1, size: this.size, edits: Array.from(keys, k => [k, this.edits.get(k)]) });
  }

  restoreBackup(json) {
    const d = JSON.parse(json);
    if (!d || d.v !== 1 || !Array.isArray(d.edits)) return;
    for (const [k, v] of d.edits) if (Number.isSafeInteger(k) && k >= 0 && k < this.size && v >= 0 && v <= 255) this.edits.set(k, v);
    this._sorted = null;
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

  async dispose() { await this.source.close(); }
}

module.exports = { HexDocument, FileSource, MemorySource, CHUNK };
