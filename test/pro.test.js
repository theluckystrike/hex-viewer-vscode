'use strict';
// Hex Viewer Pro: license check, the gate in the extension host (mocked VS Code), Structure view messages,
// bookmarks, the compare report and find in files. Free features must not change without a license.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const LIC = require('../src/license/license.js');
const { BookmarkStore, normalize, MAX_PER_FILE } = require('../src/core/bookmarks.js');
const { writeReport } = require('../src/core/report.js');
const { diffRanges } = require('../src/core/compare.js');
const { searchFiles } = require('../src/core/multisearch.js');
const { HexDocument } = require('../src/core/doc.js');
const { parsePattern } = require('../src/core/bytes.js');
const { validateWebviewMessage } = require('../src/core/protocol.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexv-pro-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// a ZOVO1 key as the license Worker makes it (test mode: lm false)
const zkey = payload => { const p = b64u(JSON.stringify({ v: 1, iat: '2026-11-09', lm: false, ...payload })); return `${LIC.KEY_PREFIX}${p}.${b64u(crypto.sign(null, Buffer.from(LIC.SIG_CONTEXT + p), privateKey))}`; };
const mem = b => HexDocument.fromBytes(Uint8Array.from(b), null);

// ---------- license ----------

test('license: the release build has no test key and only the shared module holds the live public key', () => {
  const keys = require('../src/pro/keys.js');
  assert.equal(keys.TEST_PUBKEY, '');
  assert.equal(keys.PAYMENT_URL, undefined);
  for (const f of ['src/pro/keys.js', 'src/pro/index.js', 'src/license/license.js', 'src/license/index.js', 'src/license/sponsors.js']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /PRIVATE KEY-----/);
  // the shared files are copied unchanged
  for (const f of ['index.js', 'license.js', 'sponsors.js']) {
    const shared = path.join(os.homedir(), 'plugin-market-intel-work', 'factory', 'sprint', 'license', f);
    if (fs.existsSync(shared)) assert.equal(fs.readFileSync(path.join(__dirname, '..', 'src', 'license', f), 'utf8'), fs.readFileSync(shared, 'utf8'), f);
  }
});

// ---------- bookmarks ----------

test('bookmarks: add, sort, edit, remove, next/previous, export, limits, bad input', () => {
  const s = new BookmarkStore();
  const a = s.add('f', { start: 0x40, end: 0x48, label: 'table', note: 'offsets | sizes\nline 2' });
  s.add('f', { start: 0x10, end: 0x11, label: '' });
  assert.deepEqual(s.list('f').map(b => b.start), [0x10, 0x40]);
  assert.equal(s.list('f')[0].label, '0x10');
  assert.equal(s.next('f', 0x10).start, 0x40);
  assert.equal(s.next('f', 0x40).start, 0x10); // wraps
  assert.equal(s.next('f', 0x40, true).start, 0x10);
  assert.equal(s.update('f', a.id, { color: 'red', label: 'T' }).color, 'red');
  assert.equal(s.update('f', a.id, { color: 'chartreuse' }).color, 'yellow');
  const md = s.markdown('f', 'x.bin');
  assert.match(md, /\| 0x40 \(64\) \| 8 \| T \| offsets \\\| sizes<br>line 2 \|/);
  assert.throws(() => s.add('f', { start: 5, end: 5 }), /at least one byte/);
  assert.throws(() => s.add('f', { start: -1, end: 5 }), /at least one byte/);
  assert.equal(normalize({ start: 1, end: 2, label: 'a\u0000b'.repeat(100) }).label.length, 120);
  assert.equal(s.remove('f', a.id), true);
  const round = new BookmarkStore(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(round.list('f').length, 1);
  assert.deepEqual(new BookmarkStore({ files: { x: { list: [{ start: 'a' }, null, 5] } } }).list('x'), []);
  assert.deepEqual(new BookmarkStore('junk').list('f'), []);
  const many = new BookmarkStore();
  for (let i = 0; i < MAX_PER_FILE; i++) many.add('g', { start: i, end: i + 1 });
  assert.throws(() => many.add('g', { start: 0, end: 1 }), /1000 bookmarks/);
});

// ---------- compare report ----------

test('report: txt, csv and json with the tail of the longer file', async () => {
  const A = new Uint8Array(3000); const B = new Uint8Array(3010);
  A[5] = 1; A[6] = 2; B[100] = 9; A[2047] = 1; A[2048] = 1; // a run across no chunk edge, one at 2047-2048
  const info = { nameA: 'a.bin', nameB: 'b.bin', pathA: '/x/a.bin', pathB: '/x/b,"q".bin' };
  const runs = [];
  const r = await diffRanges(mem(A), mem(B), x => runs.push(x));
  assert.deepEqual(runs.map(x => [x.start, x.length]), [[5, 2], [100, 1], [2047, 2], [3000, 10]]);
  assert.equal(runs[3].tail, 'b');
  assert.equal(r.bytes, 15);
  for (const fmt of ['txt', 'csv', 'json']) {
    let out = '';
    const res = await writeReport(mem(A), mem(B), info, fmt, async s => { out += s; }, { now: '2026-11-09T00:00:00Z' });
    assert.equal(res.ranges, 4);
    if (fmt === 'json') { const j = JSON.parse(out); assert.equal(j.ranges.length, 4); assert.equal(j.ranges[0].a, '01 02'); assert.equal(j.ranges[3].only_in, 'b'); assert.equal(j.differing_bytes, 15); assert.equal(j.complete, true); assert.equal(j.b.path, info.pathB); }
    if (fmt === 'csv') { const lines = out.trim().split('\n'); assert.equal(lines.length, 5); assert.equal(lines[1], '0x5,5,2,01 02,00 00,'); assert.match(lines[4], /only in B/); }
    if (fmt === 'txt') { assert.match(out, /0x00000005 +2 +A: 01 02 +B: 00 00/); assert.match(out, /15 differing bytes in 4 ranges/); }
  }
  let same = '';
  await writeReport(mem(A), mem(A), info, 'txt', async s => { same += s; });
  assert.match(same, /The files are identical/);
  let capped = '';
  const c = await writeReport(mem(A), mem(B), info, 'json', async s => { capped += s; }, { maxRanges: 2 });
  assert.equal(c.truncated, true); assert.equal(JSON.parse(capped).complete, false); assert.equal(JSON.parse(capped).ranges.length, 2);
});

test('report: two 4 GB sparse files, streamed, bounded memory', async () => {
  const fa = path.join(tmp, 'a4g.bin'), fb = path.join(tmp, 'b4g.bin');
  for (const f of [fa, fb]) { const fd = fs.openSync(f, 'w'); fs.ftruncateSync(fd, 4 * 1024 ** 3); fs.closeSync(fd); }
  const fd = fs.openSync(fb, 'r+'); fs.writeSync(fd, Buffer.from([7, 7, 7]), 0, 3, 4 * 1024 ** 3 - 10); fs.closeSync(fd);
  const a = await HexDocument.openFile(fa), b = await HexDocument.openFile(fb);
  let out = '', peak = 0;
  const t0 = Date.now();
  const res = await writeReport(a, b, { pathA: fa, pathB: fb }, 'csv', async s => { out += s; }, { progress: () => { peak = Math.max(peak, process.memoryUsage().rss); } });
  assert.equal(res.ranges, 1); assert.equal(res.bytes, 3);
  assert.match(out, /0xFFFFFFF6,4294967286,3,00 00 00,07 07 07/);
  assert.ok(Date.now() - t0 < 60000);
  assert.ok(peak === 0 || peak < 800 * 1024 * 1024, `rss ${peak}`);
  await a.dispose(); await b.dispose();
  fs.rmSync(fa); fs.rmSync(fb);
});

// ---------- find in files ----------

test('find in files: matches with context, wildcards, limits, unreadable files', async () => {
  const dir = path.join(tmp, 'fif'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from('00DEADBEEF00DEADBEEF', 'hex'));
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from('hello DEADBEEF text'));
  fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.alloc(0));
  fs.writeFileSync(path.join(dir, 'locked.bin'), 'x'); fs.chmodSync(path.join(dir, 'locked.bin'), 0);
  const files = ['a.bin', 'b.bin', 'c.bin', 'locked.bin', 'missing.bin'].map(f => ({ path: path.join(dir, f) }));
  const got = [];
  let r = await searchFiles(files, parsePattern('DE ?? BE', 'hex'), { onMatch: m => got.push([path.basename(m.file), m.offset]) });
  assert.deepEqual(got, [['a.bin', 1], ['a.bin', 6]]);
  assert.equal(r.matches, 2);
  assert.ok(r.skipped.some(s => /locked/.test(s.path)) || process.getuid() === 0);
  assert.ok(r.skipped.some(s => /missing/.test(s.path) && /ENOENT/.test(s.error)));
  const t = [];
  r = await searchFiles(files, parsePattern('deadbeef', 'text', true), { onMatch: m => t.push([path.basename(m.file), m.offset, Buffer.from(m.context.bytes).toString()]) });
  assert.deepEqual(t, [['b.bin', 6, 'hello DEADBEEF text']]);
  r = await searchFiles(files, parsePattern('DE', 'hex'), { perFile: 1 });
  assert.equal(r.matches, 1);
  r = await searchFiles(files, parsePattern('DE', 'hex'), { total: 1 });
  assert.equal(r.truncated, true);
  let n = 0;
  r = await searchFiles(files, parsePattern('DE', 'hex'), { shouldStop: () => ++n > 2 });
  assert.equal(r.cancelled, true);
  fs.chmodSync(path.join(dir, 'locked.bin'), 0o644);
});

