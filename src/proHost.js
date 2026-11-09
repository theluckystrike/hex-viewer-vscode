'use strict';
// Hex Viewer Pro features in the extension host: binary templates (Structure view), bookmarks and notes,
// the compare report and find in files. Each Pro action asks pro.gate() first; the free viewer never waits for it.
const fs = require('fs');
const path = require('path');
const T = require('./core/template');
const { BUILTIN } = require('./templates');
const { BookmarkStore } = require('./core/bookmarks');
const { writeReport } = require('./core/report');
const { searchFiles } = require('./core/multisearch');
const { checksums } = require('./core/checksum');
const { parsePattern, hexOffset, fmtInt, fmtSize, hex2 } = require('./core/bytes');

const MAX_TEMPLATE_FILES = 200;
const MAX_TEMPLATE_BYTES = 1 << 20;
const MAX_CHOICES = 500;
const BM_KEY = 'hexViewer.bookmarks';
const CHOICE_KEY = 'hexViewer.templateFor';

function createProHost({ vscode, context, pro, shared, viewType }) {
  const bookmarks = new BookmarkStore(context.globalState.get(BM_KEY));
  const saveBookmarks = () => context.globalState.update(BM_KEY, bookmarks.toJSON());
  let userTemplates = { list: [], problems: [], at: 0 };

  // ---------- templates ----------

  function templateFolders() {
    const out = [];
    const cfg = vscode.workspace.getConfiguration('hexViewer').get('templateFolders', []);
    const wsf = vscode.workspace.workspaceFolders || [];
    for (const f of Array.isArray(cfg) ? cfg : []) {
      if (typeof f !== 'string' || !f) continue;
      const p = f.replace(/^~(?=\/|$)/, require('os').homedir());
      if (path.isAbsolute(p)) out.push(p);
      else for (const w of wsf) if (w.uri.scheme === 'file') out.push(path.join(w.uri.fsPath, p));
    }
    for (const w of wsf) if (w.uri.scheme === 'file') out.push(path.join(w.uri.fsPath, '.vscode', 'hex-templates'));
    return [...new Set(out)];
  }

  /** Templates from the user's folders (JSON, comments allowed). Bad files are listed, never thrown. */
  function loadUserTemplates(force) {
    if (!force && Date.now() - userTemplates.at < 3000) return userTemplates;
    const list = [], problems = [];
    let files = 0;
    for (const dir of templateFolders()) {
      let names;
      try { names = fs.readdirSync(dir).filter(n => /\.jsonc?$/i.test(n)).sort(); } catch { continue; }
      for (const n of names) {
        if (++files > MAX_TEMPLATE_FILES) break;
        const p = path.join(dir, n);
        try {
          const st = fs.statSync(p);
          if (st.size > MAX_TEMPLATE_BYTES) { problems.push(`${n}: larger than 1 MB.`); continue; }
          const t = T.parseJsonc(fs.readFileSync(p, 'utf8'));
          const errs = T.checkTemplate(t);
          if (errs.length) { problems.push(`${n}: ${errs.slice(0, 3).join(' ')}`); continue; }
          t.id = 'user:' + (typeof t.id === 'string' ? t.id : n.replace(/\.jsonc?$/i, ''));
          t.source = p;
          list.push(t);
        } catch (e) { problems.push(`${n}: ${String(e.message || e).slice(0, 200)}`); }
      }
    }
    userTemplates = { list, problems, at: Date.now() };
    return userTemplates;
  }
  const allTemplates = () => [...loadUserTemplates().list, ...BUILTIN];
  const byId = id => allTemplates().find(t => t.id === id);

  function choiceFor(uri) { const m = context.globalState.get(CHOICE_KEY) || {}; return m[uri.toString()]; }
  function setChoice(uri, id) {
    const m = { ...(context.globalState.get(CHOICE_KEY) || {}) };
    delete m[uri.toString()];
    m[uri.toString()] = id;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CHOICES))) delete m[k];
    context.globalState.update(CHOICE_KEY, m);
  }

  async function detectFor(me) {
    const name = path.posix.basename(me.doc.uri.path);
    const found = await T.detect(allTemplates(), me.doc.hex, name);
    const chosen = choiceFor(me.doc.uri);
    const pick = (chosen && byId(chosen)) || (found[0] && found[0].template) || null;
    return { found, pick };
  }

  async function sendInfo(me, post) {
    const { found, pick } = await detectFor(me);
    const u = loadUserTemplates();
    await post({ type: 'structInfo', licensed: pro.licensed, onSale: pro.onSale, trials: pro.trials(), structTrial: !!me.structTrial, best: pick ? { id: pick.id, name: pick.name } : null, matches: found.map(f => f.template.id), count: allTemplates().length, problems: u.problems.slice(0, 5) });
  }

  async function parseFor(me, post, id) {
    // a free try opens the Structure view of this tab; edits and template changes in the same tab are part of it
    if (!pro.licensed && !me.structTrial) { await post({ type: 'struct', locked: true, trial: pro.trialLeft('templates') }); return; }
    const run = me.structRun = (me.structRun || 0) + 1;
    const t = id ? byId(id) : (await detectFor(me)).pick;
    if (!t) { await post({ type: 'struct', none: true, count: allTemplates().length }); return; }
    await post({ type: 'structBusy', name: t.name });
    const r = await T.parse(t, me.doc.hex, { shouldStop: () => me.structRun !== run || me.disposed });
    if (me.structRun !== run) return;
    me.struct = { template: t, result: r };
    await post({ type: 'struct', id: t.id, name: t.name, user: !!t.source, tree: T.toWire(r.root), error: r.error, nodes: r.nodes, ms: r.ms });
  }

  async function pickTemplate(me, post) {
    if (!me.structTrial && !(await pro.gate('templates'))) return;
    if (!pro.licensed) me.structTrial = true;
    const { found } = await detectFor(me);
    const matches = new Set(found.map(f => f.template.id));
    const items = allTemplates().map(t => ({ label: t.name, description: (matches.has(t.id) ? 'matches this file' : '') + (t.source ? (matches.has(t.id) ? ', ' : '') + 'your template' : ''), detail: t.source || (t.extensions || []).map(e => '.' + e).join(' '), id: t.id }))
      .sort((a, b) => (matches.has(b.id) - matches.has(a.id)));
    items.push({ label: '$(folder-opened) Add your own templates...', description: 'setting hexViewer.templateFolders', id: '__folders' });
    const p = await vscode.window.showQuickPick(items, { title: 'Hex Viewer Pro: read this file with a template', matchOnDescription: true, matchOnDetail: true });
    if (!p) return;
    if (p.id === '__folders') { vscode.commands.executeCommand('workbench.action.openSettings', 'hexViewer.templateFolders'); return; }
    setChoice(me.doc.uri, p.id);
    await parseFor(me, post, p.id);
  }

  function nodeAt(root, idx) {
    let n = root;
    for (const i of idx || []) { if (!n.children || !n.children[i]) return null; n = n.children[i]; }
    return n;
  }

  async function exportStruct(me, format, idx) {
    if (!me.structTrial && !(await pro.gate('templates'))) return;
    if (!me.struct) { vscode.window.showInformationMessage('Open the Structure view first, so there is a parsed structure to export.'); return; }
    const node = nodeAt(me.struct.result.root, idx) || me.struct.result.root;
    const name = path.posix.basename(me.doc.uri.path);
    const content = format === 'c' ? T.toC(node, name) : JSON.stringify(T.toJson(node), null, 2) + '\n';
    const doc = await vscode.workspace.openTextDocument({ language: format === 'c' ? 'c' : 'json', content });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  // ---------- bookmarks ----------

  const bmKey = doc => doc.uri.toString();
  function broadcastBookmarks(doc) {
    doc.post({ type: 'bookmarks', list: bookmarks.list(bmKey(doc)), licensed: pro.licensed, trial: pro.trialLeft('bookmarks') });
  }

  async function askLabel(title, value, start, end) {
    return vscode.window.showInputBox({
      title, value, prompt: `Bytes 0x${hexOffset(start, 1)} to 0x${hexOffset(end - 1, 1)} (${fmtInt(end - start)} byte${end - start === 1 ? '' : 's'}). A short name for the bookmark.`,
      placeHolder: 'Header, checksum, table of contents...', validateInput: v => (v.length > 120 ? 'Up to 120 characters.' : null),
    });
  }
  async function askNote(value) {
    return vscode.window.showInputBox({ title: 'Note (optional)', value, prompt: 'A note for this bookmark. Leave empty for none. Press Enter to save.', placeHolder: 'What these bytes mean, what to check...' });
  }
  async function pickColor(current) {
    const colors = ['yellow', 'green', 'blue', 'purple', 'red', 'orange'];
    const p = await vscode.window.showQuickPick(colors.map(c => ({ label: c[0].toUpperCase() + c.slice(1), picked: c === current, c })), { title: 'Bookmark color' });
    return p ? p.c : current;
  }

  async function addBookmark(me, start, end) {
    if (!(await pro.allowed('bookmarks'))) return;
    const size = me.doc.hex.size;
    start = Math.max(0, Math.min(start, Math.max(0, size - 1)));
    end = Math.max(start + 1, Math.min(end, size));
    const label = await askLabel('Hex Viewer Pro: add a bookmark', '', start, end);
    if (label === undefined) return;
    const note = await askNote('');
    if (note === undefined) return;
    try { bookmarks.add(bmKey(me.doc), { start, end, label, note, color: 'yellow' }); }
    catch (e) { vscode.window.showWarningMessage(e.message); return; }
    if (!pro.licensed) await pro.useTrial('bookmarks');
    await saveBookmarks();
    broadcastBookmarks(me.doc);
  }

  // Bookmarks you have are yours: viewing, jumping, editing and removing them never needs Pro.
  async function editBookmark(me, id) {
    const b = bookmarks.list(bmKey(me.doc)).find(x => x.id === id);
    if (!b) return;
    const what = await vscode.window.showQuickPick([
      { label: '$(edit) Rename', k: 'label' }, { label: '$(note) Edit the note', k: 'note' }, { label: '$(symbol-color) Color', k: 'color' },
      { label: '$(selection) Use the current selection as its range', k: 'range' }, { label: '$(trash) Remove', k: 'remove' },
    ], { title: `Bookmark "${b.label}"` });
    if (!what) return;
    if (what.k === 'remove') bookmarks.remove(bmKey(me.doc), id);
    else if (what.k === 'label') { const v = await askLabel('Rename the bookmark', b.label, b.start, b.end); if (v === undefined) return; bookmarks.update(bmKey(me.doc), id, { label: v }); }
    else if (what.k === 'note') { const v = await askNote(b.note); if (v === undefined) return; bookmarks.update(bmKey(me.doc), id, { note: v }); }
    else if (what.k === 'color') bookmarks.update(bmKey(me.doc), id, { color: await pickColor(b.color) });
    else if (what.k === 'range') { const c = me.cursor; if (!c) return; bookmarks.update(bmKey(me.doc), id, { start: c.selStart, end: Math.max(c.selEnd, c.selStart + 1) }); }
    await saveBookmarks();
    broadcastBookmarks(me.doc);
  }

  async function exportBookmarks(me) {
    if (!(await pro.gate('bookmarks'))) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: bookmarks.markdown(bmKey(me.doc), path.posix.basename(me.doc.uri.path)) });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  // ---------- messages from the viewer ----------

  const TYPES = new Set(['checksums', 'proState', 'proGet', 'proKey', 'proExplain', 'proTry', 'structDetect', 'structParse', 'structPick', 'structExport', 'bmList', 'bmAdd', 'bmEdit', 'bmRemove', 'bmExport']);
  async function handle(me, msg, post) {
    switch (msg.type) {
      case 'proState': return post({ type: 'pro', licensed: pro.licensed, onSale: pro.onSale, trials: pro.trials() });
      case 'proTry':
        if (msg.feature === 'templates') { if (pro.licensed || me.structTrial || (await pro.gate('templates'))) { if (!pro.licensed) me.structTrial = true; await sendInfo(me, post); return parseFor(me, post); } return; }
        if (msg.feature === 'bookmarks') { const c = me.cursor || { selStart: 0, selEnd: 1 }; return addBookmark(me, c.selStart, Math.max(c.selEnd, c.selStart + 1)); }
        return;
      case 'proGet': return pro.getPro();
      case 'proKey': return pro.enterKey();
      case 'proExplain': return pro.explain(msg.feature);
      case 'structDetect': return sendInfo(me, post);
      case 'structParse': return parseFor(me, post, msg.id);
      case 'structPick': return pickTemplate(me, post);
      case 'structExport': return exportStruct(me, msg.format, msg.path);
      case 'bmList': return post({ type: 'bookmarks', list: bookmarks.list(bmKey(me.doc)), licensed: pro.licensed, trial: pro.trialLeft('bookmarks') });
      case 'bmAdd': return addBookmark(me, msg.start, msg.end);
      case 'bmEdit': return editBookmark(me, msg.id);
      case 'bmRemove': bookmarks.remove(bmKey(me.doc), msg.id); await saveBookmarks(); broadcastBookmarks(me.doc); return;
      case 'bmExport': return exportBookmarks(me);
      case 'checksums': return runChecksums(me);
    }
  }

  // ---------- find in files ----------

  async function openAt(uri, offset, length) {
    const key = uri.toString();
    shared.pendingGoto.set(key, { offset, length });
    const open = shared.docs.get(key);
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
    if (open && open.panels.size) { shared.pendingGoto.delete(key); open.post({ type: 'goto', offset, length }); }
  }

  async function findInFiles(folderUri) {
    if (!(await pro.allowed('findInFiles'))) return;
    const modes = [
      { label: 'Hex bytes', description: '4A 5B ?? 00 (?? matches any byte)', mode: 'hex' },
      { label: 'Text', description: 'UTF-8', mode: 'text' },
      { label: 'Text, ignore case', description: 'ASCII letters', mode: 'text', ic: true },
      { label: 'UTF-16 text', description: 'little-endian, as in Windows files', mode: 'utf16' },
    ];
    const m = await vscode.window.showQuickPick(modes, { title: 'Hex Viewer Pro: find in files (1/3) what to look for' });
    if (!m) return;
    const query = await vscode.window.showInputBox({
      title: `Find in files (2/3): ${m.label.toLowerCase()}`, ignoreFocusOut: true, value: context.globalState.get('hexViewer.fifQuery', ''),
      validateInput: v => { if (!v) return null; const p = parsePattern(v, m.mode, !!m.ic); return p.ok ? null : p.error; },
    });
    if (!query) return;
    const pattern = parsePattern(query, m.mode, !!m.ic);
    if (!pattern.ok) return;
    context.globalState.update('hexViewer.fifQuery', query);
    let base = folderUri && folderUri.scheme === 'file' ? folderUri : null;
    if (!base && !(vscode.workspace.workspaceFolders || []).length) {
      const p = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Search this folder', title: 'Find in files: pick a folder' });
      if (!p || !p.length) return;
      base = p[0];
    }
    const include = await vscode.window.showInputBox({
      title: 'Find in files (3/3): which files', ignoreFocusOut: true, value: context.globalState.get('hexViewer.fifInclude', '**/*'),
      prompt: `A glob pattern${base ? ` inside ${path.basename(base.fsPath)}` : ' in the workspace'}, for example **/*.bin or firmware/**. Folders node_modules and .git are skipped.`,
    });
    if (include === undefined) return;
    context.globalState.update('hexViewer.fifInclude', include || '**/*');
    const glob = base ? new vscode.RelativePattern(base, include || '**/*') : (include || '**/*');
    const uris = (await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**}', 20000)).filter(u => u.scheme === 'file');
    if (!uris.length) { vscode.window.showInformationMessage('No files match that pattern.'); return; }
    if (!pro.licensed) await pro.useTrial('findInFiles');
    const results = [];
    const t0 = Date.now();
    const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Hex Viewer: finding "${query.slice(0, 40)}"`, cancellable: true }, async (progress, token) => {
      let lastPct = 0;
      return searchFiles(uris.map(u => ({ path: u.fsPath, uri: u })), pattern, {
        shouldStop: () => token.isCancellationRequested,
        onFile: (done, total) => { const pct = Math.floor((100 * done) / total); if (pct > lastPct) { progress.report({ increment: pct - lastPct, message: `${done} of ${total} files, ${results.length} matches` }); lastPct = pct; } },
        onMatch: r => { results.push(r); },
      });
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const summary = `${fmtInt(res.matches)} match${res.matches === 1 ? '' : 'es'} in ${fmtInt(new Set(results.map(r => r.file)).size)} of ${fmtInt(res.searched)} files, ${secs} s${res.truncated ? ' (stopped at 10,000 matches)' : ''}${res.cancelled ? ' (stopped)' : ''}${res.skipped.length ? `, ${res.skipped.length} file${res.skipped.length === 1 ? '' : 's'} skipped` : ''}`;
    if (!results.length) { vscode.window.showInformationMessage(`Hex Viewer: no match. ${summary}.`); return; }
    const rootOf = f => { const w = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f)); return w ? path.relative(w.uri.fsPath, path.dirname(f)) : path.dirname(f); };
    const items = results.map(r => {
      const pre = r.offset - r.context.start;
      const hx = Array.from(r.context.bytes, (b, i) => (i === pre ? '[' : '') + hex2(b) + (i === pre + r.length - 1 ? ']' : '')).join(' ');
      return { label: `$(file-binary) ${path.basename(r.file)}  0x${hexOffset(r.offset, 1)}`, description: rootOf(r.file) || '.', detail: hx, r };
    });
    const qp = vscode.window.createQuickPick();
    qp.title = `Find in files: ${summary}`;
    qp.items = items; qp.matchOnDescription = true; qp.matchOnDetail = true; qp.ignoreFocusOut = true;
    qp.placeholder = 'Pick a match to open the file at that offset. Type to filter by file name or folder.';
    qp.onDidAccept(() => { const it = qp.selectedItems[0]; if (it) openAt(vscode.Uri.file(it.r.file), it.r.offset, it.r.length); });
    qp.onDidHide(() => qp.dispose());
    qp.show();
    return { res, results };
  }

  // ---------- compare report ----------

  async function exportReport(a, b, ua, ub) {
    if (!(await pro.allowed('report'))) return;
    const na = path.posix.basename(ua.path), nb = path.posix.basename(ub.path);
    const dir = ua.scheme === 'file' ? path.dirname(ua.fsPath) : undefined;
    const base = `${na.replace(/\.[^.]*$/, '')}-vs-${nb.replace(/\.[^.]*$/, '')}.diff.txt`;
    const dest = await vscode.window.showSaveDialog({
      title: 'Hex Viewer Pro: save the compare report', saveLabel: 'Save report',
      defaultUri: dir ? vscode.Uri.file(path.join(dir, base)) : undefined,
      filters: { 'Text report': ['txt'], 'CSV (spreadsheet)': ['csv'], 'JSON': ['json'] },
    });
    if (!dest) return;
    if (!pro.licensed) await pro.useTrial('report');
    const ext = path.extname(dest.path).toLowerCase();
    const format = ext === '.csv' ? 'csv' : ext === '.json' ? 'json' : 'txt';
    const info = { nameA: na, nameB: nb, pathA: ua.scheme === 'file' ? ua.fsPath : ua.toString(), pathB: ub.scheme === 'file' ? ub.fsPath : ub.toString() };
    let stream = null, mem = [], memSize = 0, buf = '';
    const local = dest.scheme === 'file';
    const tmp = local ? `${dest.fsPath}.hexviewer-${process.pid}.tmp` : null;
    if (local) stream = fs.createWriteStream(tmp);
    const flush = async () => {
      if (!buf) return;
      const s = buf; buf = '';
      if (local) { if (!stream.write(s)) await new Promise((r, j) => { stream.once('drain', r); stream.once('error', j); }); }
      else { mem.push(s); memSize += s.length; if (memSize > 256 << 20) throw new Error('The report is larger than 256 MB; save it to a local folder instead.'); }
    };
    const write = async s => { buf += s; if (buf.length > 1 << 16) await flush(); };
    let res;
    try {
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Hex Viewer: writing the compare report`, cancellable: true }, async (progress, token) => {
        let lastPct = 0;
        return writeReport(a, b, info, format, write, {
          shouldStop: () => token.isCancellationRequested,
          progress: (done, total) => { const pct = Math.floor((100 * done) / Math.max(1, total)); if (pct > lastPct) { progress.report({ increment: pct - lastPct, message: `${pct}%` }); lastPct = pct; } },
        });
      });
      await flush();
      if (local) {
        await new Promise((r, j) => stream.end(e => (e ? j(e) : r())));
        if (res.cancelled) { fs.rmSync(tmp, { force: true }); vscode.window.showInformationMessage('The report was stopped; no file was written.'); return res; }
        fs.renameSync(tmp, dest.fsPath);
      } else {
        if (res.cancelled) return res;
        await vscode.workspace.fs.writeFile(dest, Buffer.from(mem.join(''), 'utf8'));
      }
    } catch (e) {
      if (stream) { stream.destroy(); try { fs.rmSync(tmp, { force: true }); } catch {} }
      vscode.window.showErrorMessage(`Hex Viewer could not write the report: ${e.message || e}`);
      return null;
    }
    const msg = res.ranges ? `Report saved: ${fmtInt(res.bytes)} differing bytes in ${fmtInt(res.ranges)} ranges${res.truncated ? ' (first 1,000,000 ranges)' : ''}.` : 'Report saved: the files are identical.';
    vscode.window.showInformationMessage(msg, 'Open Report').then(p => { if (p) vscode.window.showTextDocument(dest, { preview: false }); });
    return res;
  }

  // ---------- checksums ----------

  async function runChecksums(me) {
    if (!(await pro.allowed('checksums'))) return;
    const c = me.cursor || { selStart: 0, selEnd: 0 };
    const sel = c.selEnd - c.selStart > 1;
    const start = sel ? c.selStart : 0, end = sel ? Math.min(c.selEnd, me.doc.hex.size) : me.doc.hex.size;
    if (!pro.licensed) await pro.useTrial('checksums');
    const what = sel ? `bytes 0x${hexOffset(start, 1)} to 0x${hexOffset(Math.max(start, end - 1), 1)} (${fmtInt(end - start)} bytes)` : `the whole file (${fmtInt(end)} bytes)`;
    const run = (shouldStop, progress) => checksums(me.doc.hex, start, end, shouldStop, progress);
    const r = end - start > (16 << 20)
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Hex Viewer: checksums', cancellable: true }, async (p, token) => {
        let lastPct = 0;
        return run(() => token.isCancellationRequested, (done, total) => { const pct = Math.floor((100 * done) / total); if (pct > lastPct) { p.report({ increment: pct - lastPct, message: `${pct}%` }); lastPct = pct; } });
      })
      : await run(() => false, () => {});
    if (r.cancelled) return r;
    const pick = await vscode.window.showQuickPick(r.results.map(([label, v]) => ({ label, description: v, v })), { title: `Checksums of ${what}. Pick one to copy it.`, matchOnDescription: true });
    if (pick) { await vscode.env.clipboard.writeText(pick.v); vscode.window.setStatusBarMessage(`${pick.label} copied`, 4000); }
    return r;
  }

  // ---------- commands ----------

  const active = () => shared.active;
  const postActive = m => { const a = active(); if (a) a.panel.webview.postMessage(m); };
  context.subscriptions.push(
    vscode.commands.registerCommand('hexViewer.findInFiles', uri => findInFiles(uri)),
    vscode.commands.registerCommand('hexViewer.showStructure', () => { const a = active(); if (!a) { vscode.window.showInformationMessage('Open a file in Hex Viewer first.'); return; } postActive({ type: 'showPanel', panel: 'struct' }); }),
    vscode.commands.registerCommand('hexViewer.chooseTemplate', () => { const a = active(); if (!a) { vscode.window.showInformationMessage('Open a file in Hex Viewer first.'); return; } postActive({ type: 'showPanel', panel: 'struct' }); return pickTemplate(a, m => a.panel.webview.postMessage(m)); }),
    vscode.commands.registerCommand('hexViewer.addBookmark', () => { const a = active(); if (!a) { vscode.window.showInformationMessage('Open a file in Hex Viewer first.'); return; } const c = a.cursor || { selStart: 0, selEnd: 1 }; return addBookmark(a, c.selStart, Math.max(c.selEnd, c.selStart + 1)); }),
    vscode.commands.registerCommand('hexViewer.checksums', () => { const a = active(); if (!a) { vscode.window.showInformationMessage('Open a file in Hex Viewer first.'); return; } return runChecksums(a); }),
    vscode.commands.registerCommand('hexViewer.nextBookmark', () => postActive({ type: 'bmJump', backward: false })),
    vscode.commands.registerCommand('hexViewer.previousBookmark', () => postActive({ type: 'bmJump', backward: true })),
    pro.onDidChange(() => { for (const d of shared.docs.values()) { d.post({ type: 'pro', licensed: pro.licensed, onSale: pro.onSale, trials: pro.trials() }); } }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('hexViewer.templateFolders')) loadUserTemplates(true); }),
  );

  return { handle, TYPES, findInFiles, exportReport, runChecksums, openAt, bookmarks, allTemplates, loadUserTemplates, parseFor, addBookmark };
}

module.exports = { createProHost };
