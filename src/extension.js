'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { HexDocument } = require('./core/doc');
const { validateWebviewMessage } = require('./core/protocol');
const { fmtSize, fmtInt, hexOffset, parseOffset, parsePattern, formatCopy, detectType, COPY_FORMATS } = require('./core/bytes');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_ANY = 'hexViewer.editor';     // "Open With" for every file
const VIEW_BIN = 'hexViewer.binary';     // default editor for .bin, .dat, .img, .rom, .dmp, .dump
const VIEW_TYPES = [VIEW_ANY, VIEW_BIN];
const EXT_ID = 'zovo.hex-viewer';
const MAX_COPY = 32 << 20;
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('hexViewer');
  return {
    bytesPerRow: c.get('bytesPerRow', 16),
    encoding: c.get('encoding', 'ascii'),
    controlChars: c.get('controlChars', 'dot'),
    copyFormat: c.get('copyFormat', 'hexSpaced'),
    fontSize: c.get('fontSize', 0),
    littleEndian: c.get('littleEndian', true),
    readOnly: c.get('readOnly', false),
    showInspector: c.get('showInspector', true),
    maxRemoteMB: c.get('maxRemoteMB', 256),
    uppercase: c.get('uppercase', true),
  };
}

/** Plain words for file system errors. */
function errorText(e) {
  const code = e && e.code;
  const m = {
    EACCES: 'You do not have permission to read this file.',
    EPERM: 'The system does not allow this file to be read.',
    ELOOP: 'This is a symbolic link that points to itself (a link loop), so there is no file to read.',
    ENOENT: 'The file does not exist (it was moved or deleted, or it is a broken link).',
    EISDIR: 'This is a folder, not a file.',
    FileNotFound: 'The file does not exist (it was moved or deleted, or it is a broken link).',
    NoPermissions: 'You do not have permission to read this file.',
  }[code];
  if (m) return `${m} (${code})`;
  const msg = (e && e.message) || String(e);
  if (/EACCES|permission/i.test(msg)) return 'You do not have permission to read this file. (' + msg + ')';
  if (/ELOOP/.test(msg)) return 'This is a symbolic link that points to itself (a link loop). (' + msg + ')';
  return msg;
}

class HexDoc {
  constructor(uri, hex, error) {
    this.uri = uri; this.hex = hex; this.error = error; this.panels = new Set(); this.watcher = null; this.savingUntil = 0;
  }
  post(m) { for (const p of this.panels) p.webview.postMessage(m).then(undefined, () => {}); }
  dispose() {
    if (this.watcher) this.watcher.dispose();
    if (this.hex) this.hex.dispose();
  }
}

class HexEditorProvider {
  /**
   * One provider per view type: VS Code looks up each change event's document in the store of the view type
   * that listens, so the two view types must not share an event emitter. `shared` holds the active editor
   * and the status bar item for both.
   */
  constructor(context, shared) {
    this.context = context;
    this.shared = shared;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChange.event;
    context.subscriptions.push(this._onDidChange);
  }
  get active() { return this.shared.active; }
  set active(v) { this.shared.active = v; }
  get status() { return this.shared.status; }

