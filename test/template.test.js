'use strict';
// Binary templates: the 20 built-in templates on real sample files, the expression language, exports,
// and hostile input (truncated and random files, templates that loop, recurse or blow up).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../src/core/template.js');
const { evaluate } = require('../src/core/expr.js');
const { HexDocument } = require('../src/core/doc.js');
const { BUILTIN } = require('../src/templates.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexv-tpl-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
execFileSync('python3', ['-I', path.join(__dirname, '..', 'scripts', 'make_template_samples.py'), tmp], { stdio: 'ignore' });
const mem = bytes => HexDocument.fromBytes(Uint8Array.from(bytes), null);
const open = f => HexDocument.openFile(path.join(tmp, f));
const byId = id => BUILTIN.find(t => t.id === id);
const errors = root => { const out = []; const walk = n => { if (n.error) out.push(`${n.name}: ${n.error}`); (n.children || []).forEach(walk); }; walk(root); return out; };
const find = (node, pathStr) => pathStr.split('.').reduce((n, k) => n && n.children.find(c => c.name === k), node);

test('20 built-in templates, all valid', () => {
  assert.equal(BUILTIN.length, 20);
  assert.equal(new Set(BUILTIN.map(t => t.id)).size, 20);
  for (const t of BUILTIN) assert.deepEqual(T.checkTemplate(t), [], t.id);
});

const expectations = {
  'sample.png': ['png', r => { const ihdr = r.root.children[1].children[0]; assert.equal(ihdr.label, 'IHDR'); const json = T.toJson(r.root); assert.equal(json.chunks[0].data.width, 3); assert.equal(json.chunks[0].data.height, 2); assert.equal(json.chunks[1].data.keyword, 'Comment'); assert.equal(json.chunks.at(-1).type, 'IEND'); }],
  'sample.jpg': ['jpeg', r => { const j = T.toJson(r.root); const sof = j.segments.find(s => s.type === 0xC0); assert.equal(sof.body.width, 3); assert.equal(sof.body.height, 2); assert.equal(j.eoi, 0xFFD9); }],
  'sample.gif': ['gif', r => { const j = T.toJson(r.root); assert.equal(j.width, 3); assert.equal(j.blocks.at(-1).introducer, 0x3B); }],
  'sample.bmp': ['bmp', r => { const j = T.toJson(r.root); assert.equal(j.dib_header.width, 3); assert.equal(Math.abs(j.dib_header.height), 2); }],
  'sample.tiff': ['tiff', r => { const j = T.toJson(r.root); assert.equal(j.body.magic, 42); assert.ok(j.body.ifds[0].entries.some(e => e.tag === 256)); }],
  'sample.ico': ['ico', r => { const j = T.toJson(r.root); assert.equal(j.count, 2); assert.equal(r.root.children.at(-1).children[0].label, 'PNG'); assert.equal(r.root.children.at(-1).children[1].label, 'BMP'); }],
  'sample.webp': ['webp', r => { const j = T.toJson(r.root); assert.deepEqual(j.chunks.map(c => c.fourcc), ['VP8X', 'VP8 ']); assert.equal(j.chunks[0].data.canvas_width_minus_1, 2); }],
  'sample.wav': ['wav', r => { const j = T.toJson(r.root); assert.equal(j.chunks[0].data.channels, 2); assert.equal(j.chunks[0].data.sample_rate, 8000); assert.equal(j.chunks.at(-1).id, 'data'); }],
  'sample.flac': ['flac', r => { const j = T.toJson(r.root); assert.equal(j.metadata[0].data.sample_rate, 8000); assert.ok(j.metadata[0].data.channels >= 1); }],
  'sample.m4a': ['mp4', r => { const j = T.toJson(r.root); assert.equal(j.boxes[0].type, 'ftyp'); assert.ok(j.boxes.some(b => b.type === 'moov')); }],
  'sample.zip': ['zip', r => { const j = T.toJson(r.root); assert.equal(j.end_of_central_directory.total_entries, 2); assert.deepEqual(j.central_directory.map(e => e.name), ['readme.txt', 'data/numbers.csv']); assert.equal(j.local_files[1].name, 'data/numbers.csv'); assert.equal(j.end_of_central_directory.comment, 'sample comment'); }],
  'sample.txt.gz': ['gzip', r => { const j = T.toJson(r.root); assert.equal(j.file_name, 'notes.txt'); assert.equal(j.mtime, 1700000000); assert.equal(j.uncompressed_size_mod_2_32, 1000); }],
  'sample.tar': ['tar', r => { const j = T.toJson(r.root); assert.deepEqual(j.entries.map(e => e.header.name), ['docs/', 'docs/a.txt']); assert.equal(j.entries[1].header.size_bytes, 800); }],
  'sample.pdf': ['pdf', r => { const j = T.toJson(r.root); assert.equal(j.header, '%PDF-1.4'); assert.equal(j.xref.keyword, 'xref'); assert.equal(j.xref.subsections[0].entries.length, 4); assert.equal(j.xref.subsections[0].entries[0].kind, 'f'); assert.equal(j.xref.subsections[0].entries[1].offset, 9); }],
  'sample.sqlite': ['sqlite', r => { const j = T.toJson(r.root); assert.equal(j.header.magic, 'SQLite format 3'); assert.equal(j.header.page_size, 4096); assert.equal(j.header.text_encoding, 1); }],
  'sample.elf': ['elf', r => { const j = T.toJson(r.root); assert.equal(j.header.e_machine, 0x3e); assert.deepEqual(j.section_headers.map(s => s.name || ''), ['', '.text', '.shstrtab']); assert.equal(j.program_headers[0].p_type, 1); }],
  'sample.exe': ['pe', r => { const j = T.toJson(r.root); assert.equal(j.pe.coff.machine, 0x8664); assert.equal(j.pe.optional_header.magic, 0x20b); assert.deepEqual(j.pe.sections.map(s => s.name), ['.text', '.rdata']); assert.equal(r.root.children[1].children[2].children.at(-1).children[1].label, 'Import'); }],
  'ls-universal': ['macho', r => { const j = T.toJson(r.root); assert.ok(j.macho.fat.archs.length >= 1); assert.ok(j.macho.fat.slices[0].header.load_commands.length > 5); }],
  'ls-arm64': ['macho', r => { const j = T.toJson(r.root); assert.ok(j.macho.header.load_commands.some(c => c.cmd === 0x19)); assert.ok(r.root.children[0].children[1].children.at(-1).children.some(c => c.label === 'LC_LOAD_DYLIB')); }],
  'Hello.class': ['class', r => { const j = T.toJson(r.root); assert.equal(j.major_version, 65); assert.equal(j.constant_pool.length, 9); assert.equal(j.constant_pool[5].body.text, 'answer'); assert.equal(j.fields[0].name_index, 7); assert.equal(j.attributes[0].length, 2); }],
  'sample.pcap': ['pcap', r => { const j = T.toJson(r.root); assert.equal(j.capture.link_type, 1); assert.deepEqual(j.capture.packets.map(p => p.incl_len), [60, 74]); }],
};

for (const [file, [id, check]] of Object.entries(expectations)) {
  test(`template ${id} on ${file}`, async t => {
    if (!fs.existsSync(path.join(tmp, file))) return t.skip(`${file} was not made (tool missing)`);
    const doc = await open(file);
    const found = await T.detect(BUILTIN, doc, file);
    assert.equal(found[0] && found[0].template.id, id, `detected ${found.map(f => f.template.id)}`);
    const r = await T.parse(found[0].template, doc);
    assert.equal(r.error, null);
    assert.deepEqual(errors(r.root), []);
    check(r);
    // every node lies inside the file
    const walk = n => { assert.ok(n.offset >= 0 && n.offset + n.size <= doc.size, `${n.name} ${n.offset}+${n.size}`); (n.children || []).forEach(walk); };
    walk(r.root);
    await doc.dispose();
  });
}

test('Java class and Mach-O universal share CA FE BA BE: each picks its own template', async () => {
  for (const [f, id] of [['Hello.class', 'class'], ['ls-universal', 'macho']]) {
    const doc = await open(f);
    assert.equal((await T.detect(BUILTIN, doc, f))[0].template.id, id);
    await doc.dispose();
  }
});

test('truncated files: every template stops with a plain error, no throw, nodes inside the file', async () => {
  for (const [file, [id]] of Object.entries(expectations)) {
    if (!fs.existsSync(path.join(tmp, file))) continue;
    const full = fs.readFileSync(path.join(tmp, file));
    for (const cut of [1, 7, 33, Math.floor(full.length / 2), full.length - 3]) {
      if (cut <= 0 || cut >= full.length) continue;
      const doc = mem(full.subarray(0, cut));
      const r = await T.parse(byId(id), doc, { limits: { maxMs: 3000 } });
      const walk = n => { assert.ok(n.offset >= 0 && n.offset + n.size <= doc.size + 0, `${id} cut ${cut}: ${n.name} ${n.offset}+${n.size} > ${doc.size}`); (n.children || []).forEach(walk); };
      walk(r.root);
      T.toWire(r.root); T.toJson(r.root); T.toC(r.root, file);
    }
  }
});

test('random bytes under every template: bounded time and nodes', async () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (const t of BUILTIN) {
    for (let k = 0; k < 4; k++) {
      const b = new Uint8Array(4096).map(rnd);
      const doc = mem(b);
      const t0 = Date.now();
      const r = await T.parse(t, doc, { limits: { maxMs: 2000, maxNodes: 20000 } });
      assert.ok(Date.now() - t0 < 4000, `${t.id} took ${Date.now() - t0} ms`);
      assert.ok(r.nodes <= 20001);
    }
  }
});

