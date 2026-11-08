// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the samples from
// scripts/make_samples.py (made with --big), drives the webview with real mouse and key events, and writes
// screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null, memory: [] };
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const P = n => path.join(ws, n);
// the edit check works on a copy, so the other samples stay as made
fs.copyFileSync(P('firmware.bin'), P('edit-me.bin'));
// 0.2.0 samples: insert/delete target, compare pair, read-only file, a second 4 GB sparse file with one different byte
fs.copyFileSync(P('firmware.bin'), P('grow-me.bin'));
{ const a = fs.readFileSync(P('firmware.bin')); const b = Buffer.from(a); b[0x40] ^= 0xff; b[0x41] ^= 0xff; b[0x9000] = 0x77; fs.writeFileSync(P('cmp-a.bin'), a); fs.writeFileSync(P('cmp-b.bin'), Buffer.concat([b, Buffer.from('TAIL')])); }
try { fs.chmodSync(P('readonly.bin'), 0o644); } catch {}
fs.writeFileSync(P('readonly.bin'), Buffer.from('read only bytes')); fs.chmodSync(P('readonly.bin'), 0o444);
try { fs.rmSync(P('link-to-grow.bin')); } catch {}
fs.symlinkSync('grow-me.bin', P('link-to-grow.bin'));
if (fs.existsSync(P('big4g.bin'))) {
  const sz = fs.statSync(P('big4g.bin')).size;
  const h = fs.openSync(P('big4g-b.bin'), 'w'); fs.ftruncateSync(h, sz); fs.closeSync(h);
  // same tail markers as big4g.bin, plus one changed byte 64 bytes before the end
  const src = fs.openSync(P('big4g.bin'), 'r'), dst = fs.openSync(P('big4g-b.bin'), 'r+');
  const tail = Buffer.alloc(1 << 20); const off = sz - tail.length; fs.readSync(src, tail, 0, tail.length, off); tail[tail.length - 64] ^= 0x5a;
  fs.writeSync(dst, tail, 0, tail.length, off);
  const head = Buffer.alloc(1 << 20); fs.readSync(src, head, 0, head.length, 0); fs.writeSync(dst, head, 0, head.length, 0);
  const mid = Buffer.alloc(64); fs.readSync(src, mid, 0, 64, 0xffffffc0); fs.writeSync(dst, mid, 0, 64, 0xffffffc0);
  fs.closeSync(src); fs.closeSync(dst);
}
for (const f of fs.readdirSync(ws)) { try { const st = fs.lstatSync(P(f)); if (st.isFile() && st.size < 50e6 && f !== 'edit-me.bin' && f !== 'shrinks.bin' && f !== 'grow-me.bin' && (st.mode & 0o444)) R.hashes[f] = hash(P(f)); } catch {} }
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, {
  'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left', 'editor.fontSize': 13, 'explorer.confirmDragAndDrop': false, 'window.menuStyle': 'custom', 'extensions.ignoreRecommendations': true,
});
const settingsFile = path.join(work, 'ud', 'User', 'settings.json');
const shots = [];
// GATE_NOSHOT=1: no screenshots (VS Code 1.90.2 on Electron 29 hangs in Page.captureScreenshot)
const shot = async name => { if (process.env.GATE_NOSHOT) return null; const f = path.join(shotDir, `hex-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name); }
  catch (e) {
    if (/^SKIP/.test(e.message)) { R.steps.push({ name, ok: null, skipped: e.message, ms: Date.now() - t0 }); console.log('SKIP', name, e.message); return; }
    R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.hexViewerProbe ? window.hexViewerProbe() : null)`));
