// Hex Viewer Pro check in a real VS Code. Two phases, each in a clean profile:
//   free: the release .vsix, no key. Pro tabs show a PRO badge, nothing pops up on open, a Pro tab explains
//         itself, the 3 free tries work, the 4th asks (Get Pro / Enter Key), Get Pro without a payment link opens nothing.
//   pro:  a gate build that also trusts a throwaway test key (GATE_KEY). Enter the key, then every template on
//         its sample, hostile files, bookmarks, checksums, JSON export, the compare report and find in files.
// usage: GATE_KEY=<key> node scripts/e2e-pro.mjs <work> <port> <phase free|pro> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';

const [work0, port, phase, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { phase, install: null, steps: [], console: [], memory: [] };
const P = n => path.join(ws, n);
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, {
  'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'editor.fontSize': 13, 'window.menuStyle': 'custom', 'extensions.ignoreRecommendations': true, 'files.hotExit': 'off',
});
const shots = [];
const shot = async name => { if (process.env.GATE_NOSHOT) return null; const f = path.join(shotDir, `pro-${phase}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name) && !/License Key/.test(name)) return;
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name); }
  catch (e) {
    if (/^SKIP/.test(e.message)) { R.steps.push({ name, ok: null, skipped: e.message, ms: Date.now() - t0 }); console.log('SKIP', name, e.message); return; }
    R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300));
    try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {}
    try { await vs.key('Escape', 'Escape'); await vs.key('Escape', 'Escape'); } catch {}
  }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.hexViewerProbe ? window.hexViewerProbe() : null)`));
