'use strict';
// The compare report (Hex Viewer Pro): every differing range of two files as text, CSV or JSON, written as
// a stream, so a report on two 4 GB files with a million differences never sits in memory as one string.
const { diffRanges } = require('./compare');

const HEX = b => Array.from(b, x => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');
const hexOff = (n, w) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');
const csvCell = s => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

/**
 * Write a report. a, b: documents (size + read). info: { nameA, nameB, pathA, pathB }. format: 'txt' | 'csv' | 'json'.
 * write(text): async sink. Returns { ranges, bytes, truncated, cancelled }.
 */
async function writeReport(a, b, info, format, write, opts = {}) {
  const width = Math.max(8, Math.max(0, Math.max(a.size, b.size) - 1).toString(16).length);
  const when = opts.now || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const maxRanges = opts.maxRanges || 1e6;
  let first = true;
  if (format === 'txt') {
    await write(`Hex Viewer compare report, ${when}\n` +
      `A: ${info.pathA} (${a.size.toLocaleString('en-US')} bytes)\n` +
      `B: ${info.pathB} (${b.size.toLocaleString('en-US')} bytes)\n` +
      `Each line: offset, length, then up to 16 bytes of A and of B.\n\n`);
  } else if (format === 'csv') {
    await write('offset_hex,offset,length,bytes_a,bytes_b,note\n');
  } else {
    await write(`{\n  "tool": "Hex Viewer compare report",\n  "created": ${JSON.stringify(when)},\n  "a": ${JSON.stringify({ path: info.pathA, size: a.size })},\n  "b": ${JSON.stringify({ path: info.pathB, size: b.size })},\n  "ranges": [`);
  }
  const onRange = async r => {
    const note = r.tail ? `only in ${r.tail.toUpperCase()} (the other file ends here)` : '';
    if (format === 'txt') {
      await write(`${hexOff(r.start, width)}  ${String(r.length).padStart(10)}  A: ${(HEX(r.a) || '-').padEnd(47)}  B: ${HEX(r.b) || '-'}${r.length > r.a.length && r.a.length && r.b.length ? ' …' : ''}${note ? '  (' + note + ')' : ''}\n`);
    } else if (format === 'csv') {
      await write([hexOff(r.start, 0), r.start, r.length, HEX(r.a), HEX(r.b), note].map(v => csvCell(String(v))).join(',') + '\n');
    } else {
      await write((first ? '\n    ' : ',\n    ') + JSON.stringify({ offset: r.start, length: r.length, a: HEX(r.a), b: HEX(r.b), ...(r.tail ? { only_in: r.tail } : {}) }));
      first = false;
    }
  };
  const res = await diffRanges(a, b, onRange, { ...opts, maxRanges });
  const summary = res.cancelled ? 'Stopped before the end.' : `${res.bytes.toLocaleString('en-US')} differing bytes in ${res.ranges.toLocaleString('en-US')} ranges${res.truncated ? `; the report stops after ${maxRanges.toLocaleString('en-US')} ranges` : ''}.`;
  if (format === 'txt') await write(`\n${res.ranges === 0 && !res.cancelled ? 'The files are identical.' : summary}\n`);
  else if (format === 'json') await write(`${first ? '' : '\n  '}],\n  "differing_bytes": ${res.bytes},\n  "range_count": ${res.ranges},\n  "complete": ${!res.truncated && !res.cancelled}\n}\n`);
  return res;
}

module.exports = { writeReport };
