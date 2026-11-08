// Hex Viewer webview. Draws only the rows on screen; bytes come from the extension host in 64 KB blocks.
// The scroll bar is drawn here (not by the browser), so a 4 GB or larger file scrolls to its last row.
import { hexOffset, fmtSize, fmtInt, parseOffset, inspect, textCells, byteForChar, parseHexPaste, ENCODINGS, hex2 } from '../core/bytes.js';

const vscode = acquireVsCodeApi();
const post = m => vscode.postMessage(m);
const BLOCK = 65536;
const MAX_BLOCKS = 128;
const ROW_SIZES = [8, 16, 24, 32, 48, 64];
const $ = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const saved = vscode.getState() || {};
const S = {
  loaded: false, name: '', size: 0, fileType: '', readOnly: false, readOnlyReason: '', settings: {},
  bpr: 16, encoding: 'ascii', glyphs: false, le: true, upper: true, inspector: true,
  top: 0, rowsVisible: 10, rowH: 18, chW: 8,
  cursor: 0, anchor: 0, column: 'hex', nibble: 0,
  match: null, // { start, end }
  searchId: 0, searching: false, lastSearch: null, renders: 0, rendered: false,
  blocks: new Map(), pending: new Set(), copyFormats: [],
};
let el = {};

window.addEventListener('message', e => onMessage(e.data));
window.addEventListener('error', e => post({ type: 'error', message: String(e.message || e.error) }));
post({ type: 'ready' });

function onMessage(m) {
  switch (m.type) {
    case 'init': return init(m);
    case 'data': return onData(m);
    case 'patch': return onPatch(m);
    case 'saved': for (const b of S.blocks.values()) b.edited.clear(); return render();
    case 'reset': S.size = m.size; S.sizeText = m.sizeText; dropCache(); clampCursor(); return render();
    case 'changed':
      S.size = m.size; S.sizeText = m.sizeText; dropCache(); clampCursor(); S.match = null;
      if (m.message) notice(m.message, 'warn');
      return render();
    case 'notice': return notice(m.message, m.level);
    case 'copied': return hint(m.text);
    case 'goto': return gotoOffset(m.offset, true);
    case 'find': el.find && el.find.focus(); el.find && el.find.select(); return;
    case 'findNext': return runSearch(!!m.backward);
    case 'searchProgress': if (m.id === S.searchId) el.findInfo.textContent = `Searching ${Math.floor((100 * m.done) / Math.max(1, m.total))}%`; return;
    case 'searchResult': return onSearchResult(m);
    case 'config': applySettings(m.settings, false); return render();
  }
}

function applySettings(s, first) {
  S.settings = s || {};
  // A choice made in this tab (saved state) wins over the setting; otherwise the setting applies, also when it changes.
  S.bpr = saved.bpr || (ROW_SIZES.includes(s.bytesPerRow) ? s.bytesPerRow : 16);
  S.encoding = saved.encoding || (ENCODINGS.some(e => e[0] === s.encoding) ? s.encoding : 'ascii');
  S.le = saved.le !== undefined ? saved.le : s.littleEndian !== false;
  S.glyphs = s.controlChars === 'glyph';
  S.upper = s.uppercase !== false;
  if (first) S.inspector = saved.inspector === undefined ? s.showInspector !== false : saved.inspector;
  if (!first && S.loaded && el.grid) S.readOnly = !!S.fileReadOnly || !!s.readOnly;
  document.documentElement.style.setProperty('--hex-font-size', s.fontSize > 0 ? s.fontSize + 'px' : 'var(--vscode-editor-font-size, 13px)');
  if (el.bpr) { el.bpr.value = String(S.bpr); el.enc.value = S.encoding; }
  if (!first && el.rows) { measure(); layout(); }
}

function persist() { vscode.setState({ bpr: S.bpr, encoding: S.encoding, le: S.le, inspector: S.inspector, cursor: S.cursor }); }

// ---------- layout ----------

