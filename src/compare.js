'use strict';
// "Compare in Hex Viewer": two files side by side, offset by offset, with the differences marked,
// next and previous difference (F7, Shift+F7) and a summary that counts every differing byte.
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { HexDocument } = require('./core/doc');
const { findDiff, diffStats } = require('./core/compare');
const { fmtSize } = require('./core/bytes');
const { showLinks, commandUris } = require('./support');

const MAX_READ = 1 << 20;
const isOff = v => Number.isSafeInteger(v) && v >= 0;

async function openDoc(uri) {
  if (uri.scheme === 'file') return HexDocument.openFile(uri.fsPath);
  const cap = vscode.workspace.getConfiguration('hexViewer').get('maxRemoteMB', 256);
  const st = await vscode.workspace.fs.stat(uri);
  if (st.size > cap * 1048576) throw new Error(`${path.posix.basename(uri.path)} is ${fmtSize(st.size)}. Files on remote or virtual file systems open up to ${cap} MB (setting hexViewer.maxRemoteMB).`);
  return HexDocument.fromBytes(await vscode.workspace.fs.readFile(uri), null);
}

/** Pick the two files: two selected in the Explorer, or the given/active file and one more from a dialog. */
async function pickPair(uri, uris, activeUri) {
  if (Array.isArray(uris) && uris.length >= 2) return [uris[0], uris[1]];
  let a = uri && uri.scheme ? uri : activeUri();
  if (!a) {
    const p = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Compare', title: 'Hex Viewer: pick the first file (or both)' });
    if (!p || !p.length) return null;
    if (p.length >= 2) return [p[0], p[1]];
    a = p[0];
  }
  const dir = a.scheme === 'file' ? vscode.Uri.file(path.dirname(a.fsPath)) : undefined;
  const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', defaultUri: dir, title: `Hex Viewer: compare ${path.posix.basename(a.path)} with...` });
  if (!p || !p.length) return null;
  return [a, p[0]];
}

function validate(m) {
  if (!m || typeof m !== 'object') return null;
  switch (m.type) {
    case 'ready': case 'stats': case 'cancel': return { type: m.type };
    case 'read': return isOff(m.offset) && Number.isSafeInteger(m.length) && m.length > 0 && m.length <= MAX_READ ? { type: 'read', offset: m.offset, length: m.length } : null;
    case 'diff': return isOff(m.from) && Number.isSafeInteger(m.id) ? { type: 'diff', from: m.from, backward: !!m.backward, id: m.id } : null;
    case 'error': return { type: 'error', message: String(m.message || '').slice(0, 500) };
    default: return null;
  }
}

async function openCompare(context, uri, uris, activeUri) {
  const pair = await pickPair(uri, uris, activeUri);
  if (!pair) return;
  const [ua, ub] = pair;
  const na = path.posix.basename(ua.path), nb = path.posix.basename(ub.path);
  let a, b;
  try {
    a = await openDoc(ua);
    b = await openDoc(ub);
  } catch (e) {
    if (a) await a.dispose();
    const which = a ? nb : na;
    const why = { EISDIR: `${which} is a folder, not a file.`, EACCES: `you do not have permission to read ${which}.`, EPERM: `the system does not allow ${which} to be read.`, ENOENT: `${which} does not exist (moved, deleted or a broken link).`, ELOOP: `${which} is a symbolic link that points to itself.` }[e.code];
    vscode.window.showErrorMessage(`Hex Viewer cannot compare: ${why ? why + ` (${e.code})` : e.message}`);
    return;
  }
  const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const title = na === nb ? `${na} (compare)` : `${na} ↔ ${nb}`;
  const panel = vscode.window.createWebviewPanel('hexViewer.compare', title, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('hexViewer'),
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
  panel.webview.html = buildHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'compare.js')).toString(),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
    title, showSupportLinks: showLinks(vscode, 'hexViewer'),
  });
  let disposed = false, diffId = 0, statsRun = 0, known = null; // known: { first, last } once the count is done
  const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));
  const label = (u, d) => ({ name: path.posix.basename(u.path), path: u.scheme === 'file' ? u.fsPath : u.toString(), size: d.size, sizeText: fmtSize(d.size) });
  panel.webview.onDidReceiveMessage(async raw => {
    const m = validate(raw);
    if (!m) return;
    try {
      if (m.type === 'ready') {
        const cfg = vscode.workspace.getConfiguration('hexViewer');
        await post({ type: 'init', a: label(ua, a), b: label(ub, b), settings: { uppercase: cfg.get('uppercase', true), fontSize: cfg.get('fontSize', 0) } });
        return;
      }
      if (m.type === 'read') {
        const [x, y] = await Promise.all([a.read(m.offset, m.length), b.read(m.offset, m.length)]);
        await post({ type: 'data', offset: m.offset, a: x, b: y });
        return;
      }
      if (m.type === 'cancel') { diffId = -1; statsRun++; return; }
      if (m.type === 'diff') {
        const id = diffId = m.id;
        // After the count, the first and last difference are known: no need to read the files for these jumps.
        if (known && (known.first < 0 || (!m.backward && (m.from <= known.first || m.from > known.last)) || (m.backward && (m.from >= known.last || m.from < known.first)))) {
          const offset = known.first < 0 ? -1 : !m.backward ? (m.from <= known.first ? known.first : -1) : (m.from >= known.last ? known.last : -1);
          await post({ type: 'diffResult', id, offset, cancelled: false });
          return;
        }
        const r = await findDiff(a, b, m.from, m.backward, () => disposed || diffId !== id, (done, total) => post({ type: 'diffProgress', id, done, total }));
        await post({ type: 'diffResult', id, offset: r.offset, cancelled: !!r.cancelled });
        return;
      }
      if (m.type === 'stats') {
        const run = ++statsRun;
        const t0 = Date.now();
        const s = await diffStats(a, b, () => disposed || statsRun !== run, (done, total) => post({ type: 'statsProgress', done, total }));
        if (!s.cancelled) { known = { first: s.first, last: s.last }; await post({ type: 'stats', ...s, ms: Date.now() - t0 }); }
        return;
      }
      if (m.type === 'error') console.error('[hex-viewer compare]', m.message);
    } catch (e) {
      await post({ type: 'notice', level: 'error', message: String((e && e.message) || e) });
    }
  });
  panel.onDidDispose(async () => { disposed = true; await a.dispose(); await b.dispose(); });
  return panel;
}

module.exports = { openCompare, validate };