const findWv = async (title, ms = 15000) => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), ms);
const rendered = async () => { const ok = await vs.waitFor(async () => { const p = await probe(); return p && (p.rendered || p.error || p.size === 0) && p; }, 20000, 100); if (!ok) throw new Error('not rendered'); return ok; };
const cmd = async label => {
  const b = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.part.titlebar').getBoundingClientRect())`));
  await vs.click(b.x + b.width * 0.3, b.y + b.height / 2); await sleep(200);
  await vs.command(label);
};
const closeAll = async () => { await cmd('View: Close All Editors'); await sleep(600); };
const openHex = async file => {
  vs.open(P(file)); await sleep(700);
  wv = await findWv(file, 2500);
  for (let i = 0; i < 2 && !wv; i++) { await cmd('Hex Viewer: Open in Hex Viewer'); wv = await findWv(file, 8000); }
  if (!wv) throw new Error('no Hex Viewer webview for ' + file);
  return rendered();
};
const quickTitle = () => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return w && w.style.display !== 'none' ? ((w.querySelector('.quick-input-title') || {}).textContent || '') : ''; })()`);
const quickItems = () => vs.wbEval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.textContent.trim().slice(0, 200))`);
const typeQuick = async text => {
  const ib = await vs.waitFor(async () => JSON.parse(await vs.wbEval(`(() => { const i = [...document.querySelectorAll('.quick-input-widget input')].find(x => x.type !== 'checkbox' && x.getBoundingClientRect().width > 0); if (!i) return 'null'; return JSON.stringify(i.getBoundingClientRect()); })()`)), 6000);
  if (!ib) throw new Error('no input box');
  await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(text); await sleep(500);
};
const enter = async () => { await vs.key('Enter', 'Enter'); await sleep(700); };
const dialog = () => vs.wbEval(`(() => { const d = document.querySelector('.monaco-dialog-box'); if (!d) return null; return { text: (d.querySelector('.dialog-message-text') || {}).textContent || '', detail: (d.querySelector('.dialog-message-detail') || {}).textContent || '', buttons: [...d.querySelectorAll('.dialog-buttons .monaco-button')].map(b => b.textContent.trim()) }; })()`);
const clickDialog = async label => {
  const b = JSON.parse(await vs.wbEval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); return b ? JSON.stringify(b.getBoundingClientRect()) : 'null'; })()`));
  if (!b) throw new Error('no dialog button ' + label);
  await vs.click(b.x + b.width / 2, b.y + b.height / 2); await sleep(600);
};
const notes = async () => (await vs.notifications()).join(' | ');
const clearNotes = async () => { await cmd('Notifications: Clear All Notifications'); await sleep(300); };
const tab = async id => { await vs.wvClick(wv, `document.querySelector('.tabs [data-panel="${id}"]')`); await sleep(500); };
const pro = async () => (await probe()).pro;
const extHostMB = () => {
  const ud = path.join(work, 'ud');
  const rows = execSync('ps -axo pid=,rss=,command=', { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(l => l.includes(ud) && /Plugin|NodeService|extensionHost/i.test(l));
  return rows.map(l => { const [pid, rss] = l.trim().split(/\s+/); return { pid: Number(pid), mb: Math.round(Number(rss) / 1024) }; });
};
const waitTree = async (ms = 20000) => vs.waitFor(async () => { const p = await pro(); return p && !p.busy && (p.treeTop || p.structError) && p; }, ms, 150);
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();

try {
  await sleep(3000);
  if (phase === 'free') {
    await step('free: a file opens with no Pro popup, dialog or notification; tabs show PRO badges; Inspector is the open tab', async () => {
      await openHex('sample.png');
      await sleep(1500);
      const d = await dialog(), n = await notes();
      const p = await pro();
      const badges = JSON.parse(await E(`JSON.stringify([...document.querySelectorAll('.tabs .pro')].map(b => getComputedStyle(b).display))`));
      await shot('free-open');
      if (d || /Pro/.test(n) || p.panel !== 'inspector' || p.licensed || badges.length !== 2 || badges.includes('none')) throw new Error(JSON.stringify({ d, n, p, badges }));
      return { badges, panel: p.panel };
    });
    await step('free: the Structure tab explains itself, names the matching template and offers a free try, Get Pro and Unlock', async () => {
      await tab('struct');
      const ok = await vs.waitFor(async () => { const t = await E(`(document.querySelector('.pane.struct .locked') || {}).textContent || ''`); return /PNG image template/.test(t) && /3 of 3 free tries left/.test(t) && t; }, 8000);
      const buttons = JSON.parse(await E(`JSON.stringify([...document.querySelectorAll('.pane.struct .locked button')].map(b => b.textContent))`));
      await shot('free-struct-locked');
      if (!ok || !buttons.includes('Get Pro') || !buttons.includes('Unlock') || !buttons.includes('Try it on this file')) throw new Error(JSON.stringify({ ok, buttons }));
      if (await dialog()) throw new Error('a dialog opened on a tab click');
      return { text: ok.slice(0, 300), buttons };
    });
    await step('free: a free try opens the PNG tree; clicking IHDR > width selects bytes 0x10-0x13', async () => {
      await vs.wvClick(wv, `document.querySelector('.pane.struct .trybtn')`);
      const p = await waitTree();
      if (!p || p.structError || !p.treeTop || !p.treeTop.includes('chunks')) throw new Error(JSON.stringify(p));
      // open chunks[0] > data, then click width
      const clickRow = async (name, nth = 0) => { await vs.wvClick(wv, `[...document.querySelectorAll('.tn')].filter(r => r.querySelector('.nm').textContent === ${JSON.stringify(name)})[${nth}]`); await sleep(300); };
      const expand = async (name, nth = 0) => { await vs.wvClick(wv, `[...document.querySelectorAll('.tn')].filter(r => r.querySelector('.nm').textContent === ${JSON.stringify(name)})[${nth}].querySelector('.tw')`); await sleep(300); };
      await expand('chunks[0]'); await expand('data'); await clickRow('width');
      const q = await probe();
      await shot('free-try-tree');
      if (q.selStart !== 0x10 || q.selEnd !== 0x14) throw new Error(JSON.stringify({ s: q.selStart, e: q.selEnd, sel: q.pro.selPath }));
      return { selStart: q.selStart, selEnd: q.selEnd, trials: q.pro.trials };
    });
    await step('free: checksums run 3 times (quick pick of 6 values), the 4th click explains Pro with Get Pro and Enter Key', async () => {
      await tab('inspector');
      const seen = [];
      for (let i = 0; i < 3; i++) {
        await vs.wvClick(wv, `document.querySelector('.sumrow button')`);
        const t = await vs.waitFor(async () => /^Checksums of/.test(await quickTitle()) && (await quickItems()), 6000);
        if (!t || t.length !== 6) throw new Error('try ' + (i + 1) + ': ' + JSON.stringify(t));
        seen.push(t.length);
        await vs.key('Escape', 'Escape'); await sleep(400);
      }
      await vs.wvClick(wv, `document.querySelector('.sumrow button')`);
      const d = await vs.waitFor(dialog, 6000);
      await shot('free-4th-click-dialog');
      if (!d || !/Checksums is part of Zovo Pro/.test(d.text) || !['Unlock with GitHub Sponsors', 'I have a license key', 'Get Zovo Pro'].every(b => d.buttons.includes(b)) || !/used the 3 free tries/.test(d.detail)) throw new Error(JSON.stringify(d));
      // Cancel: "Get Zovo Pro" would open the owner's browser
      await clickDialog('Cancel');
      if (await dialog()) throw new Error('the dialog stayed open');
      return { tries: seen, dialog: d.text, buttons: d.buttons, detail: d.detail.slice(0, 400) };
    });
    await step('free: "Unlock Zovo Pro with GitHub Sponsors" shows VS Code\'s GitHub sign-in prompt (cancelled here; the owner does the real sign-in)', async () => {
      await cmd('Hex Viewer: Unlock Zovo Pro with GitHub Sponsors');
      const d = await vs.waitFor(dialog, 8000);
      await shot('sponsors-sign-in-prompt');
      if (!d || !/GitHub/i.test(d.text + d.detail)) throw new Error(JSON.stringify({ d, notes: await notes() }));
      await clickDialog('Cancel'); await sleep(800);
      const n = await notes();
      await clearNotes();
      return { prompt: d.text, buttons: d.buttons, after: n };
    });
    await step('free: compare view has "Export report" with a PRO badge; free compare still counts differences', async () => {
      await closeAll();
      await cmd('Hex Viewer: Compare in Hex Viewer'); await sleep(800);
      await typeQuick(P('cmp-a.bin')); await enter(); await sleep(500);
      await typeQuick(P('cmp-b.bin')); await enter(); await sleep(1500);
      const w = await vs.waitFor(async () => (await vs.webviews()).find(x => /cmp-a\.bin ↔ cmp-b\.bin/.test(x.title) && x.w > 0), 15000);
      if (!w) throw new Error('no compare view');
      const st = await vs.waitFor(async () => { const p = JSON.parse(await vs.wvEval(w, `JSON.stringify(window.hexCompareProbe())`)); return p.stats && p; }, 15000);
      const btn = JSON.parse(await vs.wvEval(w, `JSON.stringify((() => { const b = [...document.querySelectorAll('button')].find(x => /Export report/.test(x.textContent)); return b ? { text: b.textContent, badge: getComputedStyle(b.querySelector('.pro')).display } : null; })())`));
      await shot('free-compare');
      if (!btn || btn.badge === 'none' || !st || !st.stats || st.stats.bytes < 1) throw new Error(JSON.stringify({ btn, st }));
      return { btn, stats: st.stats };
    });
  }

  if (phase === 'pro') {
    await step('pro: Enter Zovo Pro License Key with the test key turns Pro on and hides the PRO badges', async () => {
      await openHex('sample.png');
      await cmd('Hex Viewer: Enter Zovo Pro License Key'); await sleep(600);
      await typeQuick(process.env.GATE_KEY); await enter();
      const n = await vs.waitFor(async () => /Zovo Pro is on/.test(await notes()) && (await notes()), 6000);
      await sleep(500);
      const badges = JSON.parse(await E(`JSON.stringify([...document.querySelectorAll('.tabs .pro')].map(b => getComputedStyle(b).display))`));
      const p = await pro();
      if (!n || !p.licensed || badges.some(b => b !== 'none')) throw new Error(JSON.stringify({ n, licensed: p.licensed, badges }));
      await clearNotes();
      return { note: n, badges };
    });
    const expect = { 'sample.png': 'png', 'sample.jpg': 'jpeg', 'sample.gif': 'gif', 'sample.bmp': 'bmp', 'sample.ico': 'ico', 'sample.tiff': 'tiff', 'sample.webp': 'webp', 'sample.wav': 'wav', 'sample.flac': 'flac', 'sample.m4a': 'mp4', 'sample.zip': 'zip', 'sample.txt.gz': 'gzip', 'sample.tar': 'tar', 'sample.pdf': 'pdf', 'sample.sqlite': 'sqlite', 'sample.elf': 'elf', 'sample.exe': 'pe', 'ls-universal': 'macho', 'Hello.class': 'class', 'sample.pcap': 'pcap' };
    await step('pro: all 20 built-in templates read their sample in the Structure view with no error', async () => {
      const out = {};
      for (const [f, id] of Object.entries(expect)) {
        if (!fs.existsSync(P(f))) { out[f] = 'no sample'; continue; }
        await closeAll();
        await openHex(f);
        await tab('struct');
        const p = await waitTree();
        out[f] = p ? { detected: p.detected, template: p.template, error: p.structError, top: (p.treeTop || []).slice(0, 4) } : 'timeout';
        if (f === 'ls-universal' || f === 'sample.zip' || f === 'sample.elf') await shot('tree-' + id);
      }
      const bad = Object.entries(out).filter(([f, v]) => v !== 'no sample' && (typeof v === 'string' || v.detected !== expect[f] || v.error));
      if (bad.length) throw new Error(JSON.stringify(bad).slice(0, 700));
      return out;
    });
    await step('pro hostile: 4 GB sparse file (no template matches; ZIP template stops with a plain message), extension host stays small', async () => {
      await closeAll();
      await openHex('big4g.bin');
      await tab('struct');
      await vs.waitFor(async () => /No template matches/.test(await E(`document.querySelector('.pane.struct').textContent`)), 8000);
      await vs.wvClick(wv, `[...document.querySelectorAll('.pane.struct button')].find(b => b.textContent === 'Template...')`);
      await vs.waitFor(async () => /read this file with a template/.test(await quickTitle()), 6000);
      await typeQuick('ZIP archive'); await enter();
      const p = await waitTree(20000);
      const mem = extHostMB();
      R.memory.push({ step: '4g-zip-template', mem });
      await shot('hostile-4g-zip');
      const host = mem.find(m => m.mb > 0 && m.mb === Math.max(...mem.map(x => x.mb)));
      if (!p || !/was not found/.test(p.structError || '')) throw new Error(JSON.stringify({ p, last: await pro(), title: await quickTitle(), items: (await quickItems()).slice(0, 3), notes: await notes(), pane: (await E(`document.querySelector('.pane.struct').textContent`)).slice(0, 300) }));
      if (mem.some(m => m.mb > 900)) throw new Error('memory ' + JSON.stringify(mem));
      return { error: p.structError, mem };
    });
    await step('pro hostile: truncated PNG, random bytes read as ELF, a file that changes while the tree is open', async () => {
      const out = {};
      await closeAll(); await openHex('trunc.png'); await tab('struct');
      let p = await waitTree(); out.trunc = p && p.structError;
      if (!p || !p.structError) throw new Error('truncated PNG: ' + JSON.stringify(p));
      await closeAll(); await openHex('random.bin'); await tab('struct');
      await vs.wvClick(wv, `[...document.querySelectorAll('.pane.struct button')].find(b => b.textContent === 'Template...')`);
      await vs.waitFor(async () => /read this file with a template/.test(await quickTitle()), 6000);
      await typeQuick('ELF executable'); await enter();
      p = await waitTree(); out.randomElf = p && (p.structError || 'parsed');
      if (!p) throw new Error('random as ELF: timeout');
      await closeAll(); await openHex('grow.png'); await tab('struct');
      p = await waitTree();
      fs.appendFileSync(P('grow.png'), Buffer.alloc(100, 0x41));
      await sleep(2500);
      p = await waitTree(); out.grown = p && (p.structError || 'ok');
      return out;
    });
    await step('pro: bookmarks: Cmd+F2 on a selection asks a name and a note, the bytes get a mark, F2 jumps, the bookmark is still there after reopening', async () => {
      await closeAll(); await openHex('firmware.bin');
      // select 0x100-0x103 with the Go to box and Shift+Right
      await vs.wvClick(wv, `document.querySelector('input.goto')`); await vs.type('0x100'); await vs.key('Enter', 'Enter'); await sleep(400);
      for (let i = 0; i < 3; i++) { await vs.key('ArrowRight', 'ArrowRight', 8, 39); await sleep(120); }
      await vs.key('F2', 'F2', 4, 113); await sleep(800); // Cmd+F2 (meta)
      if (!/add a bookmark/.test(await quickTitle())) { await vs.key('F2', 'F2', 2, 113); await sleep(800); } // Ctrl+F2
      if (!/add a bookmark/.test(await quickTitle())) throw new Error('no bookmark prompt: ' + (await quickTitle()));
      await vs.type('Header magic'); await enter();
      await vs.type('uint32 0x12345678'); await enter();
      await sleep(600);
      await tab('bm');
      const list = await vs.waitFor(async () => { const p = await pro(); return p.bookmarks.length && p.bookmarks; }, 5000);
      const marks = await E(`document.querySelectorAll('.rows .bk').length`);
      await shot('bookmarks');
      await vs.wvClick(wv, `document.querySelector('input.goto')`); await vs.type('0x0'); await vs.key('Enter', 'Enter'); await sleep(300);
      await vs.key('F2', 'F2', 0, 113); await sleep(500);
      const jumped = (await probe()).selStart;
      await closeAll(); await openHex('firmware.bin'); await tab('bm');
      const again = await vs.waitFor(async () => { const p = await pro(); return p.bookmarks.length && p.bookmarks; }, 5000);
      if (!list || list[0][0] !== 0x100 || list[0][1] !== 0x104 || list[0][2] !== 'Header magic' || marks < 4 || jumped !== 0x100 || !again) throw new Error(JSON.stringify({ list, marks, jumped, again }));
      return { list, marks, jumped, again };
    });
    await step('pro: checksums of the selection: SHA-256 copied equals Python hashlib', async () => {
      await tab('inspector');
      await vs.wvClick(wv, `document.querySelector('input.goto')`); await vs.type('0x2FFFD'); await vs.key('Enter', 'Enter'); await sleep(300);
      for (let i = 0; i < 5; i++) { await vs.key('ArrowRight', 'ArrowRight', 8, 39); await sleep(100); }
      await vs.wvClick(wv, `document.querySelector('.sumrow button')`);
      await vs.waitFor(async () => /^Checksums of bytes 0x2FFFD/.test(await quickTitle()), 6000);
      await typeQuick('SHA-256'); await enter(); await sleep(500);
      const clip = execSync('pbpaste', { encoding: 'utf8' }).trim();
      const want = sha(fs.readFileSync(P('firmware.bin')).subarray(0x2FFFD, 0x30003));
      if (clip !== want) throw new Error(JSON.stringify({ clip, want }));
      return { sha256: clip };
    });
    await step('pro: Structure export as JSON and as C open in new editors with the parsed values', async () => {
      await closeAll(); await openHex('sample.png'); await tab('struct'); await waitTree();
      await vs.wvClick(wv, `[...document.querySelectorAll('.pane.struct button')].find(b => b.textContent === 'JSON')`); await sleep(1500);
      const json = await vs.wbEval(`(document.querySelector('.editor-group-container.active .monaco-editor .view-lines') || {}).innerText || ''`);
      await shot('export-json');
      await cmd('View: Revert and Close Editor'); await sleep(500);
      if (await dialog()) await clickDialog("Don't Save");
      const ok = /"signature"/.test(json) && /"width": 3/.test(json.replace(/ /g, ' '));
      if (!ok) throw new Error(json.slice(0, 400));
      return { json: json.slice(0, 200) };
    });
    await step('pro: compare report: Export report writes a text report with the 3 differing areas and the extra tail', async () => {
      await closeAll();
      try { fs.rmSync(P('report.txt')); } catch {}
      await cmd('Hex Viewer: Compare in Hex Viewer'); await sleep(800);
      await typeQuick(P('cmp-a.bin')); await enter(); await sleep(500);
      await typeQuick(P('cmp-b.bin')); await enter(); await sleep(1500);
      const w = await vs.waitFor(async () => (await vs.webviews()).find(x => /cmp-a\.bin ↔ cmp-b\.bin/.test(x.title) && x.w > 0), 15000);
      await vs.wvClick(w, `[...document.querySelectorAll('button')].find(x => /Export report/.test(x.textContent))`);
      await vs.waitFor(async () => /save the compare report/.test(await quickTitle()), 6000);
      await typeQuick(P('report.txt')); await enter();
      const ok = await vs.waitFor(() => fs.existsSync(P('report.txt')) && /differing bytes in/.test(fs.readFileSync(P('report.txt'), 'utf8')), 15000);
      const txt = fs.existsSync(P('report.txt')) ? fs.readFileSync(P('report.txt'), 'utf8') : '';
      const lines = txt.split('\n').filter(l => /^0x/.test(l));
      if (!ok || lines.length !== 3 || !/only in B/.test(txt)) throw new Error(txt.slice(0, 600));
      await clearNotes();
      return { lines };
    });
    await step('pro: find in files: hex DE AD BE EF in **/*.bin lists firmware.bin at 0x2FFFD; picking it opens Hex Viewer there', async () => {
      await closeAll();
      await cmd('Hex Viewer Pro: Find Bytes in Files...'); await sleep(600);
      await vs.waitFor(async () => /what to look for/.test(await quickTitle()), 6000);
      await typeQuick('Hex bytes'); await enter();
      await typeQuick('DE AD BE EF'); await enter();
      await vs.waitFor(async () => /which files/.test(await quickTitle()), 6000);
      await typeQuick('**/*.bin'); await enter();
      const items = await vs.waitFor(async () => /Find in files: /.test(await quickTitle()) && (await quickItems()), 30000);
      const title = await quickTitle();
      await shot('find-in-files');
      const hit = (items || []).find(t => /firmware\.bin\s+0x2FFFD/.test(t));
      if (!hit) throw new Error(JSON.stringify({ title, items: (items || []).slice(0, 5) }));
      await typeQuick('firmware.bin'); await enter(); await sleep(1500);
      wv = await findWv('firmware.bin', 8000);
      const q = wv && await rendered();
      if (!q || q.selStart !== 0x2FFFD || q.selEnd !== 0x30001) throw new Error(JSON.stringify({ sel: q && [q.selStart, q.selEnd] }));
      return { title, hit, sel: [q.selStart, q.selEnd] };
    });
  }
} finally {
  R.memory.push({ step: 'end', mem: extHostMB() });
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'|ERR_FILE_NOT_FOUND.*product/i.test(c.text));
  R.extErrors = R.console.filter(c => /hex-viewer|hexViewer|custom document|zovo/i.test(c.text));
  // a CSP refusal for our own webview resources counts as an extension error
  R.cspErrors = R.console.filter(c => /Content Security Policy/.test(c.text) && /PRO1-work|zovo/i.test(c.text));
  R.extErrors.push(...R.cspErrors);
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /hex|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ phase, pass: R.steps.filter(s => s.ok).length, fail: R.steps.filter(s => s.ok === false).length, skip: R.steps.filter(s => s.ok === null).length, extErrors: R.extErrors.length, logErrors: R.logErrors, memory: R.memory, install: R.install.code }, null, 1));
}
