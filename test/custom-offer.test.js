'use strict';
// EXEC9: the USD 299 custom format line. It shows only where no template applies (Structure panel after a user
// action, or the template picker), at most once per session, never on open, and never while a funding value is empty.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const CO = require('../src/custom-offer.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexv-custom-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const host = (scenario, emptyKey) => {
  const d = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'custom-host.js'), scenario, tmp, ...(emptyKey ? [emptyKey] : [])], { encoding: 'utf8' }));
  if (d.crash) throw new Error(d.crash);
  return d;
};
const TIER = 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679995';

test('custom offer: the values are the ones in funding.json, and the line is hidden when one is empty', () => {
  const shared = path.join(os.homedir(), 'plugin-market-intel-work', 'factory', 'sprint', 'funding.json');
  if (fs.existsSync(shared)) {
    const f = JSON.parse(fs.readFileSync(shared, 'utf8'));
    for (const k of ['custom_format_tier', 'custom_format_usd', 'custom_format_issues']) assert.equal(CO.FUNDING_CUSTOM[k], f[k], k);
  }
  assert.deepEqual(CO.customOffer(), { tier: TIER, usd: 299, issues: 'https://github.com/theluckystrike/zovo-plugin-factory/issues/new?template=format-request.yml' });
  for (const k of ['custom_format_tier', 'custom_format_usd', 'custom_format_issues']) {
    assert.equal(CO.customOffer({ ...CO.FUNDING_CUSTOM, [k]: k === 'custom_format_usd' ? 0 : '' }), null, k);
    assert.equal(CO.customOffer({ ...CO.FUNDING_CUSTOM, [k]: undefined }), null, k);
  }
  assert.equal(CO.customOffer({ ...CO.FUNDING_CUSTOM, custom_format_tier: 'https://evil.example/x' }), null);
  const s = CO.createCustomOffer({ vscode: null, product: 'Hex Viewer', funding: { ...CO.FUNDING_CUSTOM, custom_format_issues: '' } });
  assert.equal(s.available(), false);
  assert.equal(s.claim(), null);
  assert.equal(s.url('tier'), '');
});

