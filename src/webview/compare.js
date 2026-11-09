// Hex Viewer compare view. Two files side by side, offset by offset. Only the rows on screen are drawn;
// bytes come from the extension host in 64 KB blocks, so 4 GB and larger files scroll to the end.
import { hexOffset, fmtInt, parseOffset, textCells, hex2 } from '../core/bytes.js';

const vscode = acquireVsCodeApi();
const post = m => vscode.postMessage(m);
const BLOCK = 65536;
const MAX_BLOCKS = 96;
const $ = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const saved = vscode.getState() || {};
const S = {
  loaded: false, a: null, b: null, size: 0, bprChoice: saved.bpr || 'auto', bpr: 16, upper: true,
  top: 0, rowsVisible: 10, rowH: 18, chW: 8, cursor: 0, blocks: new Map(), pending: new Set(),
  diffId: 0, seeking: false, stats: null, rendered: false, lastDiff: null,
};
let el = {};

window.addEventListener('message', e => onMessage(e.data));
window.addEventListener('error', e => post({ type: 'error', message: String(e.message || e.error) }));
post({ type: 'ready' });

function onMessage(m) {
  switch (m.type) {
    case 'init': return init(m);
    case 'data': return onData(m);
    case 'diffProgress': if (m.id === S.diffId) el.info.textContent = `Looking ${Math.floor((100 * m.done) / Math.max(1, m.total))}%`; return;
    case 'diffResult': return onDiff(m);
    case 'statsProgress': el.sum.textContent = `Counting differences ${Math.floor((100 * m.done) / Math.max(1, m.total))}%`; return;
    case 'stats': return onStats(m);
    case 'notice': el.info.textContent = m.message; el.info.classList.add('bad'); return;
    case 'pro': document.body.classList.toggle('licensed', !!m.licensed); if (m.licensed) document.body.classList.remove('nopro'); return;
  }
}

