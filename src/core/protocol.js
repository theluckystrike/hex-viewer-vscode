'use strict';
// Checks every message from the webview before the extension host acts on it.
const { COPY_FORMATS } = require('./bytes');

const MAX_READ = 1 << 20;          // one read request: 1 MB
const MAX_EDIT = 16 << 20;         // one paste: 16 MB
const MODES = new Set(['hex', 'text', 'utf16']);
const FORMATS = new Set(COPY_FORMATS.map(f => f[0]));
const isOff = v => Number.isSafeInteger(v) && v >= 0;

function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready': case 'rendered': case 'cancelSearch': case 'gotoPrompt':
      return { ok: true, msg: { type: m.type } };
    case 'read':
      if (!isOff(m.offset) || !Number.isSafeInteger(m.length) || m.length < 1 || m.length > MAX_READ) return { ok: false };
      return { ok: true, msg: { type: 'read', offset: m.offset, length: m.length } };
    case 'edit': {
      if (!isOff(m.offset)) return { ok: false };
      let v = m.values;
      if (Array.isArray(v)) { if (!v.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) return { ok: false }; v = Uint8Array.from(v); }
      if (!(v instanceof Uint8Array) || v.length < 1 || v.length > MAX_EDIT) return { ok: false };
      return { ok: true, msg: { type: 'edit', offset: m.offset, values: v, label: typeof m.label === 'string' ? m.label.slice(0, 40) : 'Edit' } };
    }
    case 'copy':
      if (!isOff(m.start) || !isOff(m.end) || m.end < m.start || !FORMATS.has(m.format)) return { ok: false };
      return { ok: true, msg: { type: 'copy', start: m.start, end: m.end, format: m.format } };
    case 'search':
      if (typeof m.query !== 'string' || m.query.length > 8192 || !MODES.has(m.mode) || !isOff(m.from) || !Number.isSafeInteger(m.id)) return { ok: false };
      return { ok: true, msg: { type: 'search', query: m.query, mode: m.mode, ignoreCase: !!m.ignoreCase, from: m.from, backward: !!m.backward, id: m.id } };
    case 'cursor':
      if (!isOff(m.offset) || !isOff(m.selStart) || !isOff(m.selEnd)) return { ok: false };
      return { ok: true, msg: { type: 'cursor', offset: m.offset, selStart: m.selStart, selEnd: m.selEnd } };
    case 'error':
      return { ok: true, msg: { type: 'error', message: String(m.message || '').slice(0, 500) } };
    default:
      return { ok: false };
  }
}

module.exports = { validateWebviewMessage, MAX_READ, MAX_EDIT };
