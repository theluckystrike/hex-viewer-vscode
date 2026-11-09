// Hex Viewer Pro in the webview: the side panel tabs (Inspector, Structure, Bookmarks), the Structure tree,
// the bookmark list and the grid marks for both. Without a license the Pro tabs explain themselves when
// clicked (with Get Pro and Enter key); nothing opens on its own.

export function createProUI(api) {
  const { $, post, S, el, render, selectRange, hint, esc, hexOffset, fmtInt, saved, persist } = api;
  const P = {
    licensed: false, onSale: false, panel: saved.panel || 'inspector',
    info: null, tree: null, treeName: '', treeError: null, treeMeta: '', busy: false, selPath: null, open: new Set(['']),
    bookmarks: [], structTimer: 0,
  };
  const u = {};

  // ---------- tabs ----------
  const badge = () => $('span', { class: 'pro', 'aria-label': 'Pro feature', title: 'Hex Viewer Pro feature', text: 'PRO' });
  const tab = (id, text, pro) => {
    const b = $('button', { class: 'tab', role: 'tab', 'aria-selected': 'false', 'data-panel': id, onclick: () => show(id, true) }, text);
    if (pro) b.append(badge());
    return b;
  };
  u.tabs = $('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Side panel' }, tab('inspector', 'Inspector'), tab('struct', 'Structure', true), tab('bm', 'Bookmarks', true));
  u.struct = $('div', { class: 'pane struct', role: 'tabpanel', hidden: true });
  u.bm = $('div', { class: 'pane bms', role: 'tabpanel', hidden: true });

  function show(id, byUser) {
    P.panel = id; saved.panel = id; persist();
    for (const b of u.tabs.children) b.setAttribute('aria-selected', String(b.dataset.panel === id));
    el.insPane.hidden = id !== 'inspector';
    u.struct.hidden = id !== 'struct';
    u.bm.hidden = id !== 'bm';
    if (byUser && el.side.hidden) { S.inspector = true; el.side.hidden = false; el.insBtn.setAttribute('aria-pressed', 'true'); persist(); api.layout(); }
    if (id === 'struct') { if (!P.info) post({ type: 'structDetect' }); if ((P.licensed || P.structTrial) && !P.tree && !P.busy) parse(); drawStruct(); }
    if (id === 'bm') { post({ type: 'bmList' }); drawBookmarks(); }
    render();
  }

  // ---------- locked card ----------
  function lockedCard(feature, title, lines) {
    const card = $('div', { class: 'locked' }, $('h3', {}, title, badge()));
    for (const l of lines) if (l) card.append($('p', { text: l }));
    card.append($('p', { class: 'free', text: 'Everything you use today stays free: viewing, find, go to offset, the data inspector, editing and compare.' }));
    const left = P.trials ? P.trials[feature] || 0 : 0;
    if (left > 0) card.append($('div', { class: 'row2' }, $('button', { class: 'primary trybtn', text: feature === 'bookmarks' ? 'Try it: add a bookmark' : 'Try it on this file', onclick: () => post({ type: 'proTry', feature }) }), $('span', { class: 'meta', text: `${left} of 3 free tries left on this computer` })));
    card.append($('div', { class: 'row2' },
      $('button', { class: left > 0 ? '' : 'primary', text: 'Get Pro', onclick: () => post({ type: 'proGet' }) }),
      $('button', { title: 'Unlock with GitHub Sponsors or a license key', text: 'Unlock', onclick: () => post({ type: 'proKey' }) }),
      $('button', { class: 'link', text: 'More about this', onclick: () => post({ type: 'proExplain', feature }) })));
    return card;
  }

  // ---------- structure ----------
  function parse(id) {
    P.busy = true; P.treeError = null;
    post({ type: 'structParse', id: id || (P.tree && P.treeId) || undefined });
    drawStruct();
  }

  function drawStruct() {
    const box = u.struct;
    box.textContent = '';
    if (!P.licensed && !P.structTrial) {
      const t = P.info && P.info.best ? `This file matches the ${P.info.best.name} template.` : P.info ? 'No built-in template matches this file; you can pick one or add your own.' : '';
      box.append(lockedCard('templates', 'Structure view', [t, 'See the fields of the file as a tree: names, offsets, values and enums. Click a field to select its bytes. 20 templates ship (PNG, ZIP, ELF, PE, Mach-O, PDF, SQLite and more), and you can write your own. Export a struct as JSON or C.']));
      return;
    }
    const head = $('div', { class: 'phead' },
      $('span', { class: 'tname', text: P.busy ? `Reading with ${P.treeName || 'a template'}...` : (P.treeName || 'No template') }),
      $('span', { class: 'grow' }),
      $('button', { title: 'Read the file with another template', text: 'Template...', onclick: () => post({ type: 'structPick' }) }),
      $('button', { title: 'Read the file again', 'aria-label': 'Refresh', text: '⟳', onclick: () => parse() }));
    const exp = $('div', { class: 'phead' },
      $('span', { class: 'meta', text: P.treeMeta }), $('span', { class: 'grow' }),
      $('button', { title: 'Open the selected struct (or the whole file) as JSON', text: 'JSON', disabled: !P.tree, onclick: () => post({ type: 'structExport', format: 'json', path: P.selPath || [] }) }),
      $('button', { title: 'Open the selected struct (or the whole file) as a C struct with its values', text: 'C struct', disabled: !P.tree, onclick: () => post({ type: 'structExport', format: 'c', path: P.selPath || [] }) }));
    box.append(head, exp);
    if (P.treeError) box.append($('div', { class: 'perr', role: 'status', text: P.treeError }));
    if (P.none) box.append($('p', { class: 'hintp', text: 'No template matches this file. Pick one with Template..., or add your own JSON templates (setting hexViewer.templateFolders or the .vscode/hex-templates folder).' }));
    if (!P.tree) return;
    const list = $('div', { class: 'tree', role: 'tree', 'aria-label': 'File structure' });
    const LIMIT = 500;
    const add = (n, pathArr, depth) => {
      const key = pathArr.join('.');
      const kids = n.c || [];
      const isOpen = P.open.has(key);
      const row = $('div', { class: 'tn' + (sameSel(pathArr) ? ' on' : '') + (n.e ? ' bad' : ''), role: 'treeitem', 'aria-level': String(depth + 1), 'aria-expanded': kids.length ? String(isOpen) : null, tabindex: '-1', title: `${n.t} at 0x${hexOffset(n.o, 1)}, ${fmtInt(n.s)} byte${n.s === 1 ? '' : 's'}${n.m ? '\n' + n.m : ''}${n.e ? '\n' + n.e : ''}` });
      row.style.paddingLeft = `${depth * 12 + 4}px`; // CSSOM, allowed by the webview CSP (a style attribute is not)
      row.append($('span', { class: 'tw', text: kids.length ? (isOpen ? '▾' : '▸') : ' ' }), $('span', { class: 'nm', text: n.n }));
      if (n.l) row.append($('span', { class: 'lb', text: n.l }));
      if (n.v !== undefined) row.append($('span', { class: 'vl' + (n.x ? ' cx' : ''), text: n.v }));
      else if (kids.length && !n.l) row.append($('span', { class: 'ty', text: n.t }));
      if (n.e) row.append($('span', { class: 'er', text: '⚠ ' + n.e }));
      row.addEventListener('click', e => {
        if (e.target.classList.contains('tw') && kids.length) { toggle(key); return; }
        P.selPath = pathArr; if (!n.x) selectRange(n.o, n.o + Math.max(1, n.s)); drawStruct();
      });
      row.addEventListener('dblclick', () => { if (kids.length) toggle(key); });
      list.append(row);
      if (kids.length && isOpen) {
        const shown = Math.min(kids.length, P.more && P.more[key] ? P.more[key] : LIMIT);
        for (let i = 0; i < shown; i++) add(kids[i], [...pathArr, i], depth + 1);
        if (shown < kids.length) list.append(indent($('button', { class: 'link more', text: `Show ${fmtInt(Math.min(LIMIT, kids.length - shown))} more of ${fmtInt(kids.length)}`, onclick: () => { P.more = P.more || {}; P.more[key] = shown + LIMIT; drawStruct(); } }), (depth + 1) * 12 + 4));
      }
    };
    add(P.tree, [], 0);
    box.append(list);
  }
  const indent = (e, px) => { e.style.marginLeft = px + 'px'; return e; };
  const sameSel = p => P.selPath && P.selPath.length === p.length && P.selPath.every((v, i) => v === p[i]);
  function toggle(key) { if (P.open.has(key)) P.open.delete(key); else P.open.add(key); drawStruct(); }
  function selNode() {
    if (!P.tree || !P.selPath) return null;
    let n = P.tree;
    for (const i of P.selPath) { n = n.c && n.c[i]; if (!n) return null; }
    return n;
  }

  // ---------- bookmarks ----------
  function drawBookmarks() {
    const box = u.bm;
    box.textContent = '';
    if (!P.licensed) {
      if (P.bookmarks.length) box.append(bookmarkList());
      box.append(lockedCard('bookmarks', 'Bookmarks and notes', ['Mark byte ranges with a name, a color and a note, saved per file on this computer. F2 and Shift+F2 jump between them; Ctrl+F2 (Cmd+F2) adds one at the selection. Export the list as Markdown.']));
      return;
    }
    box.append($('div', { class: 'phead' },
      $('button', { title: 'Bookmark the selected bytes (Ctrl+F2, Cmd+F2 on macOS)', text: '+ Add bookmark', onclick: () => addAtSelection() }),
      $('span', { class: 'grow' }),
      $('button', { title: 'Open the list as Markdown', text: 'Export', disabled: !P.bookmarks.length, onclick: () => post({ type: 'bmExport' }) })));
    if (!P.bookmarks.length) { box.append($('p', { class: 'hintp', text: 'No bookmarks in this file yet. Select some bytes and press Ctrl+F2 (Cmd+F2), or click Add bookmark.' })); return; }
    box.append(bookmarkList());
  }
  function bookmarkList() {
    const list = $('div', { class: 'bmlist', role: 'list' });
    for (const b of P.bookmarks) {
      const item = $('div', { class: 'bmi', role: 'listitem', tabindex: '0', title: b.note || b.label },
        $('span', { class: 'dot bk-' + b.color }),
        $('div', { class: 'bmt' }, $('div', { class: 'bml', text: b.label }), $('div', { class: 'bmo', text: `0x${hexOffset(b.start, 1)} · ${fmtInt(b.end - b.start)} byte${b.end - b.start === 1 ? '' : 's'}` }), b.note ? $('div', { class: 'bmn', text: b.note }) : null),
        $('button', { class: 'link', title: 'Edit, recolor or remove', 'aria-label': `Edit bookmark ${b.label}`, text: 'Edit', onclick: e => { e.stopPropagation(); post({ type: 'bmEdit', id: b.id }); } }));
      item.addEventListener('click', () => selectRange(b.start, b.end));
      item.addEventListener('keydown', e => { if (e.key === 'Enter') selectRange(b.start, b.end); if (e.key === 'Delete') post({ type: 'bmRemove', id: b.id }); });
      list.append(item);
    }
    return list;
  }
  function addAtSelection() {
    const s0 = Math.min(S.anchor, S.cursor), s1 = Math.max(S.anchor, S.cursor) + 1;
    if (!P.licensed && !(P.trials && P.trials.bookmarks > 0)) { post({ type: 'proExplain', feature: 'bookmarks' }); return; }
    post({ type: 'bmAdd', start: s0, end: Math.min(Math.max(s1, s0 + 1), Math.max(1, S.size)) });
  }
  function jump(backward) {
    const l = P.bookmarks;
    if (!l.length) { hint('No bookmarks in this file.'); return; }
    const at = S.cursor;
    const b = backward ? ([...l].reverse().find(x => x.start < at) || l[l.length - 1]) : (l.find(x => x.start > at) || l[0]);
    selectRange(b.start, b.end);
    hint(`Bookmark: ${b.label}${b.note ? ' · ' + b.note.slice(0, 80) : ''}`);
  }

  // ---------- grid marks ----------
  /** Extra classes for the cells of one row: bookmarks (colored underline) and the selected struct field. */
  function rowMarks(start, count) {
    const out = new Array(count).fill('');
    {
      for (const b of P.bookmarks) {
        if (b.end <= start || b.start >= start + count) continue;
        for (let o = Math.max(b.start, start); o < Math.min(b.end, start + count); o++) out[o - start] = ' bk bk-' + b.color;
      }
    }
    const n = P.panel === 'struct' && selNode();
    if (n && n.s > 0) for (let o = Math.max(n.o, start); o < Math.min(n.o + n.s, start + count); o++) out[o - start] += ' st';
    return out;
  }

  // ---------- messages ----------
  function onMessage(m) {
    switch (m.type) {
      case 'pro':
        P.licensed = !!m.licensed; P.onSale = !!m.onSale; if (m.trials) P.trials = m.trials;
        document.body.classList.toggle('licensed', P.licensed);
        if (P.panel === 'struct') { if ((P.licensed || P.structTrial) && !P.tree && !P.busy) parse(); drawStruct(); }
        if (P.panel === 'bm') { post({ type: 'bmList' }); drawBookmarks(); }
        post({ type: 'bmList' });
        render();
        return true;
      case 'structInfo':
        P.info = m; if (m.licensed !== undefined) { P.licensed = m.licensed; document.body.classList.toggle('licensed', P.licensed); }
        if (m.trials) P.trials = m.trials;
        if (m.structTrial) P.structTrial = true;
        if (!P.treeName && m.best) P.treeName = m.best.name;
        u.tabs.querySelector('[data-panel="struct"]').title = m.best ? `Structure: ${m.best.name}` : 'Structure';
        drawStruct();
        return true;
      case 'structBusy': P.busy = true; P.treeName = m.name; drawStruct(); return true;
      case 'struct':
        P.busy = false;
        if (m.locked) { P.licensed = false; P.structTrial = false; if (m.trial !== undefined) P.trials = { ...(P.trials || {}), templates: m.trial }; drawStruct(); return true; }
        P.none = !!m.none;
        if (m.none) { P.tree = null; P.treeName = ''; drawStruct(); return true; }
        if (P.treeId !== m.id) { P.selPath = null; P.open = new Set(['']); P.more = null; }
        P.tree = m.tree; P.treeId = m.id; P.treeName = m.name + (m.user ? ' (your template)' : '');
        P.treeError = m.error ? `The template stopped: ${m.error}` : null;
        P.treeMeta = `${fmtInt(m.nodes)} fields, ${m.ms} ms`;
        // open the first level, so the main structs show at once
        if (P.open.size === 1 && P.tree.c) P.tree.c.forEach((c, i) => { if (c.c && c.c.length <= 64) P.open.add(String(i)); });
        drawStruct(); render();
        return true;
      case 'bookmarks':
        P.bookmarks = m.list || [];
        if (m.licensed !== undefined) P.licensed = m.licensed;
        if (m.trial !== undefined) P.trials = { ...(P.trials || {}), bookmarks: m.trial };
        if (P.panel === 'bm') drawBookmarks();
        render();
        return true;
      case 'showPanel': show(m.panel, true); return true;
      case 'bmJump': jump(!!m.backward); return true;
    }
    return false;
  }

  function onKey(e) {
    if (e.key === 'F2' && !e.altKey) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) addAtSelection(); else jump(e.shiftKey);
      return true;
    }
    return false;
  }

  /** After an edit or a change on disk: read the structure again (once the typing stops). */
  function afterChange() {
    if ((!P.licensed && !P.structTrial) || !P.tree) return;
    clearTimeout(P.structTimer);
    P.structTimer = setTimeout(() => { if (P.panel === 'struct') parse(); else P.tree = null; }, 700);
  }

  function start() {
    post({ type: 'proState' });
    post({ type: 'bmList' });
    show(P.panel === 'struct' || P.panel === 'bm' ? P.panel : 'inspector', false);
  }

  const probe = () => ({
    panel: P.panel, licensed: P.licensed, template: P.treeName, structError: P.treeError, busy: P.busy,
    treeTop: P.tree && P.tree.c ? P.tree.c.map(c => c.n) : null, selPath: P.selPath, bookmarks: P.bookmarks.map(b => [b.start, b.end, b.label]),
    locked: !!document.querySelector('.pane:not([hidden]) .locked'), detected: P.info && P.info.best ? P.info.best.id : null, trials: P.trials || null, structTrial: !!P.structTrial,
  });

  return { tabs: u.tabs, panes: [u.struct, u.bm], onMessage, onKey, rowMarks, afterChange, start, probe, show, state: P };
}