// ---------- message checks ----------

test('protocol: Pro messages are checked like every other message', () => {
  const ok = m => validateWebviewMessage(m).ok;
  assert.ok(ok({ type: 'structParse' })); assert.ok(ok({ type: 'structParse', id: 'png' }));
  assert.ok(!ok({ type: 'structParse', id: 5 })); assert.ok(!ok({ type: 'structParse', id: 'x'.repeat(201) }));
  assert.ok(ok({ type: 'structExport', format: 'c', path: [0, 3] }));
  assert.ok(!ok({ type: 'structExport', format: 'exe', path: [] })); assert.ok(!ok({ type: 'structExport', format: 'json', path: [-1] })); assert.ok(!ok({ type: 'structExport', format: 'json', path: new Array(65).fill(0) }));
  assert.ok(ok({ type: 'bmAdd', start: 0, end: 1 })); assert.ok(!ok({ type: 'bmAdd', start: 5, end: 5 }));
  assert.ok(ok({ type: 'bmEdit', id: 'abc-1' })); assert.ok(!ok({ type: 'bmEdit', id: '../x' })); assert.ok(!ok({ type: 'bmRemove', id: {} }));
  assert.ok(ok({ type: 'proExplain', feature: 'report' })); assert.ok(!ok({ type: 'proExplain', feature: 'everything' }));
  assert.equal(validateWebviewMessage({ type: 'structExport', format: 'json', path: [1], extra: 'x' }).msg.extra, undefined);
  const { validate: validateCompare } = require('../src/compare.js');
  assert.ok(validateCompare({ type: 'report' })); assert.ok(!validateCompare({ type: 'reportNow' }));
});