test('hostile templates: recursion, endless lists, huge counts, expression bombs', async () => {
  const doc = mem(new Uint8Array(1024));
  const rec = { name: 'r', structs: { File: [{ name: 'a', type: 'File' }] } };
  let r = await T.parse(rec, doc);
  assert.match(r.error, /nested more than/);
  const endless = { name: 'e', structs: { File: [{ name: 'xs', type: 'Z', until: 'false' }], Z: [{ name: 'n', value: '1' }] } };
  r = await T.parse(endless, doc);
  assert.match(r.root.children[0].error, /empty \(0 bytes\)/);
  const huge = { name: 'h', structs: { File: [{ name: 'xs', type: 'u8', count: 1e12 }] } };
  r = await T.parse(huge, doc);
  assert.match(r.error, /past the end/);
  const many = { name: 'm', structs: { File: [{ name: 'xs', type: 'Z', count: 1e9 }], Z: [{ name: 'n', value: '1' }] } };
  r = await T.parse(many, doc, { limits: { maxNodes: 5000 } });
  assert.match(r.error, /more than 5,000 fields/);
  const bomb = { name: 'b', structs: { File: [{ name: 'x', value: '1' + '+1'.repeat(900) }] } };
  r = await T.parse(bomb, doc);
  assert.equal(r.error, null);
  const deep = { name: 'd', structs: { File: [{ name: 'x', value: '('.repeat(500) + '1' + ')'.repeat(500) }] } };
  r = await T.parse(deep, doc);
  assert.match(r.error, /nested too deep|longer than/);
  const neg = { name: 'n', structs: { File: [{ name: 'x', type: 'bytes', length: '-5' }] } };
  r = await T.parse(neg, doc);
  assert.match(r.error, /negative length/);
  const far = { name: 'f', structs: { File: [{ name: 'x', type: 'u32', at: '0xFFFFFFFFFF' }] } };
  r = await T.parse(far, doc);
  assert.match(r.error, /outside the file/);
  const proto = { name: 'p', structs: { File: [{ name: 'x', value: 'constructor' }] } };
  r = await T.parse(proto, doc);
  assert.match(r.error, /not defined/);
  const slow = { name: 's', structs: { File: [{ name: 'xs', type: 'Z', count: 1e9 }], Z: [{ name: 'n', value: '1' }] } };
  const t0 = Date.now();
  r = await T.parse(slow, doc, { limits: { maxMs: 300, maxNodes: 1e9 } });
  assert.ok(Date.now() - t0 < 2000);
  assert.match(r.error, /longer than/);
  let stop = false;
  setTimeout(() => { stop = true; }, 50);
  r = await T.parse(slow, doc, { shouldStop: () => stop, limits: { maxNodes: 1e9 } });
  assert.equal(r.error, 'Stopped.');
});