test('custom offer: the text, the prefilled form (no file name) and once per session', () => {
  assert.equal(CO.lineText('template', 299), 'No template for this format. Request one (free), or we build it for USD 299 once.');
  assert.equal(CO.extensionOf('/Users/a/secret-plan.XYZ'), '.xyz');
  assert.equal(CO.extensionOf('/Users/a/Makefile'), '');
  assert.equal(CO.extensionOf('/Users/a/.bashrc'), '');
  const opened = [];
  const vscode = { version: '1.142.0', env: { appName: 'Cursor', openExternal: async u => { opened.push(String(u)); return true; } }, Uri: { parse: s => s } };
  const s = CO.createCustomOffer({ vscode, product: 'Hex Viewer', version: '0.3.3' });
  assert.equal(s.url('tier'), '', 'no link before the line was shown');
  assert.deepEqual(s.claim(), { usd: 299 });
  assert.equal(s.claim(), null, 'second claim in the same session');
  assert.equal(s.available(), false);
  const u = s.url('request', '.xyz');
  assert.match(u, /^https:\/\/github\.com\/theluckystrike\/zovo-plugin-factory\/issues\/new\?template=format-request\.yml&title=Format%20request%3A%20\.xyz%20in%20Hex%20Viewer&viewer=Hex%20Viewer&format=\.xyz&editor=Cursor%201\.142\.0%2C%20Hex%20Viewer%200\.3\.3$/);
  assert.doesNotMatch(s.url('request', '<script>"x"'), /[<>"]|%3C|%22/);
  assert.equal(s.url('tier'), TIER);
  assert.equal(s.url('https://evil.example'), '');
});

test('host: the line shows only on no match, once per session, never on open; links open only on click', () => {
  const d = host('panel');
  assert.equal(d.result.onOpen, 0, 'nothing on open');
  assert.equal(d.result.best, null);
  assert.equal(d.result.grantsFirst, 1);
  assert.equal(d.result.grantsSecond, 0, 'a second tab in the same session gets nothing');
  assert.equal(d.result.usd, 299);
  assert.equal(d.external.length, 2, 'two clicks, two pages; the unknown link is refused');
  assert.match(d.external[0], /format-request\.yml&title=Format%20request%3A%20\.xyz%20in%20Hex%20Viewer/);
  assert.doesNotMatch(d.external[0], /capture/, 'no file name in the public form');
  assert.equal(d.external[1], TIER);
  assert.deepEqual([d.modal, d.errors], [[], []], 'no popup, no error');
});

test('host: a file with a template gets no line (and no link opens); a later no-match file still can', () => {
  const d = host('match');
  assert.equal(d.result.best.id, 'png');
  assert.equal(d.result.grants, 0);
  assert.deepEqual(d.external, []);
  assert.equal(d.result.grantsAfter, 1);
});

test('host: the picker shows the line when no template matches, once; "None of these matches" when some match', () => {
  let d = host('picker-nomatch');
  const first = d.picks[0];
  // EXEC13: the USD 49 template order sits between the free request and USD 299, Sponsors first, PayPal second
  assert.deepEqual(first.slice(-5).map(i => i.label), ['No template for this format', '$(comment-discussion) Request one (free)', '$(package) Template for your format in 2 working days: USD 49, Zovo Pro included', '$(credit-card) The same template order by PayPal, USD 49', '$(heart) Or we build it for USD 299 once']);
  assert.equal(first.at(-5).kind, -1, 'a separator, not a choice');
  assert.equal(d.external.length, 1);
  assert.match(d.external[0], /format=\.xyz/);
  assert.ok(!d.picks[1].some(i => /USD 299|None of these/.test(i.label)), 'the second picker in the session is the old one');
  assert.equal(d.result.grants, 0, 'and the panel does not show it again');
  d = host('picker-none');
  assert.equal(d.picks[0].at(-1).label, '$(question) None of these matches this file');
  assert.equal(d.result.grants, 1);
  assert.ok(!d.picks[1].some(i => /USD 299|None of these/.test(i.label)));
});

test('host: hidden when a funding value is empty (panel and picker)', () => {
  for (const k of ['custom_format_tier', 'custom_format_usd', 'custom_format_issues']) {
    const d = host('panel', k);
    assert.equal(d.result.grantsFirst + d.result.grantsSecond, 0, k);
    assert.deepEqual(d.external, [], k);
    const p = host('picker-nomatch', k);
    assert.ok(!p.picks[0].some(i => /USD|None of these|Request one/.test(i.label)), k);
  }
});

// ---------- the Structure panel in the webview (a tiny DOM stand-in) ----------

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.title = ''; this._text = ''; this.classList = { toggle() {}, contains: () => false, add() {}, remove() {} }; }
  append(...c) { for (const x of c) if (x != null) this.children.push(typeof x === 'string' ? new Text(x) : x); }
  setAttribute(k, v) { this.attrs[k] = v; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = v; this.children = []; }
  querySelector(sel) { return this.find(e => sel === '.customfmt' ? /\bcustomfmt\b/.test(e.attrs.class || '') : sel.startsWith('[data-panel') ? e.dataset.panel === sel.match(/"(.+)"/)[1] : false); }
  find(f) { for (const c of this.children) { if (!(c instanceof El)) continue; if (f(c)) return c; const r = c.find(f); if (r) return r; } return null; }
  all(f, acc = []) { for (const c of this.children) { if (!(c instanceof El)) continue; if (f(c)) acc.push(c); c.all(f, acc); } return acc; }
}
class Text { constructor(t) { this.textContent = t; } }

async function panelUI() {
  const posted = [];
  const doc = new El('body');
  global.document = { createTextNode: t => new Text(t), body: doc, querySelector: s => doc.querySelector(s) };
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
  const ui = createProUI({ $, post: m => posted.push(m), S: {}, el, render() {}, selectRange() {}, hint() {}, esc: s => s, hexOffset: n => n.toString(16), fmtInt: String, saved: { panel: 'struct' }, persist() {}, layout() {} });
  doc.append(ui.tabs, ...ui.panes);
  return { ui, posted, doc, struct: ui.panes[0] };
}
const claims = posted => posted.filter(m => m.type === 'customClaim').length;