function init(m) {
  const app = document.getElementById('app');
  app.textContent = '';
  S.name = m.name;
  applySettings(m.settings || {}, true);
  if (m.error) {
    app.append($('div', { class: 'fatal', role: 'alert' }, $('h2', { text: `Hex Viewer cannot open ${m.name}` }), $('p', { text: m.error })));
    S.loaded = true; S.error = m.error;
    return;
  }
  S.size = m.size; S.sizeText = m.sizeText; S.fileType = m.fileType || ''; S.fileReadOnly = !!m.readOnly; S.readOnly = !!m.readOnly || !!S.settings.readOnly; S.readOnlyReason = m.readOnlyReason;
  S.copyFormats = m.copyFormats || [];
  if (saved.cursor && saved.cursor < S.size) { S.cursor = S.anchor = saved.cursor; }

  el.goto = $('input', { class: 'goto', type: 'text', placeholder: 'Go to offset', 'aria-label': 'Go to offset (hex 0x1F40, decimal, +/- relative)', spellcheck: 'false', title: 'Go to offset: 0x1F40, 8000, +0x100, -16 or end. Enter to jump.' });
  el.goto.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const r = parseOffset(el.goto.value, S.cursor, S.size); if (r.ok) { gotoOffset(r.offset, true); el.goto.classList.remove('bad'); el.grid.focus(); } else { el.goto.classList.add('bad'); hint(r.error); } }
    if (e.key === 'Escape') { el.grid.focus(); }
    e.stopPropagation();
  });
  el.find = $('input', { class: 'find', type: 'text', placeholder: 'Find', 'aria-label': 'Find bytes or text', spellcheck: 'false', title: 'Enter: next match. Shift+Enter: previous. Hex mode takes 4A 5B and ?? for any byte.' });
  // A click into Go to or Find selects the old text, so typing replaces it.
  for (const inp of [el.goto, el.find]) {
    let fresh = false;
    inp.addEventListener('focus', () => { inp.select(); fresh = true; });
    inp.addEventListener('mouseup', e => { if (fresh) { e.preventDefault(); fresh = false; } });
    inp.addEventListener('blur', () => { fresh = false; });
  }
  el.find.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey); }
    if (e.key === 'Escape') { if (S.searching) cancelSearch(); else el.grid.focus(); }
    e.stopPropagation();
  });
  el.mode = $('select', { 'aria-label': 'Find as', title: 'Find as' }, $('option', { value: 'hex', text: 'Hex' }), $('option', { value: 'text', text: 'Text' }), $('option', { value: 'utf16', text: 'UTF-16' }));
  el.mode.value = saved.mode || 'hex';
  el.mode.addEventListener('change', () => { saved.mode = el.mode.value; });
  el.ic = $('button', { class: 'tog', 'aria-pressed': 'false', title: 'Ignore case (text search)', 'aria-label': 'Ignore case', text: 'Aa' });
  el.ic.addEventListener('click', () => el.ic.setAttribute('aria-pressed', String(el.ic.getAttribute('aria-pressed') !== 'true')));
  el.prev = $('button', { title: 'Previous match (Shift+Enter)', 'aria-label': 'Previous match', text: '↑', onclick: () => runSearch(true) });
  el.next = $('button', { title: 'Next match (Enter)', 'aria-label': 'Next match', text: '↓', onclick: () => runSearch(false) });
  el.findInfo = $('span', { class: 'findinfo', 'aria-live': 'polite' });
  el.bpr = $('select', { 'aria-label': 'Bytes per row', title: 'Bytes per row' }, ...ROW_SIZES.map(n => $('option', { value: String(n), text: `${n} / row` })));
  el.bpr.value = String(S.bpr);
  el.bpr.addEventListener('change', () => { S.bpr = Number(el.bpr.value); saved.bpr = S.bpr; layout(); scrollToCursor(true); persist(); });
  el.enc = $('select', { 'aria-label': 'Text encoding', title: 'Text column encoding' }, ...ENCODINGS.map(([v, t]) => $('option', { value: v, text: t })));
  el.enc.value = S.encoding;
  el.enc.addEventListener('change', () => { S.encoding = el.enc.value; saved.encoding = S.encoding; persist(); render(); });
  el.copy = $('select', { 'aria-label': 'Copy selection as', title: 'Copy the selection as...' }, $('option', { value: '', text: 'Copy as...' }), ...S.copyFormats.map(([v, t]) => $('option', { value: v, text: t })));
  el.copy.addEventListener('change', () => { if (el.copy.value) copySel(el.copy.value); el.copy.value = ''; el.grid.focus(); });
  el.insBtn = $('button', { class: 'tog', 'aria-pressed': String(S.inspector), title: 'Show or hide the data inspector', text: 'Inspector', onclick: () => { S.inspector = !S.inspector; el.insBtn.setAttribute('aria-pressed', String(S.inspector)); el.side.hidden = !S.inspector; persist(); layout(); } });

  el.toolbar = $('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Hex Viewer tools' },
    el.goto, $('span', { class: 'sep' }), el.find, el.mode, el.ic, el.prev, el.next, el.findInfo,
    $('span', { class: 'grow' }), el.bpr, el.enc, el.copy, el.insBtn);
  el.banner = $('div', { class: 'banner', hidden: true, role: 'status' });
  el.grid = $('div', { class: 'grid', tabindex: '0', role: 'grid', 'aria-label': `Bytes of ${m.name}. Arrow keys move, Shift extends the selection, Tab switches between the hex and text columns.`, 'aria-readonly': String(S.readOnly) });
  el.head = $('div', { class: 'head', 'aria-hidden': 'true' });
  el.rows = $('div', { class: 'rows' });
  el.empty = $('div', { class: 'empty', hidden: true, text: 'This file is empty (0 bytes). There is nothing to show.' });
  el.thumb = $('div', { class: 'thumb' });
  el.track = $('div', { class: 'track', 'aria-hidden': 'true' }, el.thumb);
  el.gridWrap = $('div', { class: 'gridwrap' }, el.head, el.rows, el.empty);
  el.view = $('div', { class: 'view' }, el.gridWrap, el.track);
  el.grid.append(el.view);
  el.leBtn = $('button', { class: 'link', title: 'Switch byte order', onclick: () => { S.le = !S.le; saved.le = S.le; persist(); renderInspector(); } });
  el.insBody = $('div', { class: 'ins' });
  el.side = $('aside', { class: 'side', 'aria-label': 'Data inspector', hidden: !S.inspector }, $('h2', {}, 'Data inspector ', el.leBtn), el.insBody);
  el.main = $('div', { class: 'main' }, el.grid, el.side);
  el.status = $('div', { class: 'status' });
  el.stPos = $('span', { class: 'pos' });
  el.stSel = $('span', { class: 'selinfo' });
  el.stInfo = $('span', { class: 'info' });
  el.stHint = $('span', { class: 'hint', 'aria-live': 'polite' });
  el.live = $('div', { class: 'sr', 'aria-live': 'polite' });
  const foot = document.getElementById('zovo-footer');
  el.status.append(el.stPos, el.stSel, el.stInfo, el.stHint, $('span', { class: 'grow' }));
  if (foot && foot.content) el.status.append(foot.content.cloneNode(true));
  app.append(el.toolbar, el.banner, el.main, el.status, el.live);

  el.grid.addEventListener('keydown', onKey);
  el.grid.addEventListener('blur', () => { if (S.pendingByte) { commitPending(); S.nibble = 0; render(); } });
  window.addEventListener('blur', () => { if (S.pendingByte) { commitPending(); S.nibble = 0; render(); } });
  el.grid.addEventListener('wheel', onWheel, { passive: false });
  el.rows.addEventListener('mousedown', onMouseDown);
  el.track.addEventListener('mousedown', onTrack);
  document.addEventListener('keydown', onGlobalKey);
  document.addEventListener('copy', onCopy);
  document.addEventListener('paste', onPaste);
  new ResizeObserver(() => layout()).observe(el.gridWrap);
  for (const off of m.edited || []) markEdited(off);
  S.loaded = true;
  measure();
  layout();
  scrollToCursor(true);
  el.grid.focus();
}