test('checkTemplate explains problems in plain words', () => {
  assert.deepEqual(T.checkTemplate(null), ['The template must be a JSON object.']);
  const e = T.checkTemplate({ name: 'x', structs: { File: [{ name: 'a', type: 'nope' }, { type: 'u8' }, { name: 'c', type: 'bytes' }] } });
  assert.ok(e.some(m => /unknown type "nope"/.test(m)));
  assert.ok(e.some(m => /"name" is missing/.test(m)));
  assert.ok(e.some(m => /needs "length"/.test(m)));
  assert.deepEqual(T.checkTemplate({ name: 'x', structs: {} }), ['The root struct "File" is not in "structs".']);
});

test('expressions: arithmetic, bit operations on u64, text, ternary, functions', () => {
  const vals = { a: 10, big: 0x123456789ABCDEF0n, s: 'II' };
  const scope = { lookup: n => { if (n in vals) return vals[n]; throw new Error('undefined ' + n); }, member: () => undefined, pos: () => 5, size: () => 100, peek: () => 0 };
  assert.equal(evaluate('a * 2 + 3', scope), 23);
  assert.equal(evaluate('a // 3', scope), 3);
  assert.equal(evaluate('big & 0xFFFFFFFFF', scope), 0x89ABCDEF0);
  assert.equal(evaluate('big >> 60', scope), 1);
  assert.equal(evaluate("s == 'II' ? 'little' : 'big'", scope), 'little');
  assert.equal(evaluate('align(pos(), 4) + size()', scope), 108);
  assert.equal(evaluate("oct('0000644 ')", scope), 420);
  assert.equal(evaluate("hex(255) + '!'", scope), '0xFF!');
  assert.throws(() => evaluate('a / 0', scope), /Division by zero/);
  assert.throws(() => evaluate('process.exit()', scope), /Unexpected|Unknown function|undefined/);
  assert.throws(() => evaluate('a ; b', scope), /Unexpected character/);
});