function init(m) {
  S.a = m.a; S.b = m.b; S.size = Math.max(m.a.size, m.b.size);
  S.upper = !m.settings || m.settings.uppercase !== false;
  if (m.settings && m.settings.fontSize > 0) document.documentElement.style.setProperty('--hex-font-size', m.settings.fontSize + 'px');
  const app = document.getElementById('app');
  app.textContent = '';
  el.prev = $('button', { title: 'Previous difference (Shift+F7)', 'aria-label': 'Previous difference', text: '↑ Previous', onclick: () => seek(true) });
  el.next = $('button', { title: 'Next difference (F7)', 'aria-label': 'Next difference', text: '↓ Next difference', onclick: () => seek(false) });
  el.info = $('span', { class: 'findinfo', 'aria-live': 'polite' });
  el.goto = $('input', { class: 'goto', type: 'text', placeholder: 'Go to offset', 'aria-label': 'Go to offset', spellcheck: 'false', title: 'Go to offset: 0x1F40, 8000, +0x100, -16 or end. Enter to jump.' });
  el.goto.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { const r = parseOffset(el.goto.value, S.cursor, S.size); if (r.ok) { el.goto.classList.remove('bad'); moveTo(r.offset, true); el.grid.focus(); } else { el.goto.classList.add('bad'); el.info.textContent = r.error; } }
    if (e.key === 'Escape') el.grid.focus();
  });
  el.bpr = $('select', { 'aria-label': 'Bytes per row', title: 'Bytes per row' }, ...[['auto', 'Fit width'], ['8', '8 / row'], ['16', '16 / row'], ['32', '32 / row']].map(([v, t]) => $('option', { value: v, text: t })));
  el.bpr.value = String(S.bprChoice);
  el.bpr.addEventListener('change', () => { S.bprChoice = el.bpr.value; vscode.setState({ bpr: S.bprChoice }); layout(); scrollToCursor(true); });
  el.sum = $('span', { class: 'findinfo sum', 'aria-live': 'polite', text: 'Counting differences...' });
  // Hex Viewer Pro: every differing range to a text, CSV or JSON file
  el.report = $('button', { class: 'withpro', title: 'Save every differing range to a text, CSV or JSON report (Hex Viewer Pro)', text: 'Export report', onclick: () => post({ type: 'report' }) },
    $('span', { class: 'pro', 'aria-label': 'Pro feature', text: 'PRO' }));
  document.body.classList.toggle('licensed', !!m.licensed);
  document.body.classList.toggle('nopro', !!(m.settings && m.settings.showPro === false) && !m.licensed);
  el.toolbar = $('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Compare tools' }, el.prev, el.next, el.info, $('span', { class: 'sep' }), el.goto, $('span', { class: 'grow' }), el.sum, el.report, el.bpr);
  el.grid = $('div', { class: 'grid', tabindex: '0', role: 'grid', 'aria-label': `Compare ${m.a.name} and ${m.b.name}. F7 goes to the next difference, Shift+F7 to the previous one.` });
  el.head = $('div', { class: 'head', 'aria-hidden': 'true' });
  el.rows = $('div', { class: 'rows' });
  el.thumb = $('div', { class: 'thumb' });
  el.marks = $('div', { class: 'marks' });
  el.track = $('div', { class: 'track', 'aria-hidden': 'true' }, el.marks, el.thumb);
  el.gridWrap = $('div', { class: 'gridwrap' }, el.head, el.rows);
  el.view = $('div', { class: 'view' }, el.gridWrap, el.track);
  el.grid.append(el.view);
  el.main = $('div', { class: 'main' }, el.grid);
  el.files = $('div', { class: 'banner files' },
    $('span', { class: 'fa', text: `A: ${m.a.name} (${m.a.sizeText})`, title: m.a.path }),
    $('span', { class: 'fb', text: `B: ${m.b.name} (${m.b.sizeText})`, title: m.b.path }),
    m.a.size !== m.b.size ? $('span', { class: 'warnsz', text: `The sizes differ by ${fmtInt(Math.abs(m.a.size - m.b.size))} bytes. Bytes past the end of the shorter file count as different.` }) : null);
  el.status = $('div', { class: 'status' });
  el.stPos = $('span', { class: 'pos' });
  el.stVal = $('span', { class: 'info' });
  el.live = $('div', { class: 'sr', 'aria-live': 'polite' });
  el.status.append(el.stPos, el.stVal, $('span', { class: 'grow' }));
  const foot = document.getElementById('zovo-footer');
  if (foot && foot.content) el.status.append(foot.content.cloneNode(true));
  app.append(el.toolbar, el.files, el.main, el.status, el.live);
  el.grid.addEventListener('keydown', onKey);
  document.addEventListener('keydown', e => { if (e.key === 'F7') { e.preventDefault(); seek(e.shiftKey); } });
  el.grid.addEventListener('wheel', onWheel, { passive: false });
  el.rows.addEventListener('mousedown', onMouseDown);
  el.track.addEventListener('mousedown', onTrack);
  new ResizeObserver(() => layout()).observe(el.gridWrap);
  S.loaded = true;
  measure();
  layout();
  el.grid.focus();
  post({ type: 'stats' });
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
  if (S.bprChoice === 'auto') {
    // offset + 2 x (hex 3.2 ch per byte + text 1 ch per byte) + gaps
    const avail = el.gridWrap.clientWidth / S.chW - offDigits() - 10;
    S.bpr = avail >= 32 * 8.6 ? 32 : avail >= 16 * 8.6 ? 16 : 8;
  } else S.bpr = Number(S.bprChoice) || 16;
  const h = el.gridWrap.clientHeight - el.head.offsetHeight;
  S.rowsVisible = Math.max(1, Math.floor(h / S.rowH));
  S.top = Math.min(S.top, maxTop());
  render();
}

