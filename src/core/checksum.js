'use strict';
// Checksums of a byte range (Hex Viewer Pro): CRC-32, Adler-32, MD5, SHA-1, SHA-256, SHA-512 in one pass,
// read 1 MB at a time, so a 4 GB file works with flat memory.
const crypto = require('crypto');

const CHUNK = 1 << 20;
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();

function crc32Update(crc, b) {
  let c = ~crc;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function adler32Update(adler, b) {
  let a = adler & 0xffff, s = adler >>> 16;
  for (let i = 0; i < b.length;) {
    const end = Math.min(b.length, i + 5552); // the largest run before s can pass 2^32
    for (; i < end; i++) { a += b[i]; s += a; }
    a %= 65521; s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

const NAMES = [['crc32', 'CRC-32'], ['adler32', 'Adler-32'], ['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']];

/** doc: size + read(offset, length). Returns { results: [[name, hex]], bytes } or { cancelled: true }. */
async function checksums(doc, start, end, shouldStop = () => false, progress = () => {}) {
  const hashes = ['md5', 'sha1', 'sha256', 'sha512'].map(h => [h, crypto.createHash(h)]);
  let crc = 0, adler = 1, last = Date.now();
  for (let pos = start; pos < end; pos += CHUNK) {
    if (shouldStop()) return { cancelled: true };
    const b = await doc.read(pos, Math.min(CHUNK, end - pos));
    if (!b.length) break;
    crc = crc32Update(crc, b); adler = adler32Update(adler, b);
    for (const [, h] of hashes) h.update(b);
    if (Date.now() - last > 200) { last = Date.now(); progress(pos - start + b.length, end - start); await new Promise(r => setImmediate(r)); }
  }
  const out = { crc32: crc.toString(16).toUpperCase().padStart(8, '0'), adler32: adler.toString(16).toUpperCase().padStart(8, '0') };
  for (const [n, h] of hashes) out[n] = h.digest('hex').toUpperCase();
  return { results: NAMES.map(([k, label]) => [label, out[k]]), bytes: end - start };
}

module.exports = { checksums, crc32Update, adler32Update };