function measure() {
  const probe = $('span', { class: 'measure', text: '0'.repeat(32) });
  el.rows.append(probe);
  const r = probe.getBoundingClientRect();
  S.chW = r.width / 32 || 8;
  S.rowH = Math.max(14, Math.round(r.height * 1.35)) || 18;
  probe.remove();
  document.documentElement.style.setProperty('--row-h', S.rowH + 'px');
}

function totalRows() { return Math.max(1, Math.ceil(S.size / S.bpr)); }
function maxTop() { return Math.max(0, totalRows() - S.rowsVisible + 1); }
function offDigits() { return Math.max(8, Math.max(0, S.size - 1).toString(16).length); }

function layout() {
  if (!el.rows) return;
  const h = el.gridWrap.clientHeight - el.head.offsetHeight;
  S.rowsVisible = Math.max(1, Math.floor(h / S.rowH));
  S.top = Math.min(S.top, maxTop());
  render();
}

// ---------- data cache ----------

function dropCache() { S.blocks.clear(); S.pending.clear(); }

function markEdited(off) {
  const b = S.blocks.get(Math.floor(off / BLOCK));
  if (b) b.edited.add(off);
  else (S.lateEdits || (S.lateEdits = new Set())).add(off);
}

function onData(m) {
  const k = Math.floor(m.offset / BLOCK);
  S.pending.delete(k);
  if (m.size !== undefined && m.size !== S.size) { S.size = m.size; }
  const bytes = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes);
  const edited = new Set(m.edited || []);
  S.blocks.set(k, { bytes, edited });
  if (S.blocks.size > MAX_BLOCKS) {
    const keep = visibleBlocks();
    for (const key of S.blocks.keys()) { if (S.blocks.size <= MAX_BLOCKS) break; if (!keep.has(key)) S.blocks.delete(key); }
  }
  scheduleRender();
}