  async openCustomDocument(uri, openContext) {
    let hex = null, error = null;
    try {
      if (uri.scheme === 'file') {
        hex = await HexDocument.openFile(uri.fsPath);
      } else {
        const stat = await vscode.workspace.fs.stat(uri);
        const capMB = settings().maxRemoteMB;
        if (stat.size > capMB * 1048576) {
          error = `This file is ${fmtSize(stat.size)}. Files on remote or virtual file systems open up to ${capMB} MB (setting hexViewer.maxRemoteMB). Local files of any size open.`;
        } else {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const writable = vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== false;
          hex = HexDocument.fromBytes(bytes, writable ? b => vscode.workspace.fs.writeFile(uri, b) : null);
        }
      }
    } catch (e) {
      error = errorText(e);
    }
    const doc = new HexDoc(uri, hex, error);
    if (hex && openContext && openContext.backupId) {
      try { hex.restoreBackup(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId))).toString('utf8')); } catch {}
    }
    if (hex && uri.scheme === 'file') this.watch(doc);
    return doc;
  }

  watch(doc) {
    try {
      const dir = vscode.Uri.file(path.dirname(doc.uri.fsPath));
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.basename(doc.uri.fsPath)));
      const changed = async () => {
        if (Date.now() < doc.savingUntil) return;
        await this.reload(doc, true);
      };
      w.onDidChange(changed); w.onDidCreate(changed);
      w.onDidDelete(() => doc.post({ type: 'notice', level: 'warn', message: 'The file was deleted or moved on disk. The bytes you see may be gone.' }));
      doc.watcher = w;
    } catch {}
  }

  /** Re-read the size after a change on disk and tell the webviews. */
  async reload(doc, fromWatcher) {
    if (!doc.hex) return;
    const old = doc.hex.size;
    let size;
    try { size = await doc.hex.refresh(); } catch (e) { doc.post({ type: 'notice', level: 'error', message: errorText(e) }); return; }
    let message = '';
    if (size < old) message = `The file got shorter on disk: ${fmtSize(old)} before, ${fmtSize(size)} now. The view shows the new end of the file.`;
    else if (size > old) message = `The file grew on disk: ${fmtSize(old)} before, ${fmtSize(size)} now.`;
    else if (fromWatcher) message = 'The file changed on disk. The view shows the new bytes.';
    doc.post({ type: 'changed', size, sizeText: fmtSize(size), message });
  }

  async resolveCustomEditor(doc, panel) {
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: [...commandUris('hexViewer'), 'hexViewer.goToOffset'] };
    const name = path.posix.basename(doc.uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'hexViewer'),
    });
    doc.panels.add(panel);
    const me = { doc, panel, cursor: null };
    let disposed = false, counted = false, searchId = 0;
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));
    const setActive = () => { if (panel.active) { this.active = me; this.showStatus(); } else if (this.active === me) { this.active = null; this.showStatus(); } };
    panel.onDidChangeViewState(setActive);
    setActive();
    const cfgSub = vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('hexViewer')) post({ type: 'config', settings: settings() }); });

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') {
          if (!doc.hex) { rating.failure(); await post({ type: 'init', name, error: doc.error, settings: settings() }); return; }
          const head = await doc.hex.read(0, 64);
          const writable = await doc.hex.writable();
          await post({
            type: 'init', name, size: doc.hex.size, sizeText: fmtSize(doc.hex.size), fileType: detectType(head),
            readOnly: !writable, readOnlyReason: writable ? '' : 'The file is read-only on disk.', settings: settings(),
            edited: doc.hex.editedIn(0, Number.MAX_SAFE_INTEGER).slice(0, 200000), copyFormats: COPY_FORMATS,
          });
          return;
        }
        if (!doc.hex) return;
        const hex = doc.hex;
        if (msg.type === 'read') {
          const want = Math.min(msg.length, Math.max(0, hex.size - msg.offset));
          const bytes = await hex.read(msg.offset, msg.length);
          await post({ type: 'data', offset: msg.offset, bytes, edited: hex.editedIn(msg.offset, bytes.length), size: hex.size });
          if (bytes.length < want) await this.reload(doc, false); // the file got shorter since it was opened
          return;
        }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        if (msg.type === 'cursor') { me.cursor = msg; if (this.active === me) this.showStatus(); return; }
        if (msg.type === 'gotoPrompt') { await vscode.commands.executeCommand('hexViewer.goToOffset'); return; }
        if (msg.type === 'error') { console.error('[hex-viewer webview]', msg.message); return; }
        if (msg.type === 'edit') {
          if (settings().readOnly || !(await hex.writable())) {
            await post({ type: 'notice', level: 'warn', message: settings().readOnly ? 'Editing is off (setting hexViewer.readOnly).' : 'This file is read-only, so it cannot be edited.' });
            return;
          }
          const rec = await hex.overwrite(msg.offset, msg.values);
          if (!rec) return;
          this.sendPatch(doc, rec.offset, rec.after.length);
          this._onDidChange.fire({
            document: doc, label: msg.label,
            undo: () => { hex.apply(rec, true); this.sendPatch(doc, rec.offset, rec.after.length); },
            redo: () => { hex.apply(rec, false); this.sendPatch(doc, rec.offset, rec.after.length); },
          });
          return;
        }
        if (msg.type === 'copy') {
          const n = Math.min(msg.end, hex.size) - msg.start;
          if (n <= 0) return;
          if (n > MAX_COPY) { await post({ type: 'notice', level: 'warn', message: `The selection is ${fmtSize(n)}. Copy works up to ${fmtSize(MAX_COPY)}.` }); return; }
          const bytes = await hex.read(msg.start, n);
          const text = formatCopy(bytes, msg.format, name.replace(/\.[^.]*$/, ''));
          await vscode.env.clipboard.writeText(text);
          const label = (COPY_FORMATS.find(f => f[0] === msg.format) || [0, msg.format])[1];
          await post({ type: 'copied', text: `Copied ${fmtInt(bytes.length)} byte${bytes.length === 1 ? '' : 's'} as ${label}.` });
          return;
        }
        if (msg.type === 'cancelSearch') { searchId = -1; return; }
        if (msg.type === 'search') {
          const p = parsePattern(msg.query, msg.mode, msg.ignoreCase);
          if (!p.ok) { await post({ type: 'searchResult', id: msg.id, offset: -1, error: p.error }); return; }
          const id = searchId = msg.id;
          const t0 = Date.now();
          const r = await hex.search(p, msg.from, msg.backward, true, () => searchId !== id || disposed,
            (done, total) => post({ type: 'searchProgress', id, done, total }));
          await post({ type: 'searchResult', id, offset: r.offset, length: p.bytes.length, wrapped: !!r.wrapped, cancelled: !!r.cancelled, ms: Date.now() - t0 });
        }
      } catch (e) {
        await post({ type: 'notice', level: 'error', message: errorText(e) });
      }
    });
    panel.onDidDispose(() => {
      disposed = true; cfgSub.dispose(); doc.panels.delete(panel);
      if (this.active === me) { this.active = null; this.showStatus(); }
    });
  }

  sendPatch(doc, offset, length) {
    // Send the changed range plus its edit marks; the webview updates its cached rows.
    doc.hex.read(offset, length).then(bytes => doc.post({ type: 'patch', offset, bytes, edited: doc.hex.editedIn(offset, length) }), () => {});
  }

  showStatus() {
    const a = this.active;
    if (!a || !a.doc.hex) { this.status.hide(); return; }
    const c = a.cursor || { offset: 0, selStart: 0, selEnd: 0 };
    const sel = c.selEnd - c.selStart;
    this.status.text = `$(go-to-file) 0x${hexOffset(c.offset, 1)} (${fmtInt(c.offset)})` + (sel > 1 ? ` · ${fmtInt(sel)} bytes selected` : '') + ` · ${fmtSize(a.doc.hex.size)}`;
    this.status.show();
  }

  async saveCustomDocument(doc) {
    if (!doc.hex) return;
    doc.savingUntil = Date.now() + 1500;
    await doc.hex.save();
    doc.savingUntil = Date.now() + 1500;
    doc.post({ type: 'saved' });
  }

  async saveCustomDocumentAs(doc, dest) {
    if (!doc.hex) return;
    if (dest.scheme === 'file') { await doc.hex.saveAsFile(dest.fsPath); return; }
    if (doc.hex.size > settings().maxRemoteMB * 1048576) throw new Error('This file is too large to save to a remote file system.');
    await vscode.workspace.fs.writeFile(dest, await doc.hex.readAll());
  }

  async revertCustomDocument(doc) {
    if (!doc.hex) return;
    doc.hex.revert();
    await doc.hex.refresh();
    doc.post({ type: 'reset', size: doc.hex.size, sizeText: fmtSize(doc.hex.size) });
  }

  async backupCustomDocument(doc, ctx) {
    const dest = ctx.destination;
    await vscode.workspace.fs.writeFile(dest, Buffer.from(doc.hex ? doc.hex.backupJson() : '{}', 'utf8'));
    return { id: dest.toString(), delete: async () => { try { await vscode.workspace.fs.delete(dest); } catch {} } };
  }
}