function onData(m) {
  const k = Math.floor(m.offset / BLOCK);
  S.pending.delete(k);
  S.blocks.set(k, { a: new Uint8Array(m.a), b: new Uint8Array(m.b) });
  if (S.blocks.size > MAX_BLOCKS) { const keep = visibleBlocks(); for (const key of S.blocks.keys()) { if (S.blocks.size <= MAX_BLOCKS) break; if (!keep.has(key)) S.blocks.delete(key); } }
  scheduleRender();
}

function visibleBlocks() {
  const first = S.top * S.bpr, last = Math.min(S.size, (S.top + S.rowsVisible + 1) * S.bpr + 4);
  const set = new Set();
  for (let k = Math.floor(first / BLOCK); k * BLOCK < last; k++) set.add(k);
  return set;
}

function requestVisible() {
  const want = visibleBlocks();
  want.add(Math.floor(S.cursor / BLOCK));
  for (const k of want) {
    if (k * BLOCK >= S.size || S.blocks.has(k) || S.pending.has(k)) continue;
    S.pending.add(k);
    post({ type: 'read', offset: k * BLOCK, length: Math.min(BLOCK, S.size - k * BLOCK) });
  }
}

/** Byte of side 'a' or 'b' at off: -1 loading, -2 past the end of that file. */
function byteAt(side, off) {
  const f = S[side];
  if (off >= f.size) return -2;
  const blk = S.blocks.get(Math.floor(off / BLOCK));
  if (!blk) return -1;
  const arr = blk[side], j = off % BLOCK;
  return j < arr.length ? arr[j] : -2;
}

function rowBytes(side, start, count) {
  const out = [];
  for (let i = 0; i < count; i++) { const v = byteAt(side, start + i); if (v < 0) break; out.push(v); }
  return Uint8Array.from(out);
}

let raf = 0;
function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

function render() {
  if (!el.rows || !S.loaded) return;
  const bpr = S.bpr, digits = offDigits();
  const hexHead = () => { let h = ''; for (let i = 0; i < bpr; i++) h += `<span class="b${i && i % 8 === 0 ? ' g' : ''}">${hex2(i % 256)}</span>`; return h; };
  el.head.innerHTML = `<span class="off">${'Offset'.padEnd(digits, ' ')}</span><span class="hx">${hexHead()}</span><span class="tx">${esc(cut(S.a.name, bpr))}</span><span class="mid"></span><span class="hx">${hexHead()}</span><span class="tx">${esc(cut(S.b.name, bpr))}</span>`;
  let html = '', missing = false;
  for (let r = 0; r < S.rowsVisible; r++) {
    const start = (S.top + r) * bpr;
    if (start >= S.size) break;
    const sides = {};
    for (const side of ['a', 'b']) {
      const f = S[side];
      const count = Math.max(0, Math.min(bpr, f.size - start));
      const got = rowBytes(side, start, Math.min(count + 3, Math.max(0, f.size - start)));
      if (got.length < count) missing = true;
      sides[side] = { count, got, cells: got.length >= count && count ? textCells(got, count, 'ascii', start, false) : null };
    }
    const cellsFor = side => {
      const o = sides[side], other = sides[side === 'a' ? 'b' : 'a'];
      let hx = '', tx = '';
      for (let i = 0; i < bpr; i++) {
        const off = start + i, g = i && i % 8 === 0 ? ' g' : '';
        if (i >= o.count) { hx += `<span class="b e x${g}${off === S.cursor ? ' cur2' : ''}"></span>`; tx += '<span class="c e"></span>'; continue; }
        const v = i < o.got.length ? o.got[i] : -1;
        const w = i < other.got.length ? other.got[i] : (i >= other.count ? -2 : -1);
        let cls = '';
        if (v >= 0 && w !== -1 && v !== w) cls += ' d';
        if (v === 0) cls += ' z';
        if (off === S.cursor) cls += ' cur2';
        hx += `<span class="b${g}${cls}" data-o="${i}">${v < 0 ? '  ' : (S.upper ? hex2(v) : hex2(v).toLowerCase())}</span>`;
        const c = o.cells ? o.cells[i] : { ch: ' ', kind: 'c' };
        tx += `<span class="c${cls}${c.kind !== 'p' ? ' np' : ''}" data-o="${i}">${c.ch === ' ' ? ' ' : esc(c.ch)}</span>`;
      }
      return [hx, tx];
    };
    const [ha, ta] = cellsFor('a'), [hb, tb] = cellsFor('b');
    const offText = S.upper ? hexOffset(start, digits) : hexOffset(start, digits).toLowerCase();
    html += `<div class="row" data-r="${start}"><span class="off">${offText}</span><span class="hx">${ha}</span><span class="tx">${ta}</span><span class="mid"></span><span class="hx">${hb}</span><span class="tx">${tb}</span></div>`;
  }
  el.rows.innerHTML = html;
  updateThumb();
  updateStatus();
  requestVisible();
  if (!missing) S.rendered = true;
}