function onPatch(m) {
  const bytes = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes);
  const marks = new Set(m.edited || []);
  for (let i = 0; i < bytes.length; i++) {
    const off = m.offset + i;
    const b = S.blocks.get(Math.floor(off / BLOCK));
    if (!b) continue;
    const j = off - Math.floor(off / BLOCK) * BLOCK;
    if (j < b.bytes.length) b.bytes[j] = bytes[i];
    if (marks.has(off)) b.edited.add(off); else b.edited.delete(off);
  }
  scheduleRender();
}

function byteAt(off) {
  const b = S.blocks.get(Math.floor(off / BLOCK));
  if (!b) return -1;
  const j = off % BLOCK;
  return j < b.bytes.length ? b.bytes[j] : -1;
}
function isEdited(off) { const b = S.blocks.get(Math.floor(off / BLOCK)); return !!b && b.edited.has(off); }

/** Up to n cached bytes from off; stops at the first byte that is not loaded. */
function bytesFrom(off, n) {
  const out = [];
  for (let i = 0; i < n && off + i < S.size; i++) { const v = byteAt(off + i); if (v < 0) break; out.push(v); }
  return Uint8Array.from(out);
}

function visibleBlocks() {
  const first = S.top * S.bpr, last = Math.min(S.size, (S.top + S.rowsVisible + 1) * S.bpr + 4);
  const set = new Set();
  for (let k = Math.floor(first / BLOCK); k * BLOCK < last; k++) set.add(k);
  return set;
}

function requestVisible() {
  const want = visibleBlocks();
  // one block of read-ahead below the screen
  const after = Math.floor(Math.min(S.size - 1, (S.top + S.rowsVisible * 2) * S.bpr) / BLOCK);
  want.add(after);
  const ci = Math.floor(S.cursor / BLOCK); want.add(ci); if ((S.cursor % BLOCK) > BLOCK - 16) want.add(ci + 1);
  for (const k of want) {
    if (k * BLOCK >= S.size || S.blocks.has(k) || S.pending.has(k)) continue;
    S.pending.add(k);
    post({ type: 'read', offset: k * BLOCK, length: Math.min(BLOCK, S.size - k * BLOCK) });
  }
}

// ---------- rendering ----------

let raf = 0;
function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

function selRange() { return [Math.min(S.anchor, S.cursor), Math.max(S.anchor, S.cursor) + 1]; }

function render() {
  if (!el.rows || !S.loaded) return;
  if (S.lateEdits) { for (const off of [...S.lateEdits]) { const b = S.blocks.get(Math.floor(off / BLOCK)); if (b) { b.edited.add(off); S.lateEdits.delete(off); } } }
  const bpr = S.bpr, digits = offDigits();
  el.empty.hidden = S.size > 0;
  // header
  let h = `<span class="off">${'Offset'.padEnd(digits, ' ')}</span><span class="hx">`;
  for (let i = 0; i < bpr; i++) h += `<span class="b${i && i % 8 === 0 ? ' g' : ''}">${hex2(i % 256)}</span>`;
  h += `</span><span class="tx">${esc(ENCODINGS.find(e => e[0] === S.encoding)[1])}</span>`;
  el.head.innerHTML = S.upper ? h : h.toLowerCase().replace('offset', 'Offset');
  if (!S.size) { el.rows.innerHTML = ''; updateStatus(); updateThumb(); return; }
  const [s0, s1] = selRange();
  const multi = s1 - s0 > 1;
  const m = S.match;
  let html = '';
  let missing = false;
  for (let r = 0; r < S.rowsVisible; r++) {
    const row = S.top + r;
    const start = row * bpr;
    if (start >= S.size) break;
    const count = Math.min(bpr, S.size - start);
    const rowBytes = bytesFrom(start, count + 3);
    if (rowBytes.length < count) missing = true;
    const cells = rowBytes.length >= count ? textCells(rowBytes, count, S.encoding, start, S.glyphs) : null;
    let hx = '', tx = '';
    for (let i = 0; i < bpr; i++) {
      const off = start + i;
      const g = i && i % 8 === 0 ? ' g' : '';
      if (i >= count) { hx += `<span class="b e${g}"></span>`; tx += '<span class="c e"></span>'; continue; }
      const v = i < rowBytes.length ? rowBytes[i] : -1;
      let cls = '';
      if (v === 0) cls += ' z';
      if (multi && off >= s0 && off < s1) cls += ' sel';
      if (m && off >= m.start && off < m.end) cls += ' m';
      if (isEdited(off)) cls += ' ed';
      const hs = v < 0 ? '  ' : (S.upper ? hex2(v) : hex2(v).toLowerCase());
      const atCur = off === S.cursor;
      const hcur = atCur ? (S.column === 'hex' ? ' cur' + (S.nibble ? ' nib' : '') : ' cur2') : '';
      hx += `<span class="b${g}${cls}${hcur}" data-o="${i}">${hs}</span>`;
      const c = cells ? cells[i] : { ch: ' ', kind: 'c' };
      let tcls = cls + (atCur ? (S.column === 'text' ? ' cur' : ' cur2') : '');
      if (c.kind !== 'p') tcls += ' np';
      tx += `<span class="c${tcls}" data-o="${i}">${c.ch === ' ' ? ' ' : esc(c.ch)}</span>`;
    }
    html += `<div class="row" data-r="${start}"><span class="off">${S.upper ? hexOffset(start, digits) : hexOffset(start, digits).toLowerCase()}</span><span class="hx">${hx}</span><span class="tx">${tx}</span></div>`;
  }
  el.rows.innerHTML = html;
  S.renders++;
  updateThumb();
  updateStatus();
  renderInspector();
  requestVisible();
  if (!missing && !S.rendered) { S.rendered = true; post({ type: 'rendered' }); }
}

