'use strict';
// The extension host on a mocked VS Code API: open, read, edit + undo/redo events, save, copy, search, errors, CSP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexv-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const state = { config: {}, clipboard: '', infos: [], status: null };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
class Emitter { constructor() { this.h = []; this.event = f => { this.h.push(f); return { dispose() {} }; }; } fire(e) { for (const f of this.h) f(e); } dispose() {} }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s }) },
  EventEmitter: Emitter,
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  StatusBarAlignment: { Right: 2 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    fs: { stat: async u => fs.statSync(u.fsPath), readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d), isWritableFileSystem: () => true },
  },
  window: {
    state: { focused: true },
    registered: [],
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    createStatusBarItem() { state.status = { text: '', show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; return state.status; },
    showInformationMessage: async (...a) => { state.infos.push(a); },
    showInputBox: async () => undefined,
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async () => {} },
  env: { clipboard: { writeText: async t => { state.clipboard = t; } }, openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');
const { buildHtml } = require('../src/html.js');
const { validateWebviewMessage } = require('../src/core/protocol.js');

const ctx = { subscriptions: [], extensionUri: uriOf('/ext'), globalState: { get() {}, update: async () => {} } };
ext.activate(ctx);
const provider = vscodeMock.window.registered[0][1];
const provider2 = vscodeMock.window.registered[1][1];

function fakePanel() {
  const sent = []; let handler = null;
  const panel = {
    active: true,
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(m); return true; }, onDidReceiveMessage: h => { handler = h; } },
    onDidDispose: () => {}, onDidChangeViewState: () => {},
  };
  return { panel, sent, send: m => handler(m), last: t => [...sent].reverse().find(m => m.type === t) };
}
const settle = () => new Promise(r => setTimeout(r, 30));

async function open(file) {
  const doc = await provider.openCustomDocument(uriOf(file), {});
  const p = fakePanel();
  await provider.resolveCustomEditor(doc, p.panel);
  await p.send({ type: 'ready' });
  return { doc, ...p };
}

test('registers both editors, the commands and a status bar item', () => {
  assert.deepEqual(vscodeMock.window.registered.map(r => r[0]), ['hexViewer.editor', 'hexViewer.binary']);
  // each view type has its own provider and its own change event (VS Code looks documents up per view type)
  assert.notEqual(provider, provider2);
  assert.notEqual(provider.onDidChangeCustomDocument, provider2.onDidChangeCustomDocument);
  for (const c of ['hexViewer.openWith', 'hexViewer.goToOffset', 'hexViewer.find', 'hexViewer.supportDeveloper', 'hexViewer.moreViewers']) assert.ok(vscodeMock.commands.list.includes(c), c);
});

test('init, read, edit with undo/redo events, save, copy, search', async () => {
  const f = path.join(tmp, 'img.png');
  const data = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200000, 7)]);
  fs.writeFileSync(f, data);
  const o = await open(f);
  const init = o.last('init');
  assert.equal(init.size, data.length); assert.equal(init.fileType, 'PNG image'); assert.equal(init.readOnly, false);
  assert.match(o.panel.webview.html, /default-src 'none'/);
  await o.send({ type: 'read', offset: 65536, length: 65536 });
  const d = o.last('data');
  assert.equal(d.offset, 65536); assert.equal(d.bytes.length, 65536);
  const events = [], others = [];
  provider.onDidChangeCustomDocument(e => events.push(e));
  provider2.onDidChangeCustomDocument(e => others.push(e));
  await o.send({ type: 'edit', offset: 8, values: [0xaa, 0xbb], label: 'Edit byte' });
  await settle();
  assert.equal(events.length, 1);
  assert.equal(others.length, 0, 'the other view type does not get this document\'s edits');
  assert.deepEqual([...o.last('patch').bytes], [0xaa, 0xbb]);
  assert.deepEqual(o.last('patch').edited, [8, 9]);
  events[0].undo(); await settle();
  assert.deepEqual([...o.last('patch').bytes], [7, 7]);
  events[0].redo(); await settle();
  await provider.saveCustomDocument(o.doc);
  assert.ok(o.sent.some(m => m.type === 'saved'));
  assert.deepEqual([...fs.readFileSync(f).subarray(8, 10)], [0xaa, 0xbb]);
  await o.send({ type: 'copy', start: 0, end: 4, format: 'c' });
  assert.equal(state.clipboard, 'unsigned char img[4] = {\n  0x89, 0x50, 0x4E, 0x47\n};');
  assert.match(o.last('copied').text, /4 bytes as C array/);
  await o.send({ type: 'search', query: 'aa bb', mode: 'hex', from: 0, backward: false, id: 1 });
  assert.equal(o.last('searchResult').offset, 8);
  await o.send({ type: 'search', query: 'zz', mode: 'hex', from: 0, backward: false, id: 2 });
  assert.match(o.last('searchResult').error, /not hex/);
  await o.send({ type: 'cursor', offset: 0x1234, selStart: 0x1234, selEnd: 0x1244 });
  assert.match(state.status.text, /0x1234 \(4,660\) · 16 bytes selected/);
});