function cut(s, n) { return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; }

function updateThumb() {
  const H = el.track.clientHeight, total = totalRows();
  el.track.classList.toggle('off', total <= S.rowsVisible);
  const th = Math.max(24, Math.round((H * S.rowsVisible) / total)), mt = maxTop();
  el.thumb.style.height = th + 'px';
  el.thumb.style.transform = `translateY(${mt ? Math.round(((H - th) * S.top) / mt) : 0}px)`;
}

function valText(v) { return v === -2 ? 'past the end' : v === -1 ? '...' : `0x${hex2(v)} (${v})`; }

function updateStatus() {
  el.stPos.textContent = `Offset 0x${hexOffset(S.cursor, 1)} (${fmtInt(S.cursor)})`;
  const va = byteAt('a', S.cursor), vb = byteAt('b', S.cursor);
  el.stVal.textContent = `A: ${valText(va)} · B: ${valText(vb)}${va >= 0 && vb >= 0 ? (va === vb ? ' · same' : ' · different') : ''}`;
}

function scrollToCursor(center) {
  const row = Math.floor(S.cursor / S.bpr);
  if (center) S.top = Math.max(0, Math.min(maxTop(), row - Math.floor(S.rowsVisible / 3)));
  else if (row < S.top) S.top = row;
  else if (row >= S.top + S.rowsVisible - 1) S.top = Math.min(maxTop(), row - S.rowsVisible + 2);
  render();
}

function moveTo(off, center) {
  if (!S.size) return;
  S.cursor = Math.max(0, Math.min(S.size - 1, off));
  scrollToCursor(center);
  clearTimeout(S.liveTimer);
  S.liveTimer = setTimeout(() => { el.live.textContent = `${el.stPos.textContent}. ${el.stVal.textContent}`; }, 250);
}

function onKey(e) {
  const page = Math.max(1, S.rowsVisible - 1) * S.bpr;
  let to = null;
  switch (e.key) {
    case 'ArrowLeft': to = S.cursor - 1; break;
    case 'ArrowRight': to = S.cursor + 1; break;
    case 'ArrowUp': to = S.cursor - S.bpr; break;
    case 'ArrowDown': to = S.cursor + S.bpr; break;
    case 'PageUp': to = S.cursor - page; S.top = Math.max(0, S.top - S.rowsVisible + 1); break;
    case 'PageDown': to = S.cursor + page; S.top = Math.min(maxTop(), S.top + S.rowsVisible - 1); break;
    case 'Home': to = (e.ctrlKey || e.metaKey) ? 0 : S.cursor - (S.cursor % S.bpr); break;
    case 'End': to = (e.ctrlKey || e.metaKey) ? S.size - 1 : S.cursor - (S.cursor % S.bpr) + S.bpr - 1; break;
    case 'Escape': if (S.seeking) { post({ type: 'cancel' }); S.seeking = false; el.info.textContent = 'Stopped.'; } return;
  }
  if (to !== null) { e.preventDefault(); moveTo(to, false); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); el.goto.focus(); el.goto.select(); }
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
  const H = el.track.clientHeight, th = el.thumb.offsetHeight, rect = el.track.getBoundingClientRect();
  const grab = e.target === el.thumb ? e.clientY - el.thumb.getBoundingClientRect().top : th / 2;
  const to = y => { const f = Math.max(0, Math.min(1, (y - rect.top - grab) / Math.max(1, H - th))); S.top = Math.round(f * maxTop()); scheduleRender(); };
  to(e.clientY);
  const mv = ev => to(ev.clientY);
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}

