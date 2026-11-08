'use strict';
// Byte-by-byte compare of two documents (HexDocument or anything with size and read(offset, length)).
// Offset N of one file is compared with offset N of the other. Bytes past the end of the shorter file
// count as different. Reads 1 MB at a time from each file, so 4 GB and larger files work.
const CHUNK = 1 << 20;

const tick = () => new Promise(r => setImmediate(r));

function firstDiff(x, y, n) {
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i;
  return -1;
}
function lastDiff(x, y, n) {
  for (let i = n - 1; i >= 0; i--) if (x[i] !== y[i]) return i;
  return -1;
}
const same = (x, y, n) => Buffer.from(x.buffer, x.byteOffset, n).equals(Buffer.from(y.buffer, y.byteOffset, n));

/** Two reusable 1 MB buffers per scan; readInto when the document has it, read otherwise. */
function reader(a, b) {
  const ba = Buffer.allocUnsafe(CHUNK), bb = Buffer.allocUnsafe(CHUNK);
  const one = async (d, buf, pos, n) => {
    if (typeof d.readInto === 'function') { const got = await d.readInto(pos, n, buf); return buf.subarray(0, got); }
    return d.read(pos, n);
  };
  return (pos, n) => Promise.all([one(a, ba, pos, n), one(b, bb, pos, n)]);
}

/**
 * Next differing offset. Forward: the first difference at >= from. Backward: the last difference at <= from.
 * Returns { offset } (offset -1 when there is none) or { offset: -1, cancelled: true }.
 */
async function findDiff(a, b, from, backward, shouldStop = () => false, progress = () => {}) {
  const both = reader(a, b);
  const min = Math.min(a.size, b.size), max = Math.max(a.size, b.size);
  let last = Date.now();
  const report = async done => { if (Date.now() - last > 250) { last = Date.now(); progress(done, min); await tick(); } };
  if (!backward) {
    let pos = Math.max(0, from);
    while (pos < min) {
      if (shouldStop()) return { offset: -1, cancelled: true };
      const n = Math.min(CHUNK, min - pos);
      const [x, y] = await both(pos, n);
      const m = Math.min(x.length, y.length);
      if (m < n) return { offset: pos + m, short: true };
      if (!same(x, y, n)) return { offset: pos + firstDiff(x, y, n) };
      pos += n;
      await report(pos);
    }
    return { offset: pos < max ? Math.max(pos, min) : -1 };
  }
  let top = Math.min(from, max - 1);
  if (top >= min) return { offset: top };
  while (top >= 0) {
    if (shouldStop()) return { offset: -1, cancelled: true };
    const start = Math.max(0, top - CHUNK + 1), n = top - start + 1;
    const [x, y] = await both(start, n);
    if (Math.min(x.length, y.length) < n) return { offset: start + Math.min(x.length, y.length), short: true };
    if (!same(x, y, n)) return { offset: start + lastDiff(x, y, n) };
    top = start - 1;
    await report(min - start);
  }
  return { offset: -1 };
}

/**
 * Whole-file summary: differing bytes, differing runs (areas), first and last difference, and a coarse map
 * (`buckets` slots, 1 where a slot holds a difference) for the scroll bar.
 */
async function diffStats(a, b, shouldStop = () => false, progress = () => {}, buckets = 256) {
  const both = reader(a, b);
  const min = Math.min(a.size, b.size), max = Math.max(a.size, b.size);
  const map = new Uint8Array(buckets);
  const mark = off => { if (max) map[Math.min(buckets - 1, Math.floor((off / max) * buckets))] = 1; };
  let bytes = 0, runs = 0, first = -1, lastD = -1, inRun = false, last = Date.now();
  for (let pos = 0; pos < min; pos += CHUNK) {
    if (shouldStop()) return { cancelled: true };
    const n = Math.min(CHUNK, min - pos);
    const [x, y] = await both(pos, n);
    if (Math.min(x.length, y.length) < n) throw new Error('A file got shorter on disk during the compare.');
    if (same(x, y, n)) { inRun = false; }
    else {
      for (let i = 0; i < n; i++) {
        if (x[i] !== y[i]) {
          bytes++;
          if (!inRun) { runs++; inRun = true; mark(pos + i); }
          if (first < 0) first = pos + i;
          lastD = pos + i;
        } else inRun = false;
      }
    }
    if (Date.now() - last > 250) { last = Date.now(); progress(pos + n, min); await tick(); }
  }
  if (max > min) {
    bytes += max - min;
    if (!inRun) runs++;
    if (first < 0) first = min;
    lastD = max - 1;
    for (let o = min; o < max; o += Math.max(1, Math.floor(max / buckets))) mark(o);
    mark(max - 1);
  }
  return { bytes, runs, first, last: lastD, map: Array.from(map), identical: bytes === 0 };
}

module.exports = { findDiff, diffStats, CHUNK };