test('exports: JSON values and C declarations with an initializer', async () => {
  const doc = await open('sample.png');
  const r = await T.parse(byId('png'), doc);
  const json = T.toJson(r.root);
  assert.equal(JSON.parse(JSON.stringify(json)).chunks[0].data.width, 3);
  const c = T.toC(r.root.children[1].children[0], 'sample.png');
  assert.match(c, /#pragma pack\(push, 1\)/);
  assert.match(c, /typedef struct IHDR \{\n    uint32_t width; \/\* 0x10 \*\//);
  assert.match(c, /static const Chunk sample = \{/);
  assert.match(c, /"IHDR"/);
  const whole = T.toC(r.root, 'sample.png');
  assert.match(whole, /elements differ in layout/); // chunks have different bodies
  const wire = T.toWire(r.root);
  assert.equal(wire.c[1].c[0].l, 'IHDR');
  await doc.dispose();
});

test('JSONC template files: comments and trailing commas', () => {
  const t = T.parseJsonc('{ // note\n "name": "a, }", /* block */ "structs": { "File": [ { "name": "x", "type": "u8", }, ], }, }');
  assert.equal(t.name, 'a, }');
  assert.equal(t.structs.File[0].type, 'u8');
});

test('unsaved edits show in the parse (reads go through the document)', async () => {
  const doc = await open('sample.png');
  await doc.overwrite(0x10, Uint8Array.of(0, 0, 0, 9));
  const r = await T.parse(byId('png'), doc);
  assert.equal(T.toJson(r.root).chunks[0].data.width, 9);
  await doc.dispose();
});

test('a 4 GB sparse file: the template reads only what it needs', async () => {
  const f = path.join(tmp, 'big.zip');
  const fd = fs.openSync(f, 'w');
  fs.ftruncateSync(fd, 4 * 1024 ** 3 + 100);
  fs.writeSync(fd, Buffer.from('504B0304', 'hex'), 0, 4, 0);
  fs.closeSync(fd);
  const doc = await HexDocument.openFile(f);
  const t0 = Date.now();
  const r = await T.parse(byId('zip'), doc);
  assert.ok(Date.now() - t0 < 3000);
  assert.match(r.error, /was not found in the last 65,557 bytes/);
  await doc.dispose();
  fs.rmSync(f);
});