test('webview: restored on open with no template: no claim, no line; a click on the Structure tab claims once', async () => {
  const { ui, posted, struct } = await panelUI();
  ui.start(); // the Structure tab was open last time: this is "on open"
  ui.onMessage({ type: 'structInfo', licensed: false, best: null, matches: [], count: 20, trials: { templates: 3 } });
  assert.equal(claims(posted), 0, 'nothing on open');
  assert.equal(struct.querySelector('.customfmt'), null);
  ui.show('struct', true); // the user clicks the tab
  assert.equal(claims(posted), 1);
  ui.show('struct', true);
  assert.equal(claims(posted), 1, 'asked once per tab');
  assert.equal(struct.querySelector('.customfmt'), null, 'nothing before the host says yes');
  ui.onMessage({ type: 'customGrant', usd: 299 }); // a host without the template order (a funding value empty)
  const line = struct.querySelector('.customfmt');
  assert.equal(line.textContent, 'No template for this format. Request one (free), or we build it for USD 299 once.');
  const links = line.all(e => e.tag === 'button');
  assert.deepEqual(links.map(b => b.textContent), ['Request one (free)', 'we build it for USD 299 once']);
  assert.ok(!posted.some(m => m.type === 'customOpen'), 'no link opens by itself');
  links[0].onclick(); links[1].onclick();
  assert.deepEqual(posted.filter(m => m.type === 'customOpen').map(m => m.which), ['request', 'tier']);
});

test('webview: a file with a template never claims; Pro "no template matches" claims after a user action', async () => {
  let t = await panelUI();
  t.ui.start();
  t.ui.show('struct', true);
  t.ui.onMessage({ type: 'structInfo', licensed: false, best: { id: 'png', name: 'PNG image' }, matches: ['png'], count: 20, trials: { templates: 3 } });
  assert.equal(claims(t.posted), 0);
  t = await panelUI();
  t.ui.start();
  t.ui.onMessage({ type: 'pro', licensed: true, onSale: false, trials: {} });
  t.ui.onMessage({ type: 'struct', none: true, count: 20 });
  assert.equal(claims(t.posted), 0, 'restored on open: no claim');
  t.ui.show('struct', true);
  assert.equal(claims(t.posted), 1);
  t.ui.onMessage({ type: 'customGrant', usd: 299 });
  assert.match(t.struct.textContent, /No template matches this file\. Pick one with Template\.\.\..*No template for this format\. Request one \(free\), or we build it for USD 299 once\./);
});

// ---------- EXEC13: the USD 49 template order ----------

const ORDER_TIER = 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=680220';

