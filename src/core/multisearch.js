'use strict';
// Find bytes or text in many files (Hex Viewer Pro). Each file is opened with HexDocument (ranges, never whole),
// searched with the same matcher as the viewer, and closed. Limits: matches per file and in total.
const { HexDocument } = require('./doc');

/**
 * files: [{ path, open?: () => doc }]. pattern: from parsePattern. Calls onMatch({ file, offset, length, context })
 * and onFile(done, total, file). Returns { files, searched, matches, skipped: [{ path, error }], truncated, cancelled }.
 */
async function searchFiles(files, pattern, opts = {}) {
  const { perFile = 1000, total = 10000, shouldStop = () => false, onMatch = () => {}, onFile = () => {}, context = 8, skipLargerThan = Infinity } = opts;
  let matches = 0, searched = 0;
  const skipped = [];
  const len = pattern.bytes.length;
  for (let k = 0; k < files.length; k++) {
    if (shouldStop()) return { files: files.length, searched, matches, skipped, cancelled: true };
    const f = files[k];
    onFile(k, files.length, f.path);
    let doc;
    try {
      doc = f.open ? await f.open() : await HexDocument.openFile(f.path);
      if (doc.size > skipLargerThan) { skipped.push({ path: f.path, error: 'larger than the size limit' }); continue; }
      searched++;
      let from = 0, n = 0;
      while (from <= doc.size - len) {
        const r = await doc.search(pattern, from, false, false, shouldStop);
        if (r.cancelled) return { files: files.length, searched, matches, skipped, cancelled: true };
        if (r.offset < 0) break;
        const ctxStart = Math.max(0, r.offset - context);
        const bytes = await doc.read(ctxStart, r.offset - ctxStart + len + context);
        await onMatch({ file: f.path, offset: r.offset, length: len, context: { start: ctxStart, bytes } });
        matches++; n++;
        if (matches >= total) return { files: files.length, searched, matches, skipped, truncated: true };
        if (n >= perFile) { skipped.push({ path: f.path, error: `more than ${perFile} matches; the first ${perFile} are listed` }); break; }
        from = r.offset + 1;
      }
    } catch (e) {
      skipped.push({ path: f.path, error: (e && (e.code || e.message)) || String(e) });
    } finally {
      if (doc) await doc.dispose();
    }
  }
  return { files: files.length, searched, matches, skipped, truncated: false };
}

module.exports = { searchFiles };