function updateThumb() {
  const H = el.track.clientHeight;
  const total = totalRows();
  if (total <= S.rowsVisible) { el.track.classList.add('off'); return; }
  el.track.classList.remove('off');
  const th = Math.max(24, Math.round((H * S.rowsVisible) / total));
  const mt = maxTop();
  el.thumb.style.height = th + 'px';
  el.thumb.style.transform = `translateY(${mt ? Math.round(((H - th) * S.top) / mt) : 0}px)`;
}

function updateStatus() {
  const [s0, s1] = selRange();
  el.stPos.textContent = `Offset 0x${hexOffset(S.cursor, 1)} (${fmtInt(S.cursor)})`;
  el.stSel.textContent = s1 - s0 > 1 ? `${fmtInt(s1 - s0)} bytes selected (0x${hexOffset(s0, 1)} to 0x${hexOffset(s1 - 1, 1)})` : '';
  const mode = S.readOnly ? 'Read-only' : S.column === 'hex' ? 'Overwrite (hex)' : 'Overwrite (text)';
  el.stInfo.textContent = [S.fileType, S.sizeText, mode].filter(Boolean).join(' · ');
  el.stInfo.title = S.readOnly ? (S.readOnlyReason || 'Editing is off (setting hexViewer.readOnly).') : 'Type hex digits (or text in the text column) to overwrite bytes. Ctrl+Z undoes, Ctrl+S saves.';
  clearTimeout(S.cursorTimer);
  S.cursorTimer = setTimeout(() => post({ type: 'cursor', offset: S.cursor, selStart: s0, selEnd: s1 }), 60);
}

function renderInspector() {
  if (!el.insBody || !S.inspector) return;
  el.leBtn.textContent = S.le ? 'Little-endian' : 'Big-endian';
  el.leBtn.title = 'Byte order for the numbers below. Click to switch.';
  // With a selection, the inspector reads from its first byte (select 4 bytes, read them as one number).
  const at = selRange()[0];
  const b = bytesFrom(at, 16);
  if (!b.length && S.size) { el.insBody.textContent = 'Loading...'; return; }
  const rows = inspect(b, at, S.le);
  let html = '';
  for (const [k, v] of rows) html += `<div class="ir"><span class="k">${esc(k)}</span><span class="v">${v ? esc(v) : '<span class="na">-</span>'}</span></div>`;
  const [s0, s1] = selRange();
  if (s1 - s0 > 1) html += `<div class="ir"><span class="k">Selection</span><span class="v">${fmtInt(s1 - s0)} bytes</span></div>`;
  el.insBody.innerHTML = html;
}

// ---------- movement ----------

function clampCursor() {
  const last = Math.max(0, S.size - 1);
  S.cursor = Math.min(S.cursor, last); S.anchor = Math.min(S.anchor, last);
  S.top = Math.min(S.top, maxTop());
}