/** The file of the active tab, also for the "binary file" placeholder that has no text editor. */
function activeUri() {
  try {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    if (input && input.uri) return input.uri;
  } catch {}
  return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : undefined;
}

function sameFileTab(uri) {
  try {
    const key = uri.toString();
    return vscode.window.tabGroups.activeTabGroup.tabs.find(t => t.input && t.input.uri && t.input.uri.toString() === key
      && !(typeof t.input.viewType === 'string' && /^hexViewer\./.test(t.input.viewType)));
  } catch { return undefined; }
}

async function goToOffset(shared) {
  // Ctrl+G reaches here twice when both the webview and the keybinding see it; one box is enough.
  if (shared.gotoBusy) return;
  const a = shared.active;
  if (!a || !a.doc.hex) { vscode.window.showInformationMessage('Open a file in Hex Viewer first.'); return; }
  const size = a.doc.hex.size;
  const cur = (a.cursor && a.cursor.offset) || 0;
  shared.gotoBusy = true;
  let input;
  try {
    input = await vscode.window.showInputBox({
    title: 'Go to offset',
    prompt: `Hex (0x1F40), decimal (8000), relative (+0x100, -16) or "end". The file is ${fmtSize(size)}; the last byte is at 0x${hexOffset(Math.max(0, size - 1), 1)}.`,
    placeHolder: '0x' + hexOffset(cur, 1),
      validateInput: s => { const r = parseOffset(s, cur, size); return r.ok ? null : r.error; },
    });
  } finally { shared.gotoBusy = false; }
  if (input === undefined) return;
  const r = parseOffset(input, cur, size);
  if (r.ok) a.panel.webview.postMessage({ type: 'goto', offset: r.offset });
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'hexViewer', name: 'Hex Viewer' });
  registerSupport({ vscode, context, prefix: 'hexViewer', selfId: EXT_ID });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'hexViewer.goToOffset';
  status.tooltip = 'Hex Viewer: go to offset (Ctrl+G)';
  context.subscriptions.push(status);
  const shared = { active: null, status, gotoBusy: false };
  for (const vt of VIEW_TYPES) {
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(vt, new HexEditorProvider(context, shared), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }));
  }
  const post = m => { if (shared.active) shared.active.panel.webview.postMessage(m); };
  context.subscriptions.push(
    vscode.commands.registerCommand('hexViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#hexViewer.start`, false)),
    vscode.commands.registerCommand('hexViewer.openWith', async (uri, uris) => {
      const list = Array.isArray(uris) && uris.length ? uris : [uri && uri.scheme ? uri : activeUri()];
      if (!list[0]) {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Open in Hex Viewer' });
        if (picked) list.splice(0, 1, ...picked); else return;
      }
      for (const u of list.filter(Boolean)) {
        // "Open in Hex Viewer" on a file that is open in another editor in this group replaces that tab (unless it has unsaved changes).
        const had = !!sameFileTab(u);
        await vscode.commands.executeCommand('vscode.openWith', u, VIEW_ANY);
        // Look the old tab up again after the open: older VS Code builds (1.90) do not close a Tab object read before it.
        const old = had && sameFileTab(u);
        if (old && !old.isDirty) { try { await vscode.window.tabGroups.close(old, true); } catch {} }
      }
    }),
    vscode.commands.registerCommand('hexViewer.goToOffset', () => goToOffset(shared)),
    vscode.commands.registerCommand('hexViewer.find', () => post({ type: 'find' })),
    vscode.commands.registerCommand('hexViewer.findNext', () => post({ type: 'findNext', backward: false })),
    vscode.commands.registerCommand('hexViewer.findPrevious', () => post({ type: 'findNext', backward: true })),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, HexEditorProvider, VIEW_ANY, VIEW_BIN, errorText, settings };