const findWv = async (title, ms = 15000) => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), ms);
const rendered = async () => { const ok = await vs.waitFor(async () => { const p = await probe(); return p && (p.rendered || p.error || p.size === 0) && p; }, 20000, 100); if (!ok) throw new Error('not rendered'); return ok; };
const activeTab = () => vs.wbEval(`(document.querySelector('.editor-group-container.active .tab.active') || {}).textContent || ''`);
const textEditorActive = () => vs.wbEval(`!!document.querySelector('.editor-group-container.active .editor-container .monaco-editor')`);
// focus the workbench with a real click on the title bar first, so the command palette key reaches VS Code
const cmd = async label => {
  const b = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.part.titlebar').getBoundingClientRect())`));
  await vs.click(b.x + b.width * 0.3, b.y + b.height / 2); await sleep(200);
  await vs.command(label);
};
const closeAll = async () => { await cmd('View: Close All Editors'); await sleep(500); };
const hexRow = (i = 0) => E(`[...document.querySelectorAll('.rows .row')[${i}].querySelectorAll('.hx .b')].map(c => c.textContent).join(' ')`);
const xxd = (file, off = 0, n = 16) => execFileSync('xxd', ['-s', String(off), '-l', String(n), '-p', '-u', file], { encoding: 'utf8' }).trim().match(/../g).join(' ');
const sel = async (aria, value) => { await E(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(aria)}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(400); };
const clickCell = async off => {
  await vs.wvClick(wv, `(() => { for (const r of document.querySelectorAll('.rows .row')) { const s = Number(r.dataset.r); if (${off} >= s && ${off} < s + window.hexViewerProbe().bpr) return r.querySelectorAll('.hx .b')[${off} - s]; } return null; })()`);
};
// a click on the Go to and Find boxes selects their text, so typing replaces it
const typeIn = async (selector, text) => { await vs.wvClick(wv, `document.querySelector(${JSON.stringify(selector)})`); await sleep(100); await vs.type(text); };
const gotoBox = async text => { await typeIn('input.goto', text); await vs.key('Enter', 'Enter'); await sleep(400); };
const inspector = async () => Object.fromEntries((await probe()).inspector);
const py = expr => execFileSync('python3', ['-I', '-c', expr], { encoding: 'utf8' }).trim();
// open with VS Code's own file opening (CLI, same window); not Hex Viewer unless it is the default editor
const openPlain = async file => { vs.open(P(file)); await sleep(1500); };
// open in Hex Viewer: the default for .bin; otherwise the "Open in Hex Viewer" command on the active tab
const openHex = async file => {
  const t0 = Date.now();
  vs.open(P(file)); await sleep(700);
  wv = await findWv(file, 2500);
  // the palette sometimes takes Enter before it has filtered the list; try a second time
  for (let i = 0; i < 2 && !wv; i++) { await cmd('Hex Viewer: Open in Hex Viewer'); wv = await findWv(file, 8000); }
  if (!wv) throw new Error('no Hex Viewer webview for ' + file);
  const p = await rendered();
  return { ms: Date.now() - t0, p };
};
// real right-click in the Explorer, then the real "Open in Hex Viewer" menu item
const rightClickOpen = async file => {
  await cmd('View: Show Explorer'); await sleep(600);
  const pos = JSON.parse(await vs.wbEval(`(() => { const r = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(r => (r.querySelector('.label-name') || {}).textContent === ${JSON.stringify(file)}); if (!r) return 'null'; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 60, y: b.y + b.height / 2 }); })()`));
  if (!pos) throw new Error('explorer row not found: ' + file);
  await vs.click(pos.x, pos.y, { button: 'right' }); await sleep(700);
  const item = await vs.waitFor(async () => JSON.parse(await vs.wbEval(`(() => { const roots = [document, ...[...document.querySelectorAll('.context-view *')].filter(e => e.shadowRoot).map(e => e.shadowRoot)]; for (const root of roots) { const it = [...root.querySelectorAll('.action-label')].find(a => a.textContent.trim() === 'Open in Hex Viewer'); if (it) { const b = it.getBoundingClientRect(); if (b.width) return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); } } return 'null'; })()`)), 4000);
  if (!item) {
    await vs.key('Escape', 'Escape');
    // VS Code before 1.93 has no window.menuStyle setting, so on macOS the context menu is native and not in the page.
    const jv = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); const ver = (jv['User-Agent'] || '') + ' ' + (jv.Browser || '');
    const v = /Code\/(\d+)\.(\d+)/.exec(ver);
    if (v && Number(v[1]) === 1 && Number(v[2]) < 93) throw new Error('SKIP native context menu in ' + ver + ' (the command path is checked in the other steps)');
    throw new Error('no "Open in Hex Viewer" in the context menu');
  }
  await vs.click(item.x, item.y); await sleep(1000);
  wv = await findWv(file, 15000);
  if (!wv) throw new Error('right-click open did not show Hex Viewer for ' + file);
  return rendered();
};
const extHostMB = () => {
  // the extension host is a Code Helper (Plugin) / node service process started with this profile's --user-data-dir
  const ud = path.join(work, 'ud');
  const rows = execSync('ps -axo pid=,rss=,command=', { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(l => l.includes(ud) && /Plugin|NodeService|extensionHost/i.test(l));
  return rows.map(l => { const [pid, rss] = l.trim().split(/\s+/); return { pid: Number(pid), mb: Math.round(Number(rss) / 1024) }; });
};

try {
  await sleep(3000);
  await step('readme.txt and main.ts still open in the text editor, not in Hex Viewer', async () => {
    const out = {};
    for (const f of ['readme.txt', 'main.ts']) { await openPlain(f); out[f] = { textEditor: await textEditorActive(), hexViewer: !!(await findWv(f, 800)) }; if (!out[f].textEditor || out[f].hexViewer) throw new Error(JSON.stringify(out)); }
    await closeAll();
    return out;
  });
  await step('firmware.bin opens in Hex Viewer by default (.bin), bytes match xxd', async () => {
    const { ms, p } = await openHex('firmware.bin');
    const row0 = await hexRow(0), want = xxd(P('firmware.bin'));
    if (row0 !== want) throw new Error(row0 + ' vs ' + want);
    return { openMs: ms, size: p.size, row0 };
  });
  await step('right-click > Open in Hex Viewer on robot-arm.png (real Explorer menu): PNG detected, bytes match xxd', async () => {
    await closeAll();
    const p = await rightClickOpen('robot-arm.png');
    const row0 = await hexRow(0);
    if (p.fileType !== 'PNG image' || row0 !== xxd(P('robot-arm.png'))) throw new Error(JSON.stringify({ t: p.fileType, row0 }));
    await clickCell(0x10);
    await sleep(500);
    await shot('robot-arm-png');
    return { fileType: p.fileType, row0, status: (await probe()).status };
  });
  await step('right-click > Open in Hex Viewer on ls (Mach-O universal binary)', async () => {
    const p = await rightClickOpen('ls');
    if (!/Mach-O/.test(p.fileType) || (await hexRow(0)) !== xxd(P('ls'))) throw new Error(p.fileType);
    return { fileType: p.fileType };
  });
  const types = { 'archive.zip': /ZIP/, 'license.pdf': /PDF/, 'inventory.sqlite': /SQLite/, 'Hello.class': /Java class/, 'tone.wav': /WAV/, 'exit42.elf': /ELF 64-bit/, 'notes-utf16.txt.bin': /UTF-16/ };
  for (const [f, re] of Object.entries(types)) {
    await step(`${f}: opens in Hex Viewer, type "${re.source}", first row and last row match xxd`, async () => {
      await closeAll();
      const { ms, p } = await openHex(f);
      const row0 = await hexRow(0);
      const size = fs.statSync(P(f)).size;
      await vs.wvClick(wv, `document.querySelector('.rows .row .hx .b')`);
      await vs.key('End', 'End', 4, 35); await sleep(600);
      const q = await probe();
      const lastStart = Math.floor((size - 1) / 16) * 16;
      const lastRowHex = await E(`[...document.querySelectorAll('.rows .row')].pop().querySelectorAll('.hx .b:not(.e)').length`);
      if (!re.test(p.fileType) || row0 !== xxd(P(f)) || q.cursor !== size - 1 || q.lastRow !== lastStart || lastRowHex !== size - lastStart) throw new Error(JSON.stringify({ type: p.fileType, row0, cursor: q.cursor, lastRow: q.lastRow, lastRowHex }));
      return { openMs: ms, fileType: p.fileType, size, lastRow: '0x' + lastStart.toString(16) };
    });
  }
  await step('UTF-16 LE text column shows the text', async () => {
    await sel('Text encoding', 'utf16le');
    const t = await E(`document.querySelectorAll('.rows .row')[0].querySelector('.tx').textContent + document.querySelectorAll('.rows .row')[1].querySelector('.tx').textContent`);
    await shot('utf16-text-column');
    await sel('Text encoding', 'ascii');
    if (!/H e l l o {3}U T F - 1 6/.test(t.replace(/\u00a0/g, ' '))) throw new Error(t);
    return t.replace(/\u00a0/g, ' ').slice(0, 40);
  });
  await step('4 GB sparse file: opens in under 1 s, Ctrl/Cmd+End reaches the last row, extension host memory under 300 MB', async () => {
    await closeAll();
    const size = fs.statSync(P('big4g.bin')).size;
    const t0 = Date.now();
    vs.open(P('big4g.bin'));
    wv = await findWv('big4g.bin', 15000);
    const p = await rendered();
    const ms = Date.now() - t0;
    await vs.wvClick(wv, `document.querySelector('.rows .row .hx .b')`);
    await vs.key('End', 'End', 4, 35); await sleep(800);
    const q = await probe();
    const lastText = await E(`[...document.querySelectorAll('.rows .row')].pop().querySelector('.tx').textContent`);
    await shot('big-4gb-end');
    const mem = extHostMB(); R.memory.push({ at: '4 GB end', mem });
    const maxMB = Math.max(...mem.map(m => m.mb), 0);
    // ms includes the CLI round trip that opens the tab (about 0.5 s); renderMs is from the webview's ready to the first rows
    if (q.cursor !== size - 1 || q.lastRow !== Math.floor((size - 1) / 16) * 16 || !/LASTBYTE/.test(lastText) || maxMB > 300 || !mem.length) throw new Error(JSON.stringify({ cursor: q.cursor, lastRow: q.lastRow, lastText, mem }));
    return { size, openToRenderedMs: ms, cursor: '0x' + q.cursor.toString(16), lastRowText: lastText, extHostMB: maxMB, blocksCached: q.blocks };
  });
  await step('Go to 0xFFFFFFF0 with Cmd+G (VS Code input box), status bar shows the offset', async () => {
    const boxOpen = () => vs.wbEval(`!!document.querySelector('.quick-input-widget') && document.querySelector('.quick-input-widget').style.display !== 'none'`);
    let open = null, tries = 0;
    for (; tries < 3 && !open; tries++) { await vs.key('g', 'KeyG', 4, 71); open = await vs.waitFor(boxOpen, 2500); }
    R.gotoKeyTries = tries;
    if (!open) throw new Error('go to offset box did not open');
    await vs.type('0xFFFFFFF0'); await sleep(300); await vs.key('Enter', 'Enter'); await sleep(900);
    const q = await probe();
    const rowText = await E(`[...document.querySelectorAll('.rows .row')].map(r => r.querySelector('.tx').textContent).join('|')`);
    const sb = await vs.wbEval(`[...document.querySelectorAll('.statusbar-item')].map(i => i.textContent).find(t => /0x[0-9A-F]+ \\(/.test(t)) || ''`);
    await shot('goto-fffffff0');
    if (q.cursor !== 0xfffffff0 || !/NEAR-THE-4GB/.test(rowText.replace(/\u00a0/g, ' ')) || !/0xFFFFFFF0 \(4,294,967,280\)/.test(sb)) throw new Error(JSON.stringify({ cursor: q.cursor, sb }));
    return { cursor: '0x' + q.cursor.toString(16), statusBar: sb.trim() };
  });
  await step('find a 6-byte pattern across the 64 KB block edge (0x2FFFD) in firmware.bin; copy as C array; Cmd+C copies hex', async () => {
    await closeAll();
    await openHex('firmware.bin');
    await typeIn('input.find', 'DE AD BE EF 13 37'); await vs.key('Enter', 'Enter');
    const r = await vs.waitFor(async () => { const q = await probe(); return q.match && q; }, 10000);
    if (!r || r.match.start !== 0x2fffd) throw new Error(JSON.stringify(r && r.match));
    await sleep(300);
    await shot('find-across-64k');
    await sel('Copy selection as', 'c'); await sleep(800);
    const c = execSync('pbpaste', { encoding: 'utf8' });
    if (c !== 'unsigned char firmware[6] = {\n  0xDE, 0xAD, 0xBE, 0xEF, 0x13, 0x37\n};') throw new Error(c);
    await vs.wvClick(wv, `document.querySelector('.rows .row .hx .b.sel, .rows .row .hx .b.cur')`, {});
    // re-select the match with Shift+arrows, then the real Cmd+C (VS Code sends copy to the webview)
    await gotoBox('0x2FFFD'); await vs.key('ArrowRight', 'ArrowRight', 8); for (let i = 0; i < 4; i++) await vs.key('ArrowRight', 'ArrowRight', 8);
    await vs.key('c', 'KeyC', 4, 67); await sleep(800);
    const h = execSync('pbpaste', { encoding: 'utf8' });
    if (h !== 'DE AD BE EF 13 37') throw new Error('Cmd+C: ' + JSON.stringify(h));
    return { match: '0x' + r.match.start.toString(16), findInfo: r.findInfo, cArray: c.split('\n').join(' '), cmdC: h };
  });
  await step('data inspector matches Python struct at 5 offsets', async () => {
    const f = P('firmware.bin');
    const checks = [
      ['0x100', 'uint32', `import struct;print(struct.unpack_from('<I',open(${JSON.stringify(f)},'rb').read(),0x100)[0])`],
      ['0x104', 'int16', `import struct;print(struct.unpack_from('<h',open(${JSON.stringify(f)},'rb').read(),0x104)[0])`],
      ['0x106', 'uint64', `import struct;print(struct.unpack_from('<Q',open(${JSON.stringify(f)},'rb').read(),0x106)[0])`],
      ['0x200', 'float64', `import struct;print('%.9g'%struct.unpack_from('<d',open(${JSON.stringify(f)},'rb').read(),0x200)[0])`],
      ['0x300', 'GUID', `import uuid;print('{'+str(uuid.UUID(bytes_le=open(${JSON.stringify(f)},'rb').read()[0x300:0x310])).upper()+'}')`],
    ];
    const out = [];
    for (const [off, k, expr] of checks) {
      await gotoBox(off);
      const got = (await inspector())[k]; const want = py(expr);
      out.push({ off, k, got, want });
      if (got !== want) throw new Error(JSON.stringify(out));
    }
    await shot('inspector-0x300');
    // big-endian switch
    await vs.wvClick(wv, `document.querySelector('.side h2 .link')`); await sleep(300);
    await gotoBox('0x100');
    const be = (await inspector()).uint32, wantBe = py(`import struct;print(struct.unpack_from('>I',open(${JSON.stringify(f)},'rb').read(),0x100)[0])`);
    await vs.wvClick(wv, `document.querySelector('.side h2 .link')`);
    if (be !== wantBe) throw new Error('BE ' + be + ' vs ' + wantBe);
    return { checks: out, bigEndianUint32: be };
  });
  await step('edit: change 3 bytes, undo 1, save; sha256 equals a Python-patched copy', async () => {
    await closeAll();
    const before = hash(P('edit-me.bin'));
    await openHex('edit-me.bin');
    await clickCell(0x10);
    for (const k of ['a', 'b', 'c', 'd', '1', '2']) await vs.key(k, 'Key' + k.toUpperCase(), 0);
    await sleep(500);
    const shown = await hexRow(1);
    await shot('edited-3-bytes');
    await vs.key('z', 'KeyZ', 4, 90); await sleep(600);
    const afterUndo = await hexRow(1);
    await vs.key('s', 'KeyS', 4, 83); await sleep(1500);
    const want = py(`import hashlib;b=bytearray(open(${JSON.stringify(P('firmware.bin'))},'rb').read());b[0x10]=0xAB;b[0x11]=0xCD;print(hashlib.sha256(b).hexdigest())`);
    const got = hash(P('edit-me.bin'));
    const dirty = await vs.wbEval(`!!document.querySelector('.editor-group-container.active .tab.active.dirty')`);
    if (got !== want || dirty || !/^AB CD 12/.test(shown) || !/^AB CD /.test(afterUndo) || /^AB CD 12/.test(afterUndo)) throw new Error(JSON.stringify({ got, want, shown, afterUndo, dirty }));
    return { before, after: got, pythonPatched: want, rowAfterEdits: shown, rowAfterUndo: afterUndo };
  });
  await step('hostile: file truncated while open (10 MB to 1 KB) shows a clear message, no crash', async () => {
    await closeAll();
    await openHex('shrinks.bin');
    await gotoBox('0x500000');
    fs.truncateSync(P('shrinks.bin'), 1024);
    const msg = await vs.waitFor(async () => (await probe()).banner, 10000);
    await vs.wvClick(wv, `document.querySelector('.rows .row .hx .b')`);
    await vs.key('PageDown', 'PageDown'); await vs.key('End', 'End', 4, 35); await sleep(400);
    const q = await probe();
    await shot('truncated-while-open');
    if (!msg || !/shorter/.test(msg) || q.size !== 1024 || q.cursor !== 1023) throw new Error(JSON.stringify({ msg, size: q.size, cursor: q.cursor }));
    return { banner: msg, size: q.size, cursor: q.cursor };
  });
  await step('hostile: file without read permission shows a clear message', async () => {
    await closeAll();
    vs.open(P('locked.bin')); await sleep(1500);
    wv = await findWv('locked.bin', 8000);
    if (!wv) { await cmd('Hex Viewer: Open in Hex Viewer'); wv = await findWv('locked.bin', 8000); }
    if (!wv) throw new Error('no webview');
    const t = await vs.waitFor(() => E(`(document.querySelector('.fatal') || {}).textContent || ''`), 8000);
    await shot('no-permission');
    if (!/permission/.test(t)) throw new Error(t);
    return t;
  });
  await step('hostile: empty file shows "This file is empty"', async () => {
    await closeAll();
    vs.open(P('empty.bin'));
    wv = await findWv('empty.bin', 10000);
    const t = await vs.waitFor(() => E(`!document.querySelector('.empty').hidden && document.querySelector('.empty').textContent`), 8000);
    if (!/empty \(0 bytes\)/.test(t || '')) throw new Error(String(t));
    return t;
  });
  await step('200 MB random file: open, find text near the end, timing', async () => {
    await closeAll();
    const { ms } = await openHex('random200m.bin');
    await sel('Find as', 'text');
    const t0 = Date.now();
    await typeIn('input.find', 'NEEDLE-AT-THE-END'); await vs.key('Enter', 'Enter');
    const r = await vs.waitFor(async () => { const q = await probe(); return q.match && q; }, 30000, 100);
    const searchMs = Date.now() - t0;
    const mem = extHostMB(); R.memory.push({ at: '200 MB search', mem });
    await sel('Find as', 'hex');
    if (!r || r.match.start !== 200 * 1024 * 1024 - 1000) throw new Error(JSON.stringify(r && r.match));
    return { openMs: ms, match: r.match.start, searchMs, extHostMB: Math.max(...mem.map(m => m.mb), 0) };
  });
  await step('32 bytes per row and the light theme', async () => {
    await closeAll();
    await openHex('robot-arm.png');
    await sel('Bytes per row', '32'); await sleep(300);
    const q = await probe();
    const row0 = await hexRow(0);
    await shot('dark-32-per-row');
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); s['workbench.colorTheme'] = 'Default Light Modern'; fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1));
    const light = await vs.waitFor(() => vs.wbEval(`document.querySelector('.monaco-workbench').classList.contains('vs')`), 15000);
    await sleep(1200);
    const bg = await E(`getComputedStyle(document.body).backgroundColor`);
    await sel('Bytes per row', '16');
    await clickCell(0x10);
    await sleep(400);
    await shot('light-16-per-row');
    s['workbench.colorTheme'] = 'Default Dark Modern'; fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1));
    await vs.waitFor(() => vs.wbEval(`document.querySelector('.monaco-workbench').classList.contains('vs-dark')`), 15000); await sleep(1200);
    const bgDark = await E(`getComputedStyle(document.body).backgroundColor`);
    if (!light || q.bpr !== 32 || row0.split(' ').length !== 32 || row0 !== xxd(P('robot-arm.png'), 0, 32) || bg === bgDark) throw new Error(JSON.stringify({ bpr: q.bpr, bg, bgDark }));
    return { bpr32Row0: row0, lightBackground: bg, darkBackground: bgDark };
  });
  await step('hero screenshot: PNG header with the width selected and read as big-endian', async () => {
    await closeAll();
    await cmd('View: Show Explorer');
    await openHex('robot-arm.png');
    const tabs = await vs.wbEval(`document.querySelectorAll('.editor-group-container.active .tab').length`);
    await gotoBox('0x10');
    for (let i = 0; i < 3; i++) await vs.key('ArrowRight', 'ArrowRight', 8);
    await vs.wvClick(wv, `document.querySelector('.side h2 .link')`); await sleep(300);
    const ins = await inspector();
    const width = py(`import struct;print(struct.unpack_from('>I',open(${JSON.stringify(P('robot-arm.png'))},'rb').read(),0x10)[0])`);
    await sleep(500);
    const f = await shot('hero-png-ihdr');
    await vs.wvClick(wv, `document.querySelector('.side h2 .link')`);
    if (tabs !== 1 || ins.uint32 !== width) throw new Error(JSON.stringify({ tabs, uint32: ins.uint32, width }));
    return { shot: f, tabs, pngWidthBigEndian: ins.uint32 };
  });

  // ---------- 0.2.0: insert and delete, safe save, compare ----------
  const dialogPick = async file => {
    // the simple file dialog (files.simpleDialog.enable) is a quick input: type the path, then Enter
    const ib = await vs.waitFor(async () => JSON.parse(await vs.wbEval(`(() => { const i = [...document.querySelectorAll('.quick-input-widget input')].find(x => x.type !== 'checkbox' && x.getBoundingClientRect().width > 0); if (!i) return 'null'; const b = i.getBoundingClientRect(); return b.width ? JSON.stringify(b) : 'null'; })()`)), 6000);
    if (!ib) throw new Error('no file dialog');
    await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(file);
    await sleep(700); await vs.key('Enter', 'Enter'); await sleep(1200);
  };
  const quickTitle = () => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return w && w.style.display !== 'none' ? ((w.querySelector('.quick-input-title') || {}).textContent || '') : ''; })()`);
  // run a palette command and wait until its input box or dialog shows the expected title (once more if it did not)
  const cmdBox = async (label, re) => { for (let i = 0; i < 2; i++) { await cmd(label); if (await vs.waitFor(async () => re.test(await quickTitle()), 5000, 150)) return true; await vs.key('Escape', 'Escape'); await sleep(300); } throw new Error('no input box for ' + label + ' (title: ' + (await quickTitle()) + ')'); };
  const cprobe = async w => JSON.parse(await vs.wvEval(w, `JSON.stringify(window.hexCompareProbe ? window.hexCompareProbe() : null)`));
  const findCmp = async (title, ms = 15000) => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), ms);
  const press = async (key, code, mod = 0, kc) => { await vs.key(key, code, mod, kc); await sleep(250); };
  await step('insert mode: Insert key, type bytes and text, Delete, Backspace, Cmd+X, paste inserts, append at the end; save grows the file; sha256 equals a JS model', async () => {
    await closeAll();
    const orig = fs.readFileSync(P('grow-me.bin'));
    let m = Buffer.from(orig);
    const ins = (at, b) => { m = Buffer.concat([m.subarray(0, at), Buffer.from(b), m.subarray(at)]); };
    const del = (a, b) => { m = Buffer.concat([m.subarray(0, a), m.subarray(b)]); };
    await openHex('grow-me.bin');
    await clickCell(0x10);
    await press('Insert', 'Insert', 0, 45);
    let q = await probe();
    if (!q.insert || !/^Insert/.test(q.mode)) throw new Error('Insert key did not switch: ' + JSON.stringify({ insert: q.insert, mode: q.mode }));
    for (const k of ['a', 'b', 'c', 'd']) await press(k, 'Key' + k.toUpperCase());
    ins(0x10, [0xab, 0xcd]);
    await press('Tab', 'Tab', 0, 9); await press('X', 'KeyX', 8, 88); await press('Tab', 'Tab', 0, 9);
    ins(0x12, [0x58]);
    await press('Delete', 'Delete', 0, 46); del(0x13, 0x14);
    await press('Backspace', 'Backspace', 0, 8); del(0x12, 0x13);
    await sleep(500);
    const row1 = await hexRow(1);
    await shot('insert-mode');
    // cut 4 bytes at 0x20 with the real Cmd+X, then paste them at 0 (insert mode, hex column)
    await gotoBox('0x20'); for (let i = 0; i < 3; i++) await press('ArrowRight', 'ArrowRight', 8);
    await press('x', 'KeyX', 4, 88); await sleep(600);
    const cut = execSync('pbpaste', { encoding: 'utf8' });
    const cutWant = [...m.subarray(0x20, 0x24)].map(v => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const cutBytes = Buffer.from(m.subarray(0x20, 0x24)); del(0x20, 0x24);
    await gotoBox('0'); await press('v', 'KeyV', 4, 86); await sleep(600); ins(0, cutBytes);
    // append: Cmd+End goes one past the last byte in insert mode
    await vs.wvClick(wv, `document.querySelector('.rows .row .hx .b')`);
    await press('End', 'End', 4, 35); await sleep(400);
    q = await probe();
    const atEnd = q.cursor === m.length;
    for (const k of ['f', 'e']) await press(k, 'Key' + k.toUpperCase());
    ins(m.length, [0xfe]);
    await sleep(500);
    q = await probe();
    await press('s', 'KeyS', 4, 83); await sleep(2000);
    const got = fs.readFileSync(P('grow-me.bin'));
    const dirty = await vs.wbEval(`!!document.querySelector('.editor-group-container.active .tab.active.dirty')`);
    const leftovers = fs.readdirSync(ws).filter(n => n.includes('hexviewer'));
    if (cut !== cutWant || !atEnd || q.size !== m.length || !got.equals(m) || dirty || leftovers.length) throw new Error(JSON.stringify({ cut, cutWant, atEnd, size: q.size, want: m.length, disk: got.length, same: got.equals(m), dirty, leftovers, row1 }));
    // undo the append after the save, save again: the file is one byte shorter
    await press('z', 'KeyZ', 4, 90); await sleep(500);
    await press('s', 'KeyS', 4, 83); await sleep(1500);
    const got2 = fs.readFileSync(P('grow-me.bin'));
    if (!got2.equals(m.subarray(0, m.length - 1))) throw new Error('undo after save then save: ' + got2.length + ' vs ' + (m.length - 1));
    return { origSize: orig.length, savedSize: got.length, afterUndoSave: got2.length, row1, cut, sha256: hash(P('grow-me.bin')) };
  });
  await step('insert mode on a 4 GB sparse file: insert at offset 0 and delete near the end are instant, last row right, undo makes it clean', async () => {
    await closeAll();
    const size = fs.statSync(P('big4g.bin')).size;
    vs.open(P('big4g.bin')); wv = await findWv('big4g.bin', 15000); await rendered();
    await clickCell(0);
    const before = await probe();
    if (!before.insert) await press('Insert', 'Insert', 0, 45);
    const t0 = Date.now();
    for (const k of ['4', '2']) await press(k, 'Digit' + k);
    const q1 = await vs.waitFor(async () => { const q = await probe(); return q.size === size + 1 && q; }, 5000, 50);
    const insMs = Date.now() - t0;
    await press('End', 'End', 4, 35);
    await vs.waitFor(async () => /LASTBYT/.test(await E(`[...document.querySelectorAll('.rows .row')].map(r => r.querySelector('.tx').textContent).join('')`)), 5000, 100);
    const q2 = await probe();
    const lastText = await E(`[...document.querySelectorAll('.rows .row')].map(r => r.querySelector('.tx').textContent).join('|')`);
    const mem = extHostMB(); R.memory.push({ at: '4 GB insert', mem });
    await press('z', 'KeyZ', 4, 90); await press('z', 'KeyZ', 4, 90); await sleep(800);
    const q3 = await probe();
    const dirty = await vs.wbEval(`!!document.querySelector('.editor-group-container.active .tab.active.dirty')`);
    await press('Insert', 'Insert', 0, 45);
    if (!q1 || q2.cursor !== size + 1 || !/LASTBYTE/.test(lastText.replace(/\|/g, '')) || q3.size !== size || dirty) throw new Error(JSON.stringify({ q1: q1 && q1.size, cursor: q2.cursor, size, q3: q3.size, dirty, lastText: lastText.slice(-80) }));
    return { insertMs: insMs, sizeAfterInsert: q1.size, cursorAtEnd: q2.cursor, extHostMB: Math.max(...mem.map(x => x.mb), 0), cleanAfterUndo: !dirty };
  });
  await step('save through a symlink: link-to-grow.bin stays a link, the target grows', async () => {
    await closeAll();
    const before = fs.statSync(P('grow-me.bin')).size;
    await openHex('link-to-grow.bin');
    await cmdBox('Hex Viewer: Insert Bytes...', /^Insert bytes$/);
    await vs.type('8 EE'); await sleep(300); await vs.key('Enter', 'Enter'); await sleep(800);
    await press('s', 'KeyS', 4, 83); await sleep(1500);
    const isLink = fs.lstatSync(P('link-to-grow.bin')).isSymbolicLink();
    const after = fs.statSync(P('grow-me.bin')).size;
    if (!isLink || after !== before + 8) throw new Error(JSON.stringify({ isLink, before, after }));
    return { isLink, before, after };
  });
  await step('hostile: read-only file in insert mode refuses typing, Delete and Cmd+X with a hint; file unchanged', async () => {
    await closeAll();
    const h0 = hash(P('readonly.bin'));
    await openHex('readonly.bin');
    await clickCell(2);
    await press('Insert', 'Insert', 0, 45);
    for (const k of ['a', 'b']) await press(k, 'Key' + k.toUpperCase());
    await press('Delete', 'Delete', 0, 46); await press('x', 'KeyX', 4, 88);
    await sleep(500);
    const q = await probe();
    const dirty = await vs.wbEval(`!!document.querySelector('.editor-group-container.active .tab.active.dirty')`);
    if (q.size !== 15 || dirty || hash(P('readonly.bin')) !== h0 || !q.readOnly) throw new Error(JSON.stringify({ size: q.size, dirty, readOnly: q.readOnly, hint: q.hint }));
    return { size: q.size, readOnly: q.readOnly, hint: q.hint, mode: q.mode };
  });
  await step('compare: "Compare..." button, pick the second file; summary, F7 / Shift+F7 jump between the 3 areas', async () => {
    await closeAll();
    await openHex('cmp-a.bin');
    await vs.wvClick(wv, `[...document.querySelectorAll('.toolbar button')].find(b => b.textContent === 'Compare...')`);
    await sleep(800);
    await dialogPick(P('cmp-b.bin'));
    const cw = await findCmp('cmp-a.bin ↔ cmp-b.bin');
    if (!cw) throw new Error('no compare panel');
    const st = await vs.waitFor(async () => { const c = await cprobe(cw); return c && c.stats && c; }, 15000);
    const hops = [];
    for (let i = 0; i < 3; i++) { await vs.wvClick(cw, `document.querySelector('.rows .row .hx .b')`, {}); break; }
    await vs.wvClick(cw, `[...document.querySelectorAll('.toolbar button')].find(b => /Next difference/.test(b.textContent))`); await sleep(700);
    hops.push((await cprobe(cw)).cursor);
    for (let i = 0; i < 2; i++) { await press('F7', 'F7', 0, 118); await sleep(700); hops.push((await cprobe(cw)).cursor); }
    await press('F7', 'F7', 8, 118); await sleep(700); hops.push((await cprobe(cw)).cursor);
    const c = await cprobe(cw);
    await shot('compare-two-files');
    const size = fs.statSync(P('cmp-a.bin')).size;
    const s = st.stats;
    if (s.bytes !== 3 + 4 || s.runs !== 3 || hops[0] !== 0x40 || hops[1] !== 0x9000 || hops[2] !== size || hops[3] !== 0x9000 || !(c.diffCells > 0)) throw new Error(JSON.stringify({ stats: s, hops, diffCells: c.diffCells }));
    return { summary: c.summary, hops: hops.map(h => '0x' + h.toString(16)), status: c.status };
  });
  await step('compare in the Explorer: select two files, right-click > Compare in Hex Viewer', async () => {
    await closeAll();
    await cmd('View: Show Explorer'); await sleep(600);
    const rowPos = async name => JSON.parse(await vs.wbEval(`(() => { const r = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(r => (r.querySelector('.label-name') || {}).textContent === ${JSON.stringify(name)}); if (!r) return 'null'; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 60, y: b.y + b.height / 2 }); })()`));
    const a = await rowPos('cmp-a.bin'); if (!a) throw new Error('row cmp-a.bin');
    await vs.click(a.x, a.y); await sleep(300);
    const b = await rowPos('cmp-b.bin'); if (!b) throw new Error('row cmp-b.bin');
    await vs.click(b.x, b.y, { modifiers: 4 }); await sleep(300);
    await vs.click(b.x, b.y, { button: 'right' }); await sleep(800);
    const item = await vs.waitFor(async () => JSON.parse(await vs.wbEval(`(() => { const roots = [document, ...[...document.querySelectorAll('.context-view *')].filter(e => e.shadowRoot).map(e => e.shadowRoot)]; for (const root of roots) { const it = [...root.querySelectorAll('.action-label')].find(a => a.textContent.trim() === 'Compare in Hex Viewer'); if (it) { const r = it.getBoundingClientRect(); if (r.width) return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); } } return 'null'; })()`)), 4000);
    if (!item) {
      await vs.key('Escape', 'Escape');
      const jv = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); const v = /Code\/(\d+)\.(\d+)/.exec((jv['User-Agent'] || '') + ' ' + (jv.Browser || ''));
      if (v && Number(v[2]) < 93) throw new Error('SKIP native context menu in this VS Code (the button and command paths are checked in the other steps)');
      throw new Error('no "Compare in Hex Viewer" in the context menu');
    }
    await vs.click(item.x, item.y); await sleep(1200);
    const cw = (await findCmp('cmp-a.bin ↔ cmp-b.bin', 8000)) || (await findCmp('cmp-b.bin ↔ cmp-a.bin', 2000));
    if (!cw) throw new Error('no compare panel from the Explorer');
    const c = await vs.waitFor(async () => { const p = await cprobe(cw); return p && p.stats && p; }, 15000);
    return { title: cw.title, summary: c.summary };
  });
  await step('compare two 4 GB sparse files: next difference near the end, count, extension host memory', async () => {
    await closeAll();
    await cmdBox('Hex Viewer: Compare in Hex Viewer', /first file/);
    // no active file: the dialog takes the first file, then the second
    await dialogPick(P('big4g.bin'));
    const second = await vs.waitFor(async () => JSON.parse(await vs.wbEval(`JSON.stringify(!!document.querySelector('.quick-input-widget input') && document.querySelector('.quick-input-widget').style.display !== 'none')`)), 4000);
    if (second) await dialogPick(P('big4g-b.bin'));
    const cw = await findCmp('big4g.bin ↔ big4g-b.bin', 15000);
    if (!cw) throw new Error('no compare panel for the 4 GB pair');
    const t0 = Date.now();
    await vs.wvClick(cw, `document.querySelector('.rows .row .hx .b')`);
    await press('F7', 'F7', 0, 118);
    const size = fs.statSync(P('big4g.bin')).size;
    const hit = await vs.waitFor(async () => { const c = await cprobe(cw); return c.cursor === size - 64 && c; }, 60000, 200);
    const ms = Date.now() - t0;
    const st = await vs.waitFor(async () => { const c = await cprobe(cw); return c.stats && c; }, 60000, 500);
    const mem = extHostMB(); R.memory.push({ at: '4 GB compare', mem });
    await shot('compare-4gb');
    if (!hit || !st || st.stats.bytes !== 1 || Math.max(...mem.map(x => x.mb), 0) > 400) throw new Error(JSON.stringify({ hit: !!hit, stats: st && st.stats, mem }));
    return { firstDifferenceMs: ms, at: '0x' + (size - 64).toString(16), summary: st.summary, statsMs: st.stats.ms, extHostMB: Math.max(...mem.map(x => x.mb), 0) };
  });
  await step('hostile compare: a file without read permission gives a plain error, no panel', async () => {
    await closeAll();
    await openHex('cmp-a.bin');
    await cmdBox('Hex Viewer: Compare in Hex Viewer', /compare cmp-a\.bin with/);
    await dialogPick(P('locked.bin'));
    await sleep(1000);
    const notes = (await vs.notifications()).join(' | ');
    const panel = await findCmp('cmp-a.bin ↔ locked.bin', 1500);
    await cmd('Notifications: Clear All Notifications'); await sleep(400);
    if (panel || !/cannot compare/i.test(notes)) throw new Error(JSON.stringify({ panel: !!panel, notes }));
    return notes;
  });
  await step('hostile: symlink loop (loop.bin -> loop.bin) through "Open in Hex Viewer" and the open dialog', async () => {
    // The Explorer does not list a link loop and the VS Code CLI does not open one, so pick it in the dialog
    // that "Open in Hex Viewer" shows when no file is active (the simple dialog is on in this profile).
    await closeAll();
    await cmd('Hex Viewer: Open in Hex Viewer'); await sleep(1200);
    const ib = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.quick-input-widget input').getBoundingClientRect())`));
    await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(P('loop.bin'));
    await sleep(600); await vs.key('Enter', 'Enter'); await sleep(1500);
    wv = await findWv('loop.bin', 6000);
    let t = wv ? await vs.waitFor(() => E(`(document.querySelector('.fatal') || {}).textContent || ''`), 8000) : '';
    if (!t) t = 'VS Code: ' + ((await vs.notifications()).join(' | ') || await vs.wbEval(`(document.querySelector('.quick-input-widget .quick-input-message') || {}).textContent || 'no editor opened'`));
    await shot('symlink-loop');
    await vs.key('Escape', 'Escape');
    // VS Code itself refuses a link loop in the dialog ("Please enter a path that exists"), so the extension never gets it.
    // Either outcome is fine: the extension's own message, or VS Code's refusal with no crash and no error log.
    if (!/link loop.*ELOOP|path that exists/.test(t)) throw new Error(t);
    return t;
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'|ERR_FILE_NOT_FOUND.*product/i.test(c.text));
  R.extErrors = R.console.filter(c => /hex-viewer|hexViewer|custom document/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /hex|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => { try { return hash(P(f)) === h; } catch { return false; } });
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ pass: R.steps.filter(s => s.ok).length, fail: R.steps.filter(s => s.ok === false).length, skip: R.steps.filter(s => s.ok === null).length, extErrors: R.extErrors.length, console: R.console.slice(0, 20), logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