function scrollToCursor(center) {
  const row = Math.floor(S.cursor / S.bpr);
  if (center) S.top = Math.max(0, Math.min(maxTop(), row - Math.floor(S.rowsVisible / 3)));
  else if (row < S.top) S.top = row;
  else if (row >= S.top + S.rowsVisible - 1) S.top = Math.min(maxTop(), row - S.rowsVisible + 2);
  render();
}

function moveTo(off, extend) {
  if (!S.size) return;
  commitPending();
  S.cursor = Math.max(0, Math.min(S.size - 1, off));
  if (!extend) S.anchor = S.cursor;
  S.nibble = 0;
  scrollToCursor(false);
  announce();
  persist();
}

function gotoOffset(off, center) {
  commitPending();
  S.cursor = S.anchor = Math.max(0, Math.min(Math.max(0, S.size - 1), off));
  S.nibble = 0; S.match = null;
  scrollToCursor(center);
  announce();
  el.grid && el.grid.focus();
}

function announce() {
  clearTimeout(S.liveTimer);
  S.liveTimer = setTimeout(() => {
    const v = byteAt(S.cursor);
    el.live.textContent = v < 0 ? `Offset ${hexOffset(S.cursor, 1)}` : `Offset ${hexOffset(S.cursor, 1)} hex, byte ${hex2(v)}, decimal ${v}${v >= 32 && v < 127 ? ', character ' + String.fromCharCode(v) : ''}`;
  }, 250);
}

function onWheel(e) {
  e.preventDefault();
  const lines = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * S.rowsVisible : e.deltaY / S.rowH;
  S.wheelAcc = (S.wheelAcc || 0) + lines;
  const step = Math.trunc(S.wheelAcc);
  if (!step) return;
  S.wheelAcc -= step;
  S.top = Math.max(0, Math.min(maxTop(), S.top + step));
  scheduleRender();
}

function onTrack(e) {
  e.preventDefault();
  const H = el.track.clientHeight, th = el.thumb.offsetHeight;
  const rect = el.track.getBoundingClientRect();
  const onThumb = e.target === el.thumb;
  const grab = onThumb ? e.clientY - el.thumb.getBoundingClientRect().top : th / 2;
  const to = y => { const f = Math.max(0, Math.min(1, (y - rect.top - grab) / Math.max(1, H - th))); S.top = Math.round(f * maxTop()); scheduleRender(); };
  to(e.clientY);
  const mv = ev => to(ev.clientY);
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}

function cellAt(target) {
  const cell = target.closest && target.closest('.b,.c');
  if (!cell || cell.classList.contains('e') || cell.dataset.o === undefined) return null;
  const row = cell.closest('.row');
  return { off: Number(row.dataset.r) + Number(cell.dataset.o), column: cell.classList.contains('b') ? 'hex' : 'text' };
}

function onMouseDown(e) {
  const c = cellAt(e.target);
  if (!c) return;
  e.preventDefault();
  el.grid.focus();
  S.column = c.column;
  moveTo(c.off, e.shiftKey);
  const mv = ev => {
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const d = t && cellAt(t);
    if (d && d.off !== S.cursor) { S.cursor = d.off; render(); }
    const r = el.rows.getBoundingClientRect();
    if (ev.clientY > r.bottom - 4 && S.top < maxTop()) { S.top++; S.cursor = Math.min(S.size - 1, S.cursor + S.bpr); render(); }
    if (ev.clientY < r.top + 4 && S.top > 0) { S.top--; S.cursor = Math.max(0, S.cursor - S.bpr); render(); }
  };
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); announce(); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}

function onGlobalKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && S.pendingByte && /^[szSZ]$/.test(e.key)) { commitPending(); S.nibble = 0; render(); }
  if (mod && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); el.find.focus(); el.find.select(); return; }
  if (mod && !e.shiftKey && !e.altKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); post({ type: 'gotoPrompt' }); return; }
  if (e.key === 'F3') { e.preventDefault(); runSearch(e.shiftKey); }
}