// ---------- the extension host with a mocked VS Code ----------

const state = { modal: [], infos: [], inputs: [], picks: [], external: [], docs: [], secrets: new Map(), global: new Map(), saveTo: null, commands: new Map() };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
class Emitter { constructor() { this.h = []; this.event = f => { this.h.push(f); return { dispose() {} }; }; } fire(e) { for (const f of this.h) f(e); } dispose() {} }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s, scheme: 'https' }) },
  EventEmitter: Emitter,
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  StatusBarAlignment: { Right: 2 }, ViewColumn: { Beside: -2, Active: -1 }, ProgressLocation: { Notification: 15, Window: 10 },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    fs: { stat: async u => fs.statSync(u.fsPath), readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d), isWritableFileSystem: () => true },
    openTextDocument: async o => { state.docs.push(o); return o; },
    findFiles: async () => fs.readdirSync(path.join(tmp, 'fif2')).map(f => uriOf(path.join(tmp, 'fif2', f))),
    getWorkspaceFolder: () => undefined,
  },
  window: {
    registered: [],
    registerCustomEditorProvider(id, p) { this.registered.push([id, p]); return { dispose() {} }; },
    createStatusBarItem() { return { text: '', show() {}, hide() {}, dispose() {} }; },
    showInformationMessage: async (msg, opts, ...items) => { if (opts && opts.modal) { state.modal.push({ msg, detail: opts.detail, items }); return state.modalAnswer; } state.infos.push(msg); return undefined; },
    showWarningMessage: async (msg, opts, ...items) => { state.infos.push(String(msg)); return opts && opts.modal ? items[0] : undefined; },
    showErrorMessage: async m => { state.infos.push('ERR ' + m); },
    showInputBox: async o => { const v = state.inputs.shift(); if (o && o.validateInput && v) { const e = o.validateInput(v); if (e) { state.infos.push('INVALID ' + e); return undefined; } } return v; },
    showQuickPick: async (items) => { const want = state.picks.shift(); return typeof want === 'function' ? want(items) : items[want || 0]; },
    showTextDocument: async () => {},
    setStatusBarMessage: m => { state.status = m; return { dispose() {} }; },
    showSaveDialog: async () => state.saveTo,
    showOpenDialog: async () => undefined,
    withProgress: async (o, f) => f({ report() {} }, { isCancellationRequested: false }),
    createQuickPick: () => { const qp = { items: [], selectedItems: [], show() { state.qp = qp; }, onDidAccept(f) { qp.accept = f; }, onDidHide() {}, dispose() {} }; return qp; },
  },
  commands: { registerCommand(id, f) { state.commands.set(id, f); return { dispose() {} }; }, executeCommand: async (...a) => { state.executed = a; } },
  env: { clipboard: { writeText: async () => {} }, openExternal: async u => { state.external.push(String(u)); return true; } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const keys = require('../src/pro/keys.js');
keys.TEST_PUBKEY = PUB; // as a gate build: trust the test key, allow test-mode keys
const ext = require('../src/extension.js');
const ctx = {
  subscriptions: [], extensionUri: uriOf('/ext'),
  globalState: { get: k => state.global.get(k), update: async (k, v) => { state.global.set(k, v); } },
  secrets: { get: async k => state.secrets.get(k), store: async (k, v) => { state.secrets.set(k, v); }, delete: async k => { state.secrets.delete(k); } },
};
ext.activate(ctx);
const provider = vscodeMock.window.registered[0][1];
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));
function fakePanel() {
  const sent = []; let handler = null;
  const panel = { active: true, webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(m); return true; }, onDidReceiveMessage: h => { handler = h; } }, onDidDispose: () => {}, onDidChangeViewState: () => {} };
  return { panel, sent, send: m => handler(m), last: t => [...sent].reverse().find(m => m.type === t) };
}
async function open(file) {
  const doc = await provider.openCustomDocument(uriOf(file), {});
  const p = fakePanel();
  await provider.resolveCustomEditor(doc, p.panel);
  await p.send({ type: 'ready' });
  await settle();
  return { doc, ...p };
}