test('read-only setting blocks edits with a message', async () => {
  const f = path.join(tmp, 'ro.bin'); fs.writeFileSync(f, Buffer.alloc(32));
  state.config.readOnly = true;
  const o = await open(f);
  await o.send({ type: 'edit', offset: 0, values: [1] });
  assert.match(o.last('notice').message, /Editing is off/);
  assert.equal(fs.readFileSync(f)[0], 0);
  state.config.readOnly = false;
});

test('hostile files: no permission and a symlink loop show a plain message', async () => {
  if (process.getuid && process.getuid() !== 0) {
    const n = path.join(tmp, 'noperm.bin'); fs.writeFileSync(n, 'x'); fs.chmodSync(n, 0);
    const o = await open(n);
    assert.match(o.last('init').error, /permission.*EACCES/);
    fs.chmodSync(n, 0o644);
  }
  const l = path.join(tmp, 'loop'); fs.symlinkSync('loop', l);
  const o2 = await open(l);
  assert.match(o2.last('init').error, /link loop.*ELOOP/);
});

test('truncated while open: the next read sends a changed message', async () => {
  const f = path.join(tmp, 't.bin'); fs.writeFileSync(f, Buffer.alloc(2 * 1024 * 1024, 1));
  const o = await open(f);
  fs.truncateSync(f, 1024);
  await o.send({ type: 'read', offset: 1024 * 1024, length: 65536 });
  const c = o.last('changed');
  assert.equal(c.size, 1024);
  assert.match(c.message, /got shorter on disk: 2\.00 MB before, 1\.00 KB now/);
});

test('protocol rejects bad messages', () => {
  assert.equal(validateWebviewMessage({ type: 'read', offset: -1, length: 10 }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'read', offset: 0, length: 2 << 20 }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'edit', offset: 0, values: [256] }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'copy', start: 5, end: 1, format: 'hex' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'copy', start: 0, end: 1, format: 'exe' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'search', query: 'a', mode: 'regex', from: 0, id: 1 }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'nope' }).ok, false);
  assert.equal(validateWebviewMessage(null).ok, false);
  assert.equal(validateWebviewMessage({ type: 'edit', offset: 3, values: new Uint8Array([1, 2]) }).ok, true);
});

test('webview HTML: strict CSP, nonce scripts, no remote origins', () => {
  const html = buildHtml({ cspSource: 'https://csp', scriptUri: 'https://res/w.js', styleUri: 'https://res/w.css', title: 'a"<b>.bin', nonce: 'N1' });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-N1'/);
  assert.match(html, /img-src https:\/\/csp blob: data:/);
  assert.doesNotMatch(html, /connect-src/);
  const urls = html.match(/https?:\/\/[^"' )<]+/g) || [];
  for (const u of urls) assert.match(u, /^https:\/\/(csp|res\/|marketplace\.visualstudio\.com\/|github\.com\/|www\.paypal\.me\/)/, u);
  assert.match(html, /a&quot;&lt;b&gt;\.bin/);
});