function onKey(e) {
  if (!S.size) return;
  const mod = e.ctrlKey || e.metaKey;
  const ext = e.shiftKey;
  const page = Math.max(1, S.rowsVisible - 1) * S.bpr;
  let to = null;
  switch (e.key) {
    case 'ArrowLeft': to = S.cursor - 1; break;
    case 'ArrowRight': to = S.cursor + 1; break;
    case 'ArrowUp': to = S.cursor - S.bpr; if (to < 0) to = S.cursor; break;
    case 'ArrowDown': to = S.cursor + S.bpr; if (to > S.size - 1) to = S.cursor; break;
    case 'PageUp': to = S.cursor - page; if (to < 0) to = S.cursor % S.bpr; S.top = Math.max(0, S.top - S.rowsVisible + 1); break;
    case 'PageDown': to = S.cursor + page; if (to > S.size - 1) to = S.size - 1; S.top = Math.min(maxTop(), S.top + S.rowsVisible - 1); break;
    case 'Home': to = mod ? 0 : S.cursor - (S.cursor % S.bpr); break;
    case 'End': to = mod ? S.size - 1 : Math.min(S.size - 1, S.cursor - (S.cursor % S.bpr) + S.bpr - 1); break;
    case 'Tab': e.preventDefault(); commitPending(); S.column = S.column === 'hex' ? 'text' : 'hex'; S.nibble = 0; render(); return;
    case 'Escape': S.anchor = S.cursor; S.match = null; render(); return;
  }
  if (to !== null) { e.preventDefault(); moveTo(to, ext); return; }
  if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); S.anchor = 0; S.cursor = S.size - 1; render(); return; }
  if (mod || e.altKey || e.key.length !== 1) return;
  // typing overwrites
  if (S.column === 'hex') {
    if (!/^[0-9a-fA-F]$/.test(e.key)) return;
    e.preventDefault();
    if (S.readOnly) return readOnlyHint();
    const d = parseInt(e.key, 16);
    const old = byteAt(S.cursor);
    if (old < 0) return hint('That row is still loading.');
    if (S.nibble === 0) {
      // First digit: shown at once, sent with the second digit (one undo step per byte).
      S.pendingByte = { off: S.cursor, value: (d << 4) | (old & 15) };
      setLocal(S.cursor, S.pendingByte.value);
      S.nibble = 1; render();
    } else {
      const v = (old & 0xf0) | d;
      S.pendingByte = null;
      writeBytes(S.cursor, [v], 'Edit byte');
      S.nibble = 0;
      if (S.cursor < S.size - 1) moveTo(S.cursor + 1, false); else render();
    }
  } else {
    const v = byteForChar(e.key, S.encoding === 'latin1' || S.encoding === 'ebcdic' ? S.encoding : 'ascii');
    if (v < 0) return;
    e.preventDefault();
    if (S.readOnly) return readOnlyHint();
    commitPending();
    writeBytes(S.cursor, [v], 'Type text');
    if (S.cursor < S.size - 1) moveTo(S.cursor + 1, false); else render();
  }
}

function setLocal(o, v) {
  const b = S.blocks.get(Math.floor(o / BLOCK));
  if (b && o % BLOCK < b.bytes.length) { b.bytes[o % BLOCK] = v; b.edited.add(o); }
}

/** A first hex digit with no second one yet is written when the cursor leaves the byte. */
function commitPending() {
  const p = S.pendingByte;
  S.pendingByte = null;
  if (p) writeBytes(p.off, [p.value], 'Edit byte');
}

function readOnlyHint() { hint(S.readOnlyReason || 'Editing is off (setting hexViewer.readOnly).'); }

/** Write bytes now in the view and send them to the host, which keeps the undo stack. */
function writeBytes(off, values, label) {
  for (let i = 0; i < values.length; i++) {
    const o = off + i;
    const b = S.blocks.get(Math.floor(o / BLOCK));
    if (b && o % BLOCK < b.bytes.length) { b.bytes[o % BLOCK] = values[i]; b.edited.add(o); }
  }
  post({ type: 'edit', offset: off, values: Uint8Array.from(values), label });
}

// ---------- clipboard ----------