test('host: without a license the Structure view is locked, nothing pops up on open, free features work', async () => {
  const png = path.join(tmp, 'h.png');
  fs.copyFileSync(path.join(__dirname, '..', 'images', 'hex-viewer-png.png'), png);
  state.modal = [];
  const v = await open(png);
  assert.equal(state.modal.length, 0, 'no popup on open');
  await v.send({ type: 'structDetect' }); await settle();
  assert.equal(v.last('structInfo').best.id, 'png');
  assert.equal(v.last('structInfo').licensed, false);
  await v.send({ type: 'structParse' }); await settle();
  assert.equal(v.last('struct').locked, true);
  assert.equal(v.last('struct').trial, 3);
  // a free try opens the Structure view of this tab, and re-reads after edits do not use more tries
  await v.send({ type: 'proTry', feature: 'templates' }); await settle(80);
  assert.equal(v.last('struct').id, 'png');
  await v.send({ type: 'structParse' }); await settle(80);
  assert.equal(v.last('struct').id, 'png');
  assert.equal(state.global.get('hexViewer.proTrial').templates, 1);
  // bookmarks: 3 free tries, Escape on the name does not use one, the 4th explains Pro with both ways in
  state.modalAnswer = undefined;
  state.inputs = [undefined];
  await v.send({ type: 'bmAdd', start: 0, end: 4 }); await settle();
  assert.equal(state.global.get('hexViewer.proTrial').bookmarks, undefined);
  for (let i = 0; i < 3; i++) { state.inputs = ['try ' + i, '']; await v.send({ type: 'bmAdd', start: i, end: i + 1 }); await settle(); }
  assert.equal(v.last('bookmarks').list.length, 3);
  assert.equal(v.last('bookmarks').trial, 0);
  assert.equal(state.modal.length, 0);
  await v.send({ type: 'bmAdd', start: 9, end: 10 }); await settle();
  assert.equal(state.modal.length, 1);
  assert.match(state.modal[0].msg, /Bookmarks and notes is part of Zovo Pro/);
  assert.deepEqual(state.modal[0].items, ['Unlock with GitHub Sponsors', 'I have a license key', 'Get Zovo Pro']);
  assert.match(state.modal[0].detail, /used the 3 free tries/);
  assert.match(state.modal[0].detail, /USD 15 once/);
  assert.match(state.modal[0].detail, /stays free: viewing, find, go to offset/);
  // bookmarks made in the free tries stay usable: edit and remove need no key
  state.picks = [items => items.find(i => i.k === 'remove')];
  await v.send({ type: 'bmEdit', id: v.last('bookmarks').list[0].id }); await settle();
  assert.equal(v.last('bookmarks').list.length, 2);
  // free features still answer
  await v.send({ type: 'search', query: '49 48 44 52', mode: 'hex', from: 0, id: 1 }); await settle(80);
  assert.equal(v.last('searchResult').offset, 12);
  // Get Zovo Pro opens the GitHub Sponsors one-time page (the shared module's default) and nothing else
  state.modalAnswer = 'Get Zovo Pro';
  await v.send({ type: 'proExplain', feature: 'templates' }); await settle();
  assert.deepEqual(state.external, ['https://github.com/sponsors/theluckystrike?frequency=one-time']);
});

