'use strict';
// Bookmarks and notes, saved per file. Pure data logic, no vscode import: the extension keeps the store in
// its global storage (a JSON value keyed by the file's path) and passes it in. Nothing leaves the machine.

const MAX_PER_FILE = 1000;
const MAX_FILES = 2000;
const MAX_LABEL = 120;
const MAX_NOTE = 4000;
const COLORS = ['yellow', 'green', 'blue', 'purple', 'red', 'orange'];

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);

/** A checked bookmark, or null when the input is not usable. */
function normalize(b) {
  if (!b || typeof b !== 'object') return null;
  const start = Number(b.start), end = Number(b.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  return {
    id: typeof b.id === 'string' && /^[\w-]{1,40}$/.test(b.id) ? b.id : newId(),
    start, end,
    label: clean(b.label, MAX_LABEL) || `0x${start.toString(16).toUpperCase()}`,
    note: clean(b.note, MAX_NOTE),
    color: COLORS.includes(b.color) ? b.color : 'yellow',
    created: Number.isFinite(b.created) ? b.created : Date.now(),
  };
}

let counter = 0;
function newId() { return Date.now().toString(36) + '-' + (counter++).toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36); }

class BookmarkStore {
  /** data: { files: { [key]: { list: Bookmark[], used: number } } } as saved before (or undefined). */
  constructor(data) {
    this.files = new Map();
    const files = data && typeof data === 'object' && data.files && typeof data.files === 'object' ? data.files : {};
    for (const [k, v] of Object.entries(files)) {
      if (typeof k !== 'string' || !v || !Array.isArray(v.list)) continue;
      const list = v.list.map(normalize).filter(Boolean).slice(0, MAX_PER_FILE);
      if (list.length) this.files.set(k, { list: sort(list), used: Number(v.used) || 0 });
    }
  }
  list(key) { const f = this.files.get(key); return f ? f.list.slice() : []; }
  add(key, b) {
    const n = normalize(b);
    if (!n) throw new Error('A bookmark needs a start offset and at least one byte.');
    let f = this.files.get(key);
    if (!f) { f = { list: [], used: 0 }; this.files.set(key, f); }
    if (f.list.length >= MAX_PER_FILE) throw new Error(`This file has ${MAX_PER_FILE} bookmarks, the most one file can keep. Remove some first.`);
    f.list.push(n); f.list = sort(f.list); f.used = Date.now();
    this.trim();
    return n;
  }
  update(key, id, patch) {
    const f = this.files.get(key);
    const i = f ? f.list.findIndex(b => b.id === id) : -1;
    if (i < 0) return null;
    const n = normalize({ ...f.list[i], ...patch, id });
    if (!n) return null;
    f.list[i] = n; f.list = sort(f.list); f.used = Date.now();
    return n;
  }
  remove(key, id) {
    const f = this.files.get(key);
    if (!f) return false;
    const before = f.list.length;
    f.list = f.list.filter(b => b.id !== id);
    if (!f.list.length) this.files.delete(key);
    return f.list.length !== before;
  }
  clear(key) { return this.files.delete(key); }
  /** The bookmark at or before `offset` (backward) or after it (forward), wrapping around. */
  next(key, offset, backward) {
    const l = this.list(key);
    if (!l.length) return null;
    if (!backward) return l.find(b => b.start > offset) || l[0];
    return [...l].reverse().find(b => b.start < offset) || l[l.length - 1];
  }
  /** Keep at most MAX_FILES files: the ones used longest ago go first. */
  trim() {
    if (this.files.size <= MAX_FILES) return;
    const old = [...this.files.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.files.size - MAX_FILES);
    for (const [k] of old) this.files.delete(k);
  }
  toJSON() { const files = {}; for (const [k, v] of this.files) files[k] = { list: v.list, used: v.used }; return { v: 1, files }; }
  /** A Markdown list of the bookmarks of one file, for export. */
  markdown(key, name) {
    const l = this.list(key);
    const hex = n => '0x' + n.toString(16).toUpperCase();
    const lines = [`# Bookmarks in ${name}`, '', `${l.length} bookmark${l.length === 1 ? '' : 's'}, exported from Hex Viewer Pro.`, '', '| Offset | Length | Label | Note |', '| --- | --- | --- | --- |'];
    for (const b of l) lines.push(`| ${hex(b.start)} (${b.start}) | ${b.end - b.start} | ${b.label.replace(/\|/g, '\\|')} | ${b.note.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')} |`);
    return lines.join('\n') + '\n';
  }
}

const sort = l => l.sort((a, b) => a.start - b.start || a.end - b.end || a.created - b.created);

module.exports = { BookmarkStore, normalize, COLORS, MAX_PER_FILE, MAX_FILES };
