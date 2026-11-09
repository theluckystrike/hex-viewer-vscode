'use strict';
// EXEC9 test helper: one fresh extension host (one "session") with a mocked VS Code, driven by a scenario name.
// Prints JSON: the messages the host posted, the URLs it opened, the quick pick items it showed and any popup.
// Usage: node custom-host.js <scenario> <tmp dir> [empty-funding-key]
const fs = require('fs');
const path = require('path');
const Module = require('module');

const [scenario, tmp, emptyKey] = process.argv.slice(2);
const out = { sent: [], external: [], picks: [], modal: [], infos: [], errors: [] };
const global = new Map();
let pickAnswer = null;

function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
class Emitter { constructor() { this.h = []; this.event = f => { this.h.push(f); return { dispose() {} }; }; } fire(e) { for (const f of this.h) f(e); } dispose() {} }
const vscodeMock = {
  version: '1.142.0',
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s, scheme: 'https' }) },
  EventEmitter: Emitter,
  QuickPickItemKind: { Separator: -1, Default: 0 },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  StatusBarAlignment: { Right: 2 }, ViewColumn: { Beside: -2, Active: -1 }, ProgressLocation: { Notification: 15, Window: 10 },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    fs: { stat: async u => fs.statSync(u.fsPath), readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d), isWritableFileSystem: () => true },
    openTextDocument: async o => o,
    findFiles: async () => [],
    getWorkspaceFolder: () => undefined,
  },
  window: {
    registered: [],
    registerCustomEditorProvider(id, p) { this.registered.push([id, p]); return { dispose() {} }; },
    createStatusBarItem() { return { text: '', show() {}, hide() {}, dispose() {} }; },
    showInformationMessage: async (msg, opts) => { if (opts && opts.modal) out.modal.push(msg); else out.infos.push(msg); return undefined; },
    showWarningMessage: async msg => { out.infos.push(String(msg)); return undefined; },
    showErrorMessage: async m => { out.errors.push(String(m)); },
    showInputBox: async () => undefined,
    showQuickPick: async items => { out.picks.push(items.map(i => ({ label: i.label, id: i.id, kind: i.kind }))); return typeof pickAnswer === 'function' ? pickAnswer(items) : undefined; },
    showTextDocument: async () => {},
    setStatusBarMessage: () => ({ dispose() {} }),
    showSaveDialog: async () => undefined,
    showOpenDialog: async () => undefined,
    withProgress: async (o, f) => f({ report() {} }, { isCancellationRequested: false }),
    createQuickPick: () => ({ items: [], selectedItems: [], show() {}, onDidAccept() {}, onDidHide() {}, dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    state: { focused: true },
  },
  commands: { registerCommand() { return { dispose() {} }; }, executeCommand: async () => {} },
  env: { appName: 'Visual Studio Code', clipboard: { writeText: async () => {} }, openExternal: async u => { out.external.push(String(u)); return true; } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };

const CO = require('../../src/custom-offer.js');
if (emptyKey) CO.FUNDING_CUSTOM[emptyKey] = emptyKey === 'custom_format_usd' ? 0 : '';
const ext = require('../../src/extension.js');
const ctx = {
  subscriptions: [], extensionUri: uriOf('/ext'), extension: { packageJSON: { version: '0.3.3' } },
  globalState: { get: k => global.get(k), update: async (k, v) => { global.set(k, v); }, setKeysForSync() {} },
  workspaceState: { get: () => undefined, update: async () => {} },
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
};
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

async function open(file) {
  const provider = vscodeMock.window.registered[0][1];
  const doc = await provider.openCustomDocument(uriOf(file), {});
  const sent = []; let handler = null;
  const panel = { active: true, webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(m); out.sent.push(m); return true; }, onDidReceiveMessage: h => { handler = h; } }, onDidDispose: () => {}, onDidChangeViewState: () => {} };
  await provider.resolveCustomEditor(doc, panel);
  await handler({ type: 'ready' });
  await settle();
  return { send: async m => { await handler(m); await settle(); }, sent, grants: () => sent.filter(m => m.type === 'customGrant') };
}

(async () => {
  ext.activate(ctx);
  const nomatch = path.join(tmp, 'capture.xyz');
  fs.writeFileSync(nomatch, Buffer.from('ZQ\x01\x02 not a known format ' + 'x'.repeat(200)));
  const png = path.join(tmp, 'logo.png');
  fs.copyFileSync(path.join(__dirname, '..', '..', 'images', 'hex-viewer-png.png'), png);
  const r = {};
  if (scenario === 'panel') {
    // a no-match file: Structure tab clicked (structDetect), the webview claims twice, a second tab claims too
    const v = await open(nomatch);
    r.onOpen = v.sent.filter(m => m.type === 'customGrant').length;
    await v.send({ type: 'structDetect' });
    r.best = v.sent.filter(m => m.type === 'structInfo').pop().best;
    await v.send({ type: 'customClaim' });
    await v.send({ type: 'customClaim' });
    const w = await open(nomatch);
    await w.send({ type: 'customClaim' });
    r.grantsFirst = v.grants().length; r.grantsSecond = w.grants().length; r.usd = (v.grants()[0] || {}).usd;
    await v.send({ type: 'customOpen', which: 'request' });
    await v.send({ type: 'customOpen', which: 'tier' });
    await v.send({ type: 'customOpen', which: 'https://evil.example' });
  } else if (scenario === 'match') {
    const v = await open(png);
    await v.send({ type: 'structDetect' });
    r.best = v.sent.filter(m => m.type === 'structInfo').pop().best;
    await v.send({ type: 'customClaim' });
    await v.send({ type: 'customOpen', which: 'tier' });
    r.grants = v.grants().length;
    // the same session then opens a no-match file: the line is still available
    const w = await open(nomatch);
    await w.send({ type: 'customClaim' });
    r.grantsAfter = w.grants().length;
  } else if (scenario === 'picker-nomatch') {
    const v = await open(nomatch);
    pickAnswer = items => items.find(i => i.id === '__customRequest');
    await v.send({ type: 'structPick' });
    pickAnswer = null;
    await v.send({ type: 'structPick' });
    await v.send({ type: 'customClaim' });
    r.grants = v.grants().length;
  } else if (scenario === 'picker-none') {
    const v = await open(png);
    pickAnswer = items => items.find(i => i.id === '__none');
    await v.send({ type: 'structPick' });
    r.grants = v.grants().length;
    pickAnswer = null;
    await v.send({ type: 'structPick' });
  }
  out.result = r;
  process.stdout.write(JSON.stringify(out));
})().catch(e => { process.stdout.write(JSON.stringify({ crash: String(e && e.stack || e) })); });