test('host: the Get Pro command opens the same page; no network on open or activation', async () => {
  await state.commands.get('hexViewer.getPro')();
  assert.equal(state.external.at(-1), 'https://github.com/sponsors/theluckystrike?frequency=one-time');
  for (const f of ['src/pro/index.js', 'src/proHost.js', 'src/extension.js', 'src/license/index.js', 'src/license/license.js']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /require\(['"](https?|net|tls)['"]\)|fetch\(/, f);
});

test('host: a bad key is refused, a good key unlocks Pro and is kept in SecretStorage', async () => {
  state.inputs = [zkey({ sku: 'docx-pro' })];
  assert.equal((await state.commands.get('hexViewer.enterLicenseKey')()).pro, false);
  assert.match(state.infos.at(-1), /for docx-pro/);
  assert.equal(state.secrets.get('zovo.license.key'), undefined);
  state.inputs = ['TVPRO1.abc.def'];
  assert.equal((await state.commands.get('hexViewer.enterLicenseKey')()).pro, false);
  const key = zkey({ sku: 'zovo-pro' });
  state.inputs = [key];
  assert.equal((await state.commands.get('hexViewer.enterLicenseKey')()).pro, true);
  assert.equal(state.secrets.get('zovo.license.key'), key);
  assert.match(state.infos.at(-1), /Zovo Pro is on/);
});

test('host (licensed): Structure view, template choice, JSON and C export', async () => {
  const png = path.join(tmp, 'h.png');
  const v = await open(png);
  await v.send({ type: 'structParse' }); await settle(80);
  const s = v.last('struct');
  assert.equal(s.id, 'png'); assert.equal(s.error, null);
  assert.equal(s.tree.c[1].c[0].l, 'IHDR');
  await v.send({ type: 'structExport', format: 'json', path: [1, 0] }); await settle();
  assert.equal(state.docs.at(-1).language, 'json');
  assert.equal(JSON.parse(state.docs.at(-1).content).type, 'IHDR');
  await v.send({ type: 'structExport', format: 'c', path: [] }); await settle();
  assert.match(state.docs.at(-1).content, /#pragma pack\(push, 1\)/);
  state.picks = [items => items.find(i => i.id === 'zip')];
  await v.send({ type: 'structPick' }); await settle(80);
  assert.equal(v.last('struct').id, 'zip');
  assert.match(v.last('struct').error, /was not found/);
  assert.equal(state.global.get('hexViewer.templateFor')['file://' + png], 'zip');
});

test('host (licensed): your own templates from .vscode/hex-templates, bad ones listed', async () => {
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(path.join(ws, '.vscode', 'hex-templates'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.vscode', 'hex-templates', 'mine.jsonc'), '{ // my format\n "id": "mine", "name": "My format", "match": [[{ "offset": 0, "text": "MYF1" }]], "structs": { "File": [ { "name": "magic", "type": "char", "length": 4 }, { "name": "count", "type": "u16" }, ] } }');
  fs.writeFileSync(path.join(ws, '.vscode', 'hex-templates', 'broken.json'), '{ "name": "x", "structs": { "File": [ { "name": "a", "type": "u99" } ] } }');
  fs.writeFileSync(path.join(ws, 'data.myf'), Buffer.from('MYF1\x05\x00rest'));
  vscodeMock.workspace.workspaceFolders = [{ uri: uriOf(ws) }];
  ext.getProHost().loadUserTemplates(true);
  const v = await open(path.join(ws, 'data.myf'));
  await v.send({ type: 'structDetect' }); await settle();
  assert.equal(v.last('structInfo').best.id, 'user:mine');
  assert.ok(v.last('structInfo').problems.some(p => /broken.json: .*unknown type "u99"/.test(p)));
  await v.send({ type: 'structParse' }); await settle(80);
  assert.equal(v.last('struct').user, true);
  assert.equal(v.last('struct').tree.c[1].v, '5 (0x5)');
  vscodeMock.workspace.workspaceFolders = [];
});

test('host (licensed): bookmarks are saved per file and reach every view of the file', async () => {
  const f = path.join(tmp, 'bm.bin'); fs.writeFileSync(f, Buffer.alloc(256, 1));
  const v = await open(f);
  state.inputs = ['Header', 'first 16 bytes'];
  await v.send({ type: 'bmAdd', start: 0, end: 16 }); await settle();
  const list = v.last('bookmarks').list;
  assert.equal(list.length, 1); assert.equal(list[0].label, 'Header'); assert.equal(list[0].note, 'first 16 bytes');
  assert.equal(state.global.get('hexViewer.bookmarks').files['file://' + f].list[0].label, 'Header');
  // Escape on the name adds nothing
  state.inputs = [undefined];
  await v.send({ type: 'bmAdd', start: 20, end: 21 }); await settle();
  assert.equal(v.last('bookmarks').list.length, 1);
  state.picks = [items => items.find(i => i.k === 'remove')];
  await v.send({ type: 'bmEdit', id: list[0].id }); await settle();
  assert.equal(v.last('bookmarks').list.length, 0);
});

test('host (licensed): find in files lists matches and opens the file at the match', async () => {
  const dir = path.join(tmp, 'fif2'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'one.bin'), Buffer.from('7878CAFE7878', 'hex'));
  fs.writeFileSync(path.join(dir, 'two.bin'), Buffer.from('CAFE', 'hex'));
  state.picks = [0]; state.inputs = ['CA FE', '**/*'];
  vscodeMock.window.showOpenDialog = async () => [uriOf(dir)];
  const r = await state.commands.get('hexViewer.findInFiles')();
  assert.equal(r.res.matches, 2);
  assert.match(state.qp.title, /2 matches in 2 of 2 files/);
  const item = state.qp.items.find(i => i.r.file.endsWith('one.bin'));
  assert.match(item.detail, /\[CA FE\]/);
  state.qp.selectedItems = [item]; state.qp.accept(); await settle();
  assert.equal(state.executed[0], 'vscode.openWith');
  const v = await open(path.join(dir, 'one.bin'));
  assert.deepEqual(v.last('goto'), { type: 'goto', offset: 2, length: 2 });
});

test('host (licensed): the compare report is written next to the files, then renamed into place', async () => {
  const fa = path.join(tmp, 'ra.bin'), fb = path.join(tmp, 'rb.bin');
  fs.writeFileSync(fa, Buffer.from([1, 2, 3, 4])); fs.writeFileSync(fb, Buffer.from([1, 9, 3, 4, 5]));
  state.saveTo = uriOf(path.join(tmp, 'report.json'));
  const host = ext.getProHost();
  const a = await HexDocument.openFile(fa), b = await HexDocument.openFile(fb);
  const res = await host.exportReport(a, b, uriOf(fa), uriOf(fb));
  assert.equal(res.ranges, 2);
  const j = JSON.parse(fs.readFileSync(path.join(tmp, 'report.json'), 'utf8'));
  assert.deepEqual(j.ranges.map(x => [x.offset, x.length]), [[1, 1], [4, 1]]);
  assert.deepEqual(fs.readdirSync(tmp).filter(f => /\.tmp$/.test(f)), []);
  await a.dispose(); await b.dispose();
});

test('host (licensed): checksums of the selection and of the whole file', async () => {
  const f = path.join(tmp, 'sum.bin'); fs.writeFileSync(f, Buffer.from('The quick brown fox jumps over the lazy dog'));
  const v = await open(f);
  state.picks = [items => items.find(i => i.label === 'SHA-256')];
  await v.send({ type: 'checksums' }); await settle(50);
  assert.equal(state.status, 'SHA-256 copied');
  const r = await ext.getProHost().runChecksums({ doc: v.doc, cursor: { selStart: 0, selEnd: 0 } });
  assert.deepEqual(r.results[0], ['CRC-32', '414FA339']);
  assert.deepEqual(r.results[1], ['Adler-32', '5BDC0FDA']);
  assert.equal(r.results[4][1], 'D7A8FBB307D7809469CA9ABCB0082E4F8D5651E46D3CDB762D02D0BF37C9E592');
  const part = await ext.getProHost().runChecksums({ doc: v.doc, cursor: { selStart: 4, selEnd: 9 } });
  assert.equal(part.bytes, 5);
  assert.equal(part.results[2][1], crypto.createHash('md5').update('quick').digest('hex').toUpperCase());
});

test('host: removing the key locks Pro again', async () => {
  await state.commands.get('hexViewer.removeLicense')();
  assert.equal(state.secrets.get('zovo.license.key'), undefined);
  state.modal = []; state.modalAnswer = undefined;
  state.global.set('hexViewer.proTrial', { report: 3 });
  const fa = path.join(tmp, 'ra.bin');
  const a = await HexDocument.openFile(fa);
  const res = await ext.getProHost().exportReport(a, a, uriOf(fa), uriOf(fa));
  assert.equal(res, undefined);
  assert.match(state.modal[0].msg, /Compare report export is part of Zovo Pro/);
  await a.dispose();
});