function onMouseDown(e) {
  const cell = e.target.closest && e.target.closest('.b,.c');
  if (!cell || cell.dataset.o === undefined) return;
  e.preventDefault();
  el.grid.focus();
  moveTo(Number(cell.closest('.row').dataset.r) + Number(cell.dataset.o), false);
}

function seek(backward) {
  if (!S.size) return;
  const from = backward ? S.cursor - 1 : S.cursor + (S.lastDiff === S.cursor || isDiffAt(S.cursor) ? 1 : 0);
  if (from < 0) { el.info.textContent = 'No difference before this point.'; return; }
  // skip to the end of the current differing area first, so Next goes to the next area, not the next byte
  S.diffId++; S.seeking = true;
  el.info.classList.remove('bad');
  el.info.textContent = 'Looking...';
  post({ type: 'diff', from: backward ? from : skipRun(from), backward, id: S.diffId });
}

function isDiffAt(off) { const a = byteAt('a', off), b = byteAt('b', off); return (a === -2) !== (b === -2) || (a >= 0 && b >= 0 && a !== b); }
function skipRun(from) { let o = from; while (o < S.size && o - from < BLOCK && isDiffAt(o) && isDiffAt(o - 1)) o++; return o; }

function onDiff(m) {
  if (m.id !== S.diffId) return;
  S.seeking = false;
  if (m.cancelled) { el.info.textContent = 'Stopped.'; return; }
  if (m.offset < 0) { el.info.textContent = 'No more differences in this direction.'; el.info.classList.add('bad'); return; }
  S.lastDiff = m.offset;
  el.info.textContent = `Difference at 0x${hexOffset(m.offset, 1)}`;
  moveTo(m.offset, true);
}

function onStats(m) {
  S.stats = m;
  if (m.identical) { el.sum.textContent = 'The files are identical.'; el.sum.classList.add('same'); }
  else el.sum.textContent = `${fmtInt(m.bytes)} byte${m.bytes === 1 ? '' : 's'} differ in ${fmtInt(m.runs)} area${m.runs === 1 ? '' : 's'}. First at 0x${hexOffset(m.first, 1)}.`;
  el.sum.title = `Counted in ${(m.ms / 1000).toFixed(1)} s.`;
  el.marks.textContent = '';
  const n = m.map.length;
  // CSSOM, not a style attribute: the webview CSP blocks inline style attributes
  m.map.forEach((v, i) => { if (!v) return; const d = $('div', { class: 'mk' }); d.style.top = `${(100 * i) / n}%`; d.style.height = `${Math.max(0.4, 100 / n)}%`; el.marks.append(d); });
}

// For the release check in a real VS Code (scripts/e2e-vscode.mjs). Read-only.
window.hexCompareProbe = () => ({
  loaded: S.loaded, size: S.size, a: S.a, b: S.b, bpr: S.bpr, top: S.top, cursor: S.cursor, rendered: S.rendered,
  info: el.info ? el.info.textContent : '', summary: el.sum ? el.sum.textContent : '', stats: S.stats, status: el.status ? el.status.textContent : '',
  diffCells: el.rows ? el.rows.querySelectorAll('.hx .b.d').length : 0, lastRow: el.rows && el.rows.lastElementChild ? Number(el.rows.lastElementChild.dataset.r) : null,
});