function inField() { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'); }

function copySel(format) {
  const [s0, s1] = selRange();
  post({ type: 'copy', start: s0, end: s1, format });
}

function onCopy(e) {
  if (inField() || !S.size) return;
  e.preventDefault();
  copySel(S.column === 'text' ? 'latin1' : (S.settings.copyFormat || 'hexSpaced'));
}

function onPaste(e) {
  if (inField() || !S.size) return;
  e.preventDefault();
  if (S.readOnly) return readOnlyHint();
  commitPending(); S.nibble = 0;
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  let bytes = null;
  if (S.column === 'hex') {
    bytes = parseHexPaste(text);
    if (!bytes) return hint('Paste hex digits here (like 4A 5B 00). To paste text, click in the text column first.');
  } else {
    bytes = Uint8Array.from([...text].map(ch => byteForChar(ch, S.encoding === 'latin1' || S.encoding === 'ebcdic' ? S.encoding : 'latin1')).filter(v => v >= 0));
  }
  if (!bytes.length) return;
  const n = Math.min(bytes.length, S.size - S.cursor);
  writeBytes(S.cursor, bytes.subarray(0, n), 'Paste');
  hint(`Pasted ${fmtInt(n)} byte${n === 1 ? '' : 's'} over the bytes at the cursor${n < bytes.length ? ' (the rest did not fit before the end of the file)' : ''}.`);
  moveTo(Math.min(S.size - 1, S.cursor + n), false);
}

// ---------- search ----------

function runSearch(backward) {
  const q = el.find.value;
  if (!q) { el.find.focus(); return; }
  const [s0] = selRange();
  let from;
  if (backward) from = Math.max(0, (S.match ? S.match.start : S.cursor) - 1);
  else from = S.match && S.match.start === s0 ? S.match.start + 1 : S.cursor;
  if (backward && (S.match ? S.match.start : S.cursor) === 0) from = S.size; // wrap from the end
  S.searchId++;
  S.searching = true;
  S.lastSearch = { q, backward, from, mode: el.mode.value };
  el.findInfo.textContent = 'Searching...';
  el.findInfo.classList.remove('bad');
  post({ type: 'search', query: q, mode: el.mode.value, ignoreCase: el.ic.getAttribute('aria-pressed') === 'true', from, backward, id: S.searchId });
}

function cancelSearch() { post({ type: 'cancelSearch' }); S.searching = false; el.findInfo.textContent = 'Stopped.'; }

function onSearchResult(m) {
  if (m.id !== S.searchId) return;
  S.searching = false;
  S.lastResult = m;
  if (m.error) { el.findInfo.textContent = m.error; el.findInfo.classList.add('bad'); return; }
  if (m.cancelled) { el.findInfo.textContent = 'Stopped.'; return; }
  if (m.offset < 0) { el.findInfo.textContent = 'No match'; el.findInfo.classList.add('bad'); S.match = null; render(); return; }
  S.match = { start: m.offset, end: m.offset + m.length };
  const row = Math.floor(m.offset / S.bpr);
  if (row < S.top || row >= S.top + S.rowsVisible - 1) S.top = Math.max(0, Math.min(maxTop(), row - Math.floor(S.rowsVisible / 3)));
  S.cursor = m.offset; S.anchor = m.offset + m.length - 1;
  el.findInfo.textContent = `Match at 0x${hexOffset(m.offset, 1)}${m.wrapped ? ' (wrapped)' : ''}`;
  render();
  announce();
}

// ---------- notices ----------

function notice(text, level) {
  if (!el.banner) { const app = document.getElementById('app'); app.append($('div', { class: 'banner ' + (level || ''), role: 'alert', text })); return; }
  el.banner.textContent = '';
  el.banner.className = 'banner ' + (level || '');
  el.banner.append($('span', { text }), $('button', { class: 'link', text: 'Dismiss', onclick: () => { el.banner.hidden = true; layout(); } }));
  el.banner.hidden = false;
  layout();
}

function hint(text) {
  if (!el.stHint) return;
  el.stHint.textContent = text;
  clearTimeout(S.hintTimer);
  S.hintTimer = setTimeout(() => { el.stHint.textContent = ''; }, 6000);
}

// For the release check in a real VS Code (scripts/e2e-vscode.mjs). Read-only.
window.hexViewerProbe = () => {
  const [s0, s1] = selRange();
  const first = el.rows && el.rows.querySelector('.row');
  const lastRow = el.rows && [...el.rows.querySelectorAll('.row')].pop();
  return {
    loaded: S.loaded, error: S.error || null, size: S.size, top: S.top, rowsVisible: S.rowsVisible, bpr: S.bpr, encoding: S.encoding,
    cursor: S.cursor, selStart: s0, selEnd: s1, column: S.column, readOnly: S.readOnly, fileType: S.fileType, rendered: S.rendered,
    firstRow: first ? Number(first.dataset.r) : null, lastRow: lastRow ? Number(lastRow.dataset.r) : null,
    lastRowText: lastRow ? lastRow.textContent : '', blocks: S.blocks.size, match: S.match, findInfo: el.findInfo ? el.findInfo.textContent : '',
    banner: el.banner && !el.banner.hidden ? el.banner.textContent : '', hint: el.stHint ? el.stHint.textContent : '', le: S.le,
    inspector: el.insBody ? [...el.insBody.querySelectorAll('.ir')].map(r => [r.children[0].textContent, r.children[1].textContent]) : [],
    status: el.status ? el.status.textContent : '',
  };
};
