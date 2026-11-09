'use strict';
// EXEC13 (0.3.4): the free Structure view shows the root and its direct fields with no try used. A field with nested
// fields shows, once the user opens it, one row "N nested fields: Zovo Pro". A click on that row asks the host for a
// Pro use (proTry 'templates'). Nothing about it shows or runs before the user opens the Structure tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const T = require('../src/core/template.js');
const { HexDocument } = require('../src/core/doc.js');
const { BUILTIN } = require('../src/templates.js');

// ---------- the wire format ----------

test('toWireTop: root plus direct fields; nested fields replaced by their count', async () => {
  const tpl = { name: 'T', structs: { File: [{ name: 'magic', type: 'u16' }, { name: 'hdr', type: 'H' }, { name: 'list', type: 'u8', count: 3 }, { name: 'empty', type: 'u8', count: 0 }], H: [{ name: 'a', type: 'u8' }, { name: 'inner', type: 'I' }], I: [{ name: 'b', type: 'u8' }, { name: 'c', type: 'u8' }] } };
  const doc = HexDocument.fromBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), null);
  const r = await T.parse(tpl, doc);
  assert.equal(r.error, null);
  const w = T.toWireTop(r.root);
  assert.deepEqual(w.c.map(c => c.n), ['magic', 'hdr', 'list', 'empty']);
  assert.equal(w.c[0].v, '513 (0x201)');
  assert.equal(w.c[1].c, undefined); assert.equal(w.c[1].p, 4, 'a, inner, b, c');
  assert.equal(w.c[2].c, undefined); assert.equal(w.c[2].p, 3);
  assert.deepEqual(w.c[3].c, [], 'an empty list stays an empty list, no Pro row');
  assert.equal(w.c[3].p, undefined);
  assert.equal(JSON.stringify(w).includes('"b"'), false, 'no nested name is sent');
  assert.equal(T.countNested(r.root), 11);
  // the full tree is unchanged
  assert.equal(T.toWire(r.root).c[1].c[1].c[1].n, 'c');
});

test('toWireTop on every built-in template: level 1 only, labels kept', async () => {
  const doc = HexDocument.fromBytes(Uint8Array.from(Array.from({ length: 4096 }, (_, i) => (i * 7) & 255)), null);
  for (const t of BUILTIN) {
    const r = await T.parse(t, doc, { limits: { maxMs: 2000 } });
    const w = T.toWireTop(r.root);
    for (const c of w.c) { assert.ok(!c.c || c.c.length === 0, `${t.id}.${c.n} has no nested rows`); }
  }
});

// ---------- the webview (a tiny DOM stand-in) ----------

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.title = ''; this._text = ''; this.listeners = {}; this.classList = { toggle() {}, contains: c => c === this._cls, add() {}, remove() {} }; }
  append(...c) { for (const x of c) if (x != null) this.children.push(typeof x === 'string' ? new Text(x) : x); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { this.listeners[k] = f; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = v; this.children = []; }
  querySelector(sel) { return this.find(e => (sel.startsWith('[data-panel') ? e.dataset.panel === sel.match(/"(.+)"/)[1] : sel.startsWith('.') ? (e.attrs.class || '').split(' ').includes(sel.slice(1)) : false)); }
  find(f) { for (const c of this.children) { if (!(c instanceof El)) continue; if (f(c)) return c; const r = c.find(f); if (r) return r; } return null; }
  all(f, acc = []) { for (const c of this.children) { if (!(c instanceof El)) continue; if (f(c)) acc.push(c); c.all(f, acc); } return acc; }
}
class Text { constructor(t) { this.textContent = t; } }

async function panelUI(savedPanel) {
  const posted = [];
  const doc = new El('body');
  global.document = { createTextNode: t => new Text(t), body: doc, querySelector: s => doc.querySelector(s), querySelectorAll: s => doc.all(e => (e.attrs.class || '').split(' ').includes(s.replace(/^\./, '').split(' ')[0])) };
  const $ = (tag, attrs, ...kids) => {
    const e = new El(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') e._text = String(v); else if (k === 'onclick') e.onclick = v; else if (k === 'class') e.attrs.class = v;
      else if (k.startsWith('data-')) e.dataset[k.slice(5)] = v; else if (k === 'hidden') e.hidden = v; else if (k === 'title') e.title = v; else e.attrs[k] = v;
    }
    e.append(...kids);
    return e;
  };
  const { createProUI } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'webview', 'pro.js')).href);
  const el = { insPane: new El('div'), side: new El('div'), insBtn: new El('button') };
  const ui = createProUI({ $, post: m => posted.push(m), S: {}, el, render() {}, selectRange() {}, hint() {}, esc: s => s, hexOffset: n => n.toString(16), fmtInt: n => n.toLocaleString('en-US'), saved: { panel: savedPanel || 'inspector' }, persist() {}, layout() {} });
  doc.append(ui.tabs, ...ui.panes);
  return { ui, posted, doc, struct: ui.panes[0] };
}
const rows = box => box.all(e => /\btn\b/.test(e.attrs.class || ''));
const FREE_TREE = { n: 'ELF', t: 'File', o: 0, s: 64, k: 's', c: [
  { n: 'e_ident', t: 'Ident', o: 0, s: 16, k: 's', p: 7 },
  { n: 'header', t: 'Header', o: 16, s: 48, k: 's', p: 14 },
  { n: 'note', t: 'value', o: 64, s: 0, k: 'v', v: '"x"', x: 1 },
] };