test('template order: values from funding.json, hidden while one is empty, links only after the line was shown', () => {
  const shared = path.join(os.homedir(), 'plugin-market-intel-work', 'factory', 'sprint', 'funding.json');
  if (fs.existsSync(shared)) {
    const f = JSON.parse(fs.readFileSync(shared, 'utf8'));
    for (const k of ['template_order_tier', 'template_order_usd', 'paypal_me']) assert.equal(CO.FUNDING_CUSTOM[k], f[k], k);
  }
  assert.deepEqual(CO.templateOrder(), { tier: ORDER_TIER, usd: 49, paypal: 'https://www.paypal.com/paypalme/najzzz/49USD' });
  for (const k of ['template_order_tier', 'template_order_usd']) {
    assert.equal(CO.templateOrder({ ...CO.FUNDING_CUSTOM, [k]: k === 'template_order_usd' ? 0 : '' }), null, k);
    assert.equal(CO.templateOrder({ ...CO.FUNDING_CUSTOM, [k]: undefined }), null, k);
  }
  assert.equal(CO.templateOrder({ ...CO.FUNDING_CUSTOM, template_order_tier: 'https://evil.example/x' }), null);
  assert.equal(CO.templateOrder({ ...CO.FUNDING_CUSTOM, custom_format_tier: '' }), null, 'no USD 299 line, no middle line');
  assert.deepEqual(CO.templateOrder({ ...CO.FUNDING_CUSTOM, paypal_me: '' }), { tier: ORDER_TIER, usd: 49, paypal: '' }, 'no PayPal link: Sponsors only');
  assert.equal(CO.lineText('template', 299, CO.templateOrder()), 'No template for this format. Request one (free). Template for your format in 2 working days: USD 49, Zovo Pro included (GitHub Sponsors, or PayPal). Or we build it for USD 299 once.');
  assert.equal(CO.lineText('element', 299, CO.templateOrder()), 'Request support for this (free), or we build it for USD 299 once.', 'the DOCX kind never gets the template order');
  const opened = [];
  const vscode = { version: '1.142.0', env: { appName: 'Visual Studio Code', openExternal: async u => { opened.push(String(u)); return true; } }, Uri: { parse: s => s } };
  const s = CO.createCustomOffer({ vscode, product: 'Hex Viewer', version: '0.3.4', withOrder: true });
  assert.equal(s.url('order'), ''); assert.equal(s.url('orderPaypal'), '');
  assert.deepEqual(s.claim(), { usd: 299, order: { usd: 49, paypal: true } });
  assert.equal(s.url('order'), ORDER_TIER);
  assert.equal(s.url('orderPaypal'), 'https://www.paypal.com/paypalme/najzzz/49USD');
  const off = CO.createCustomOffer({ vscode, product: 'Hex Viewer', funding: { ...CO.FUNDING_CUSTOM, template_order_usd: '' }, withOrder: true });
  assert.deepEqual(off.claim(), { usd: 299 }, 'empty value: the line has no middle option');
  assert.equal(off.url('order'), '');
});

test('host: the panel grant carries the USD 49 order; its links open the tier and PayPal on click only', () => {
  const d = host('panel');
  const g = d.sent.find(m => m.type === 'customGrant');
  assert.deepEqual(g.order, { usd: 49, paypal: true });
  for (const k of ['template_order_tier', 'template_order_usd']) {
    const e = host('panel', k);
    const ge = e.sent.find(m => m.type === 'customGrant');
    assert.equal(ge.usd, 299, k);
    assert.equal(ge.order, null, k);
    const p = host('picker-nomatch', k);
    assert.ok(!p.picks[0].some(i => /USD 49|template order/.test(i.label)), k);
    assert.ok(p.picks[0].some(i => /USD 299/.test(i.label)), k);
  }
  const o = host('picker-order');
  assert.deepEqual(o.external, [ORDER_TIER, 'https://www.paypal.com/paypalme/najzzz/49USD']);
  assert.deepEqual([o.modal, o.errors], [[], []]);
});

test('webview: the USD 49 line sits between the free request and USD 299, three links plus PayPal', async () => {
  const { ui, posted, struct } = await panelUI();
  ui.start();
  ui.onMessage({ type: 'structInfo', licensed: false, best: null, matches: [], count: 26, trials: { templates: 3 } });
  ui.show('struct', true);
  ui.onMessage({ type: 'customGrant', usd: 299, order: { usd: 49, paypal: true } });
  const line = struct.querySelector('.customfmt');
  assert.equal(line.textContent, 'No template for this format.Request one (free)Template for your format in 2 working days: USD 49, Zovo Pro included (GitHub Sponsors, or PayPal)Or we build it for USD 299 once');
  const links = line.all(e => e.tag === 'button');
  assert.deepEqual(links.map(b => b.textContent), ['Request one (free)', 'Template for your format in 2 working days: USD 49, Zovo Pro included', 'PayPal', 'we build it for USD 299 once']);
  assert.ok(!posted.some(m => m.type === 'customOpen'), 'no link opens by itself');
  links.forEach(b => b.onclick());
  assert.deepEqual(posted.filter(m => m.type === 'customOpen').map(m => m.which), ['request', 'order', 'orderPaypal', 'tier']);
});
