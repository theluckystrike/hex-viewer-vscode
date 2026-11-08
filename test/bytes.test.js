'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/core/bytes');

const seq = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

test('parseOffset: hex forms, decimal, relative, end, clamp and errors', () => {
  const size = 0x100000000 + 16; // 4 GB + 16
  assert.deepEqual(B.parseOffset('0x1F40', 0, size), { ok: true, offset: 0x1f40 });
  assert.deepEqual(B.parseOffset('1F40h', 0, size), { ok: true, offset: 0x1f40 });
  assert.deepEqual(B.parseOffset('$ff', 0, size), { ok: true, offset: 255 });
  assert.deepEqual(B.parseOffset('8000', 0, size), { ok: true, offset: 8000 });
  assert.deepEqual(B.parseOffset('1f40', 0, size), { ok: true, offset: 0x1f40 });
  assert.deepEqual(B.parseOffset('+0x10', 100, size), { ok: true, offset: 116 });
  assert.deepEqual(B.parseOffset('-16', 100, size), { ok: true, offset: 84 });
  assert.deepEqual(B.parseOffset('-500', 100, size), { ok: true, offset: 0 });
  assert.deepEqual(B.parseOffset('end', 0, size), { ok: true, offset: size - 1 });
  assert.deepEqual(B.parseOffset('end-15', 0, size), { ok: true, offset: size - 16 });
  assert.deepEqual(B.parseOffset('0xFFFF_FFF0', 0, size), { ok: true, offset: 0xfffffff0 });
  assert.equal(B.parseOffset('0x200000000', 0, size).ok, false);
  assert.equal(B.parseOffset('zz', 0, size).ok, false);
  assert.equal(B.parseOffset('', 0, size).ok, false);
  assert.deepEqual(B.parseOffset('0x10', 0, 0), { ok: true, offset: 0 });
});

test('parsePattern: hex with spaces, 0x, wildcards; text; utf16; errors', () => {
  let p = B.parsePattern('50 4B 03 04', 'hex');
  assert.deepEqual([...p.bytes], [0x50, 0x4b, 3, 4]); assert.equal(p.mask, null);
  p = B.parsePattern('0x50,0x4b ?? 04', 'hex');
  assert.deepEqual([...p.bytes], [0x50, 0x4b, 0, 4]); assert.deepEqual([...p.mask], [1, 1, 0, 1]);
  p = B.parsePattern('504B??04', 'hex');
  assert.deepEqual([...p.mask], [1, 1, 0, 1]);
  assert.equal(B.parsePattern('5', 'hex').ok, false);
  assert.equal(B.parsePattern('xyz', 'hex').ok, false);
  assert.equal(B.parsePattern('?? ??', 'hex').ok, false);
  p = B.parsePattern('PK', 'text');
  assert.deepEqual([...p.bytes], [0x50, 0x4b]);
  p = B.parsePattern('Hé', 'text');
  assert.deepEqual([...p.bytes], [0x48, 0xc3, 0xa9]);
  p = B.parsePattern('Hi', 'utf16');
  assert.deepEqual([...p.bytes], [0x48, 0, 0x69, 0]);
});

test('findForward / findBackward with wildcards and ignore case', () => {
  const buf = Buffer.from('xxABCxxabcxxAZC');
  const pp = B.preparePattern(B.parsePattern('abc', 'text', true));
  assert.equal(B.findForward(buf, pp, 0), 2);
  assert.equal(B.findForward(buf, pp, 3), 7);
  assert.equal(B.findBackward(buf, pp, 14), 7);
  const wild = B.preparePattern(B.parsePattern('41 ?? 43', 'hex'));
  assert.equal(B.findForward(buf, wild, 0), 2);
  assert.equal(B.findForward(buf, wild, 3), 12);
  assert.equal(B.findBackward(buf, wild, 11), 2);
});

test('formatCopy: every format', () => {
  const b = Uint8Array.from([0x4a, 0x5b, 0x00, 0x41]);
  assert.equal(B.formatCopy(b, 'hex'), '4A5B0041');
  assert.equal(B.formatCopy(b, 'hexSpaced'), '4A 5B 00 41');
  assert.equal(B.formatCopy(b, 'c', 'my-file'), 'unsigned char my_file[4] = {\n  0x4A, 0x5B, 0x00, 0x41\n};');
  assert.equal(B.formatCopy(b, 'python'), "b'\\x4a\\x5b\\x00\\x41'");
  assert.equal(B.formatCopy(b, 'base64'), Buffer.from(b).toString('base64'));
  assert.equal(B.formatCopy(Uint8Array.from([0x48, 0xc3, 0xa9]), 'text'), 'Hé');
  assert.equal(B.formatCopy(Uint8Array.from([0x48, 0xe9]), 'latin1'), 'Hé');
  const many = B.formatCopy(new Uint8Array(13), 'c');
  assert.equal(many.split('\n').length, 4);
  assert.equal(B.formatCopy(new Uint8Array(17), 'hexSpaced').split('\n').length, 2);
});

test('parseHexPaste', () => {
  assert.deepEqual([...B.parseHexPaste('4A 5B 00')], [0x4a, 0x5b, 0]);
  assert.deepEqual([...B.parseHexPaste('{ 0x4A, 0x5B }')], [0x4a, 0x5b]);
  assert.deepEqual([...B.parseHexPaste('\\x4a\\x5b')], [0x4a, 0x5b]);
  assert.equal(B.parseHexPaste('hello'), null);
  assert.equal(B.parseHexPaste('4A5'), null);
});