test('webview: nothing is asked before the Structure tab is opened; opening it reads the top level', async () => {
  const { ui, posted } = await panelUI();
  ui.start();
  assert.ok(!posted.some(m => m.type === 'structParse' || m.type === 'structDetect' || m.type === 'proTry'), 'nothing on open');
  ui.show('struct', true);
  assert.ok(posted.some(m => m.type === 'structDetect'));
  assert.ok(posted.some(m => m.type === 'structParse'), 'the free tree is read when the tab opens');
  assert.ok(!posted.some(m => m.type === 'proTry'), 'no Pro use for the top level');
});

test('webview: the Structure tab has no PRO badge; Bookmarks keeps it', async () => {
  const { ui } = await panelUI();
  const tabs = ui.tabs.children;
  const st = tabs.find(t => t.dataset.panel === 'struct'), bm = tabs.find(t => t.dataset.panel === 'bm');
  assert.equal(st.textContent, 'Structure');
  assert.equal(bm.textContent, 'BookmarksPRO');
});

test('webview: free tree shows level 1; opening a field shows one "N nested fields: Zovo Pro" row; a click is a Pro use', async () => {
  const { ui, posted, struct } = await panelUI();
  ui.start();
  ui.onMessage({ type: 'pro', licensed: false, onSale: true, trials: { templates: 3, bookmarks: 3 } });
  ui.show('struct', true);
  ui.onMessage({ type: 'struct', id: 'elf', name: 'ELF', tree: FREE_TREE, free: true, trial: 3, error: null, nodes: 25, ms: 1 });
  let r = rows(struct);
  assert.deepEqual(r.map(x => x.find(e => e.attrs.class === 'nm').textContent), ['ELF', 'e_ident', 'header', 'note']);
  assert.equal(struct.querySelector('.nestpro'), null, 'no Pro row until the user opens a field');
  assert.ok(!rows(struct).some(x => /JSON|C struct/.test(x.textContent)));
  assert.equal(struct.all(e => e.tag === 'button' && /^(JSON|C struct)$/.test(e.textContent)).length, 0, 'export is Pro: hidden in the free view');
  // open "header" with its twisty
  const header = rows(struct)[2];
  assert.equal(header.attrs['aria-expanded'], 'false');
  header.listeners.click({ target: header.children[0] && { classList: { contains: c => c === 'tw' } } });
  const pro = struct.querySelector('.nestpro');
  assert.ok(pro, 'the Pro row shows under the opened field');
  assert.equal(pro.find(e => e.attrs.class === 'nm').textContent, '14 nested fields: Zovo Pro');
  assert.match(pro.textContent, /3 free tries left/);
  assert.equal(struct.all(e => /\bnestpro\b/.test(e.attrs.class || '')).length, 1, 'one row, not one per field');
  assert.ok(!posted.some(m => m.type === 'proTry'), 'opening a field is not a Pro use');
  pro.listeners.click();
  assert.deepEqual(posted.filter(m => m.type === 'proTry'), [{ type: 'proTry', feature: 'templates' }]);
  // the host answers with the full tree: the opened field keeps its place and shows its fields
  const full = JSON.parse(JSON.stringify(FREE_TREE));
  full.c[1].c = Array.from({ length: 14 }, (_, i) => ({ n: 'f' + i, t: 'u16', o: 16 + i * 2, s: 2, k: 'v', v: String(i) }));
  delete full.c[1].p; full.c[0].c = [{ n: 'magic', t: 'bytes[4]', o: 0, s: 4, k: 'v', v: '7F 45 4C 46' }]; delete full.c[0].p;
  ui.onMessage({ type: 'struct', id: 'elf', name: 'ELF', tree: full, free: false, trial: 2, error: null, nodes: 25, ms: 1 });
  r = rows(struct);
  assert.equal(struct.querySelector('.nestpro'), null);
  assert.ok(r.some(x => /f13/.test(x.textContent)), 'the nested fields of the opened field show');
  assert.equal(struct.all(e => e.tag === 'button' && /^(JSON|C struct)$/.test(e.textContent)).length, 2, 'export buttons with the full tree');
});

test('webview: with no free tries left the row says how to get Pro; the click still only asks the host', async () => {
  const { ui, posted, struct } = await panelUI();
  ui.start();
  ui.onMessage({ type: 'pro', licensed: false, onSale: true, trials: { templates: 0, bookmarks: 3 } });
  ui.show('struct', true);
  ui.onMessage({ type: 'struct', id: 'elf', name: 'ELF', tree: FREE_TREE, free: true, trial: 0, error: null, nodes: 25, ms: 1 });
  const e = rows(struct)[1];
  e.listeners.dblclick();
  const pro = struct.querySelector('.nestpro');
  assert.equal(pro.find(x => x.attrs.class === 'nm').textContent, '7 nested fields: Zovo Pro');
  assert.doesNotMatch(pro.textContent, /free tr/);
  assert.match(pro.title, /Zovo Pro shows every nested field/);
  pro.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(posted.filter(m => m.type === 'proTry').length, 1);
});

test('webview: a license that arrives while the free tree shows reads the full tree again', async () => {
  const { ui, posted } = await panelUI();
  ui.start();
  ui.show('struct', true);
  ui.onMessage({ type: 'struct', id: 'elf', name: 'ELF', tree: FREE_TREE, free: true, trial: 3, error: null, nodes: 25, ms: 1 });
  const before = posted.filter(m => m.type === 'structParse').length;
  ui.onMessage({ type: 'pro', licensed: true, onSale: true, trials: {} });
  assert.equal(posted.filter(m => m.type === 'structParse').length, before + 1);
});