test('inspect matches Python struct values', () => {
  const get = (rows, k) => rows.find(r => r[0] === k)[1];
  let r = B.inspect(seq, 0x20, true);
  assert.equal(get(r, 'Offset'), '0x20 (32)');
  assert.equal(get(r, 'uint16'), '513');
  assert.equal(get(r, 'int32'), '67305985');
  assert.equal(get(r, 'int64'), '578437695752307201');
  assert.equal(get(r, 'GUID'), '{04030201-0605-0807-090A-0B0C0D0E0F10}');
  assert.equal(get(r, 'Binary'), '00000001');
  r = B.inspect(seq, 0, false);
  assert.equal(get(r, 'uint16'), '258');
  assert.equal(get(r, 'uint32'), '16909060');
  assert.equal(get(r, 'uint64'), '72623859790382856');
  r = B.inspect(Uint8Array.from(Buffer.from('0000803fdb0f4940', 'hex')), 0, true);
  assert.equal(get(r, 'float32'), '1');
  r = B.inspect(Uint8Array.from(Buffer.from('182d4454fb210940', 'hex')), 0, true);
  assert.equal(get(r, 'float64'), '3.14159265');
  r = B.inspect(Uint8Array.from([0xe5, 0x8e, 0x26]), 0, true);
  assert.equal(get(r, 'ULEB128'), '624485 (3 bytes)');
  r = B.inspect(Uint8Array.from([0xc0, 0xbb, 0x78]), 0, true);
  assert.equal(get(r, 'SLEB128'), '-123456 (3 bytes)');
  r = B.inspect(Uint8Array.from([0x00, 0x00, 0x00, 0x00]), 0, true);
  assert.equal(get(r, 'Unix time 32'), '1970-01-01T00:00:00Z');
  assert.equal(get(r, 'int64'), '');
  r = B.inspect(Uint8Array.from([0xe2, 0x82, 0xac]), 0, true);
  assert.equal(get(r, 'UTF-8 char'), '€ U+20AC');
  assert.deepEqual(B.inspect(new Uint8Array(0), 5, true), [['Offset', '0x5 (5)']]);
});

test('textCells: ascii, utf8 multi-byte, utf16, ebcdic, glyphs', () => {
  const t = (bytes, enc, start = 0, g = false) => B.textCells(Uint8Array.from(bytes), bytes.length, enc, start, g).map(c => c.ch).join('');
  assert.equal(t([0x48, 0x69, 0x00, 0x0a, 0xe9], 'ascii'), 'Hi...');
  assert.equal(t([0x48, 0x69, 0x00, 0x0a], 'ascii', 0, true), 'Hi␀␊');
  assert.equal(t([0x48, 0xe9], 'latin1'), 'Hé');
  assert.equal(t([0x48, 0xc3, 0xa9, 0x21], 'utf8'), 'Hé !');
  assert.equal(t([0xa9, 0x21], 'utf8'), ' !'); // continuation at the row start
  assert.equal(t([0x48, 0x00, 0x69, 0x00], 'utf16le'), 'H i ');
  assert.equal(t([0x00, 0x48, 0x00, 0x69], 'utf16be'), 'H i ');
  assert.equal(t([0x48, 0x00, 0x69], 'utf16le', 1), ' \u6900 '); // odd row start: pairs begin at the second byte
  assert.equal(t([0xc8, 0x85, 0x93, 0x93, 0x96], 'ebcdic'), 'Hello');
  assert.equal(B.byteForChar('A', 'ascii'), 0x41);
  assert.equal(B.byteForChar('é', 'ascii'), -1);
  assert.equal(B.byteForChar('é', 'latin1'), 0xe9);
  assert.equal(B.byteForChar('H', 'ebcdic'), 0xc8);
});

test('detectType names common formats', () => {
  const b = s => Uint8Array.from(Buffer.from(s, 'hex'));
  assert.equal(B.detectType(b('89504e470d0a1a0a0000')), 'PNG image');
  assert.equal(B.detectType(b('504b0304')), 'ZIP archive');
  assert.equal(B.detectType(b('7f454c460201')), 'ELF 64-bit little-endian executable');
  assert.equal(B.detectType(b('cffaedfe')), 'Mach-O 64-bit executable');
  assert.equal(B.detectType(b('cafebabe00000041')), 'Java class file (version 65)');
  assert.equal(B.detectType(b('cafebabe00000002')), 'Mach-O universal binary');
  assert.equal(B.detectType(Uint8Array.from(Buffer.from('SQLite format 3\0'))), 'SQLite database');
  assert.equal(B.detectType(Uint8Array.from(Buffer.from('%PDF-1.7'))), 'PDF document');
  assert.equal(B.detectType(Uint8Array.from(Buffer.from('RIFF\0\0\0\0WAVE'))), 'WAV audio');
  assert.equal(B.detectType(new Uint8Array(0)), '');
});

test('fmtSize and hexOffset', () => {
  assert.equal(B.fmtSize(0), '0 bytes');
  assert.equal(B.fmtSize(1), '1 byte');
  assert.equal(B.fmtSize(4294967296), '4.00 GB');
  assert.equal(B.hexOffset(255), '000000FF');
  assert.equal(B.hexOffset(0x100000000, 8), '100000000');
});
