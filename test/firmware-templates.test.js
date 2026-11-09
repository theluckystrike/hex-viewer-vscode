'use strict';
// EXEC13 (0.3.4): the firmware and reverse-engineering templates (UF2, device tree blob, U-Boot uImage, Android
// boot.img, WebAssembly, DEX), the deeper ELF tables (symbols, dynamic) and PE imports and resources, and addr().
// Every sample is built here from the public format specs, byte by byte, in memory (each well under 50 KB).
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/core/template.js');
const { evaluate } = require('../src/core/expr.js');
const { HexDocument } = require('../src/core/doc.js');
const { BUILTIN } = require('../src/templates.js');

const mem = bytes => HexDocument.fromBytes(Uint8Array.from(bytes), null);
const byId = id => BUILTIN.find(t => t.id === id);
const errors = root => { const out = []; const walk = n => { if (n.error) out.push(`${n.name}: ${n.error}`); (n.children || []).forEach(walk); }; walk(root); return out; };
const top = r => r.root.children.map(c => c.name);

// ---------- a small byte writer ----------
class W {
  constructor(le = true) { this.le = le; this.a = []; }
  get pos() { return this.a.length; }
  u8(v) { this.a.push(v & 255); return this; }
  u16(v) { const b = Buffer.alloc(2); this.le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); this.a.push(...b); return this; }
  u32(v) { const b = Buffer.alloc(4); this.le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); this.a.push(...b); return this; }
  i32(v) { const b = Buffer.alloc(4); this.le ? b.writeInt32LE(v) : b.writeInt32BE(v); this.a.push(...b); return this; }
  u64(v) { const b = Buffer.alloc(8); this.le ? b.writeBigUInt64LE(BigInt(v)) : b.writeBigUInt64BE(BigInt(v)); this.a.push(...b); return this; }
  bytes(x) { this.a.push(...(typeof x === 'string' ? Buffer.from(x, 'latin1') : x)); return this; }
  fixed(s, n) { const b = Buffer.alloc(n); Buffer.from(s, 'latin1').copy(b); return this.bytes(b); }
  zero(n) { for (let i = 0; i < n; i++) this.a.push(0); return this; }
  padTo(n) { if (this.pos > n) throw new Error(`past ${n}: ${this.pos}`); return this.zero(n - this.pos); }
  align(n) { return this.zero((n - (this.pos % n)) % n); }
  set32(at, v) { const b = Buffer.alloc(4); this.le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); for (let i = 0; i < 4; i++) this.a[at + i] = b[i]; }
  buf() { return Buffer.from(this.a); }
}
const uleb = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };

// ---------- samples ----------
function uf2() {
  const w = new W();
  for (let i = 0; i < 3; i++) {
    w.u32(0x0A324655).u32(0x9E5D5157).u32(0x2000).u32(0x10000000 + 256 * i).u32(256).u32(i).u32(3).u32(0xE48BFF56);
    for (let k = 0; k < 256; k++) w.u8(i + k);
    w.zero(476 - 256).u32(0x0AB16F30);
  }
  return w.buf();
}

function fdt() {
  const strings = []; const strOff = s => { let o = 0; for (const x of strings) { if (x === s) return o; o += x.length + 1; } strings.push(s); return o; };
  const st = new W(false);
  const prop = (name, val) => { st.u32(3).u32(val.length).u32(strOff(name)).bytes(val); st.align(4); };
  const be32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  st.u32(1).bytes('\0'); st.align(4);
  prop('compatible', Buffer.from('acme,board\0', 'latin1'));
  prop('#address-cells', be32(1));
  st.u32(4); // a NOP between properties
  st.u32(1).bytes('cpus\0'); st.align(4);
  st.u32(1).bytes('cpu@0\0'); st.align(4);
  prop('reg', be32(0));
  prop('status', Buffer.from('okay\0', 'latin1'));
  st.u32(2); st.u32(2); st.u32(2); st.u32(9);
  const strBlock = Buffer.from(strings.map(s => s + '\0').join(''), 'latin1');
  const w = new W(false);
  const rsv = 40, sOff = rsv + 32, strAt = sOff + st.pos;
  w.u32(0xD00DFEED).u32(strAt + strBlock.length).u32(sOff).u32(strAt).u32(rsv).u32(17).u32(16).u32(0).u32(strBlock.length).u32(st.pos);
  w.u64(0x80000000).u64(0x1000).u64(0).u64(0);
  w.bytes(st.buf()).bytes(strBlock);
  return w.buf();
}

function uimage(multi) {
  const parts = multi ? [Buffer.alloc(10, 0xAA), Buffer.alloc(6, 0xBB)] : [Buffer.alloc(100, 0x1F)];
  const body = new W(false);
  if (multi) { for (const p of parts) body.u32(p.length); body.u32(0); for (const p of parts) { body.bytes(p); body.align(4); } }
  else body.bytes(parts[0]);
  const w = new W(false);
  w.u32(0x27051956).u32(0x12345678).u32(1700000000).u32(body.pos).u32(0x80008000).u32(0x80008000).u32(0xCAFEF00D);
  w.u8(5).u8(2).u8(multi ? 4 : 2).u8(multi ? 0 : 1).fixed(multi ? 'multi' : 'Linux-6.6', 32);
  return Buffer.concat([w.buf(), body.buf()]);
}

const osVersion = (a, b, c, y, m) => ((a << 25) | (b << 18) | (c << 11) | ((y - 2000) << 4) | m) >>> 0;
function bootV0() {
  const w = new W();
  w.fixed('ANDROID!', 8).u32(100).u32(0x10008000).u32(50).u32(0x11000000).u32(0).u32(0).u32(0x10000100).u32(2048).u32(0).u32(osVersion(11, 0, 0, 2024, 5));
  w.fixed('test', 16).fixed('console=ttyS0', 512).zero(32).fixed('', 1024);
  w.padTo(2048).bytes(Buffer.alloc(100, 0x4B)).padTo(4096).bytes(Buffer.alloc(50, 0x52)).padTo(6144);
  return w.buf();
}
function bootV3() {
  const w = new W();
  w.fixed('ANDROID!', 8).u32(200).u32(300).u32(osVersion(13, 0, 0, 2023, 11)).u32(1580).zero(16).u32(3).fixed('androidboot.hardware=acme', 1536);
  w.padTo(4096).bytes(Buffer.alloc(200, 0x4B)).padTo(8192).bytes(Buffer.alloc(300, 0x52)).padTo(12288);
  return w.buf();
}

function wasm() {
  const sec = (id, body) => [id, ...uleb(body.length), ...body];
  const name = s => [...uleb(s.length), ...Buffer.from(s)];
  const out = [0x00, 0x61, 0x73, 0x6D, 1, 0, 0, 0];
  out.push(...sec(1, [2, 0x60, 1, 0x7F, 0, 0x60, 0, 1, 0x7F]));
  out.push(...sec(2, [1, ...name('env'), ...name('log'), 0, 0]));
  out.push(...sec(3, [1, 1]));
  out.push(...sec(5, [1, 1, 1, 2]));
  out.push(...sec(7, [2, ...name('main'), 0, 1, ...name('mem'), 2, 0]));
  out.push(...sec(10, [1, 4, 0, 0x41, 0x2A, 0x0B]));
  out.push(...sec(0, [...name('producers'), 1, 2, 3]));
  return Buffer.from(out);
}

function dex() {
  const strs = ['<init>', 'LHello;', 'Ljava/lang/Object;', 'V', 'main'];
  const w = new W();
  w.fixed('dex\n035', 8).u32(0).zero(20).u32(0).u32(0x70).u32(0x12345678).u32(0).u32(0);
  const fix = {};
  const slot = name => { fix[name] = w.pos; w.u32(0); };
  slot('map_off');
  w.u32(strs.length).u32(0x70); w.u32(2).u32(0x84); w.u32(1).u32(0x8C); w.u32(0).u32(0); w.u32(2).u32(0x98); w.u32(1).u32(0xA8);
  slot('data_size'); slot('data_off');
  w.padTo(0x70);
  const strIdsAt = w.pos; for (let i = 0; i < strs.length; i++) w.u32(0);
  w.u32(1).u32(2); // type_ids: LHello; and Ljava/lang/Object;
  w.u32(3).u32(0).u32(0); // proto_ids: shorty "V"
  w.u16(0).u16(0).u32(4).u16(0).u16(0).u32(0); // method_ids: main, <init>
  w.u32(0).u32(1).u32(1).u32(0).u32(0xFFFFFFFF).u32(0).u32(0).u32(0); // class_defs: public class LHello; extends Object
  const dataAt = w.pos;
  strs.forEach((s, i) => { w.set32(strIdsAt + 4 * i, w.pos); w.bytes(uleb(s.length)).bytes(s).u8(0); });
  w.align(4);
  const mapAt = w.pos;
  const items = [[0x0, 1, 0], [0x1, strs.length, 0x70], [0x2, 2, 0x84], [0x3, 1, 0x8C], [0x5, 2, 0x98], [0x6, 1, 0xA8], [0x2002, strs.length, dataAt], [0x1000, 1, mapAt]];
  w.u32(items.length); for (const [t, n, o] of items) w.u16(t).u16(0).u32(n).u32(o);
  w.set32(fix.map_off, mapAt); w.set32(fix.data_size, w.pos - dataAt); w.set32(fix.data_off, dataAt);
  w.set32(32, w.pos); // file_size
  return w.buf();
}

/** An ELF shared object with .dynsym/.dynstr/.dynamic and .symtab/.strtab, 32 or 64-bit, either byte order. */
function elf(is64, le) {
  const w = new W(le);
  const ehsize = is64 ? 64 : 52, shentsize = is64 ? 64 : 40, symsize = is64 ? 24 : 16, dynsize = is64 ? 16 : 8;
  const dynstr = '\0libc.so.6\0libfoo.so\0main\0puts\0';
  const strtab = '\0local_helper\0main\0';
  const shstr = '\0.text\0.dynstr\0.dynsym\0.dynamic\0.strtab\0.symtab\0.shstrtab\0';
  const nameOf = (tab, s) => tab.indexOf('\0' + s + '\0') + 1;
  const sym = (b, name, info, shndx, value, size) => {
    if (is64) b.u32(name).u8(info).u8(0).u16(shndx).u64(value).u64(size);
    else b.u32(name).u32(value).u32(size).u8(info).u8(0).u16(shndx);
  };
  const dyn = (b, tag, val) => { if (is64) b.u64(tag).u64(val); else b.i32(tag).u32(val); };
  const blobs = [];
  const add = (name, buf) => { blobs.push({ name, buf }); };
  add('.text', Buffer.from('c3909090', 'hex'));
  add('.dynstr', Buffer.from(dynstr, 'latin1'));
  let b = new W(le); sym(b, 0, 0, 0, 0, 0); sym(b, nameOf(dynstr, 'puts'), 0x12, 0, 0, 0); sym(b, nameOf(dynstr, 'main'), 0x12, 1, 0x1000, 4); add('.dynsym', b.buf());
  b = new W(le); dyn(b, 1, nameOf(dynstr, 'libc.so.6')); dyn(b, 14, nameOf(dynstr, 'libfoo.so')); dyn(b, 0, 0); add('.dynamic', b.buf());
  add('.strtab', Buffer.from(strtab, 'latin1'));
  b = new W(le); sym(b, 0, 0, 0, 0, 0); sym(b, nameOf(strtab, 'local_helper'), 0x02, 1, 0x1002, 1); sym(b, nameOf(strtab, 'main'), 0x12, 1, 0x1000, 4); add('.symtab', b.buf());
  add('.shstrtab', Buffer.from(shstr, 'latin1'));
  w.zero(ehsize);
  for (const x of blobs) { w.align(8); x.off = w.pos; w.bytes(x.buf); }
  w.align(8);
  const shoff = w.pos;
  const idx = n => blobs.findIndex(x => x.name === n) + 1;
  const sh = (name, type, x, link, info, entsize) => {
    const flags = 0;
    if (is64) w.u32(name).u32(type).u64(flags).u64(0).u64(x ? x.off : 0).u64(x ? x.buf.length : 0).u32(link).u32(info).u64(x ? 8 : 0).u64(entsize);
    else w.u32(name).u32(type).u32(flags).u32(0).u32(x ? x.off : 0).u32(x ? x.buf.length : 0).u32(link).u32(info).u32(x ? 4 : 0).u32(entsize);
  };
  sh(0, 0, null, 0, 0, 0);
  const types = { '.text': 1, '.dynstr': 3, '.dynsym': 11, '.dynamic': 6, '.strtab': 3, '.symtab': 2, '.shstrtab': 3 };
  const links = { '.dynsym': idx('.dynstr'), '.dynamic': idx('.dynstr'), '.symtab': idx('.strtab') };
  const ent = { '.dynsym': symsize, '.symtab': symsize, '.dynamic': dynsize };
  for (const x of blobs) sh(nameOf(shstr, x.name), types[x.name], x, links[x.name] || 0, x.name === '.symtab' ? 2 : 0, ent[x.name] || 0);
  const h = new W(le);
  h.bytes([0x7F, 0x45, 0x4C, 0x46, is64 ? 2 : 1, le ? 1 : 2, 1, 0]).zero(8);
  h.u16(3).u16(is64 ? 62 : 40).u32(1);
  if (is64) h.u64(0x1000).u64(0).u64(shoff); else h.u32(0x1000).u32(0).u32(shoff);
  h.u32(0).u16(ehsize).u16(0).u16(0).u16(shentsize).u16(blobs.length + 1).u16(idx('.shstrtab'));
  const out = w.buf();
  h.buf().copy(out, 0);
  return out;
}

/** A PE32+ DLL with an import table (KERNEL32.dll: ExitProcess by name, ordinal 16) and a resource directory. */
function pe() {
  const w = new W();
  w.fixed('MZ', 2).padTo(0x3C).u32(0x80).padTo(0x80);
  w.fixed('PE\0\0', 4).u16(0x8664).u16(2).u32(1700000000).u32(0).u32(0).u16(240).u16(0x2022);
  w.u16(0x20B).u8(14).u8(0).u32(0x200).u32(0x200).u32(0).u32(0x1000).u32(0x1000).u64(0x180000000);
  w.u32(0x1000).u32(0x200).u16(6).u16(0).u16(0).u16(0).u16(6).u16(0).u32(0).u32(0x4000).u32(0x400).u32(0).u16(2).u16(0x160);
  w.u64(0x100000).u64(0x1000).u64(0x100000).u64(0x1000).u32(0).u32(16);
  const dirs = [[0, 0], [0x2000, 40], [0x3000, 0x80]];
  for (let i = 0; i < 16; i++) { const d = dirs[i] || [0, 0]; w.u32(d[0]).u32(d[1]); }
  w.fixed('.rdata', 8).u32(0x200).u32(0x2000).u32(0x200).u32(0x400).u32(0).u32(0).u16(0).u16(0).u32(0x40000040);
  w.fixed('.rsrc', 8).u32(0x200).u32(0x3000).u32(0x200).u32(0x600).u32(0).u32(0).u16(0).u16(0).u32(0x40000040);
  w.padTo(0x400);
  // .rdata at RVA 0x2000: import descriptors, lookup table, address table, DLL name, hint/name
  w.u32(0x2040).u32(0).u32(0).u32(0x2080).u32(0x2060).zero(20);
  w.padTo(0x440); w.u64(0x20A0).u64(0x8000000000000010n).u64(0);
  w.padTo(0x460); w.u64(0x20A0).u64(0x8000000000000010n).u64(0);
  w.padTo(0x480).fixed('KERNEL32.dll', 13);
  w.padTo(0x4A0).u16(0x0123).fixed('ExitProcess', 12);
  w.padTo(0x600);
  // .rsrc at RVA 0x3000: types ICON and VERSION, each with one language-level subdirectory
  w.u32(0).u32(0).u16(4).u16(0).u16(0).u16(2);
  w.u32(3).u32(0x80000020).u32(16).u32(0x80000038);
  w.padTo(0x620).u32(0).u32(0).u16(0).u16(0).u16(0).u16(1).u32(1).u32(0x80000050);
  w.padTo(0x638).u32(0).u32(0).u16(0).u16(0).u16(0).u16(1).u32(1).u32(0x80000068);
  w.padTo(0x800);
  return w.buf();
}

const samples = {
  'firmware.uf2': uf2, 'board.dtb': fdt, 'kernel.uimg': () => uimage(false), 'multi.uimg': () => uimage(true),
  'boot.img': bootV0, 'boot-v3.img': bootV3, 'module.wasm': wasm, 'classes.dex': dex,
  'libfoo.so': () => elf(true, true), 'libfoo-be32.so': () => elf(false, false), 'foo.dll': pe,
};
const want = { 'firmware.uf2': 'uf2', 'board.dtb': 'fdt', 'kernel.uimg': 'uimage', 'multi.uimg': 'uimage', 'boot.img': 'bootimg', 'boot-v3.img': 'bootimg', 'module.wasm': 'wasm', 'classes.dex': 'dex', 'libfoo.so': 'elf', 'libfoo-be32.so': 'elf', 'foo.dll': 'pe' };

async function parsed(file) {
  const bytes = samples[file]();
  assert.ok(bytes.length < 50 * 1024, `${file} is ${bytes.length} bytes`);
  const doc = mem(bytes);
  const found = await T.detect(BUILTIN, doc, file);
  assert.equal(found[0] && found[0].template.id, want[file], `${file}: detected ${found.map(f => f.template.id)}`);
  const r = await T.parse(found[0].template, doc);
  assert.equal(r.error, null, `${file}: ${r.error}`);
  assert.deepEqual(errors(r.root), [], file);
  const walk = n => { assert.ok(n.offset >= 0 && n.offset + n.size <= doc.size, `${file}: ${n.name} ${n.offset}+${n.size}`); (n.children || []).forEach(walk); };
  walk(r.root);
  return { r, j: T.toJson(r.root), doc };
}

// ---------- one test per new template ----------

test('UF2: blocks, family ID and target addresses', async () => {
  const { r, j } = await parsed('firmware.uf2');
  assert.deepEqual(top(r).slice(0, 5), ['flags', 'target_address', 'payload_size', 'num_blocks', 'family_id']);
  assert.equal(r.root.children[4].display, 'Raspberry Pi RP2040 (0xE48BFF56)');
  assert.equal(j.num_blocks, 3);
  assert.equal(j.blocks_in_file, 3);
  assert.equal(j.blocks.length, 3);
  assert.equal(j.blocks[2].target_address, 0x10000200);
  assert.equal(j.blocks[1].block_no, 1);
  assert.equal(j.blocks[0].magic_end, 0x0AB16F30);
  assert.equal(r.root.children.at(-1).children[1].label, '0x10000100');
});

test('device tree blob: header, memory reservations, nodes and properties', async () => {
  const { r, j } = await parsed('board.dtb');
  assert.equal(j.version, 17);
  assert.equal(j.last_comp_version, 16);
  assert.equal(j.memory_reservations.length, 2);
  assert.equal(j.memory_reservations[0].address, 0x80000000);
  const root = r.root.children.find(c => c.name === 'root_node');
  assert.equal(root.label, '/');
  const items = j.root_node.items;
  assert.equal(items[0].prop_name, 'compatible');
  assert.equal(items[0].text, 'acme,board');
  assert.equal(items[1].prop_name, '#address-cells');
  assert.equal(items[1].cell, 1);
  assert.equal(items[2].token, 4); // NOP
  assert.equal(items[3].name, 'cpus');
  assert.equal(items[3].items[0].name, 'cpu@0');
  assert.equal(items[3].items[0].items[1].text, 'okay');
  assert.equal(root.children.find(c => c.name === 'items').children[3].label, 'cpus');
});

test('U-Boot uImage: header values and the image data; a multi-file image lists its parts', async () => {
  const { r, j } = await parsed('kernel.uimg');
  assert.equal(r.root.children.find(c => c.name === 'ih_os').display, 'Linux (0x5)');
  assert.equal(r.root.children.find(c => c.name === 'ih_arch').display, 'ARM (0x2)');
  assert.equal(r.root.children.find(c => c.name === 'ih_comp').display, 'gzip (0x1)');
  assert.equal(j.ih_name, 'Linux-6.6');
  assert.equal(j.ih_size, 100);
  assert.equal(j.ih_load, 0x80008000);
  assert.equal(r.root.children.find(c => c.name === 'data').size, 100);
  const m = (await parsed('multi.uimg')).j;
  assert.deepEqual(m.image_sizes, [10, 6, 0]);
  assert.equal(m.parts.length, 2);
  assert.equal((await parsed('multi.uimg')).r.root.children.find(c => c.name === 'parts').children[1].children[0].size, 6);
});

test('Android boot.img v0 and v3: sizes, Android version, kernel and ramdisk pages', async () => {
  const { r, j } = await parsed('boot.img');
  assert.equal(j.header_version, 0);
  assert.equal(j.page_size, 2048);
  assert.equal(j.kernel_size, 100);
  assert.equal(j.cmdline, 'console=ttyS0');
  assert.equal(j.android_version, '11.0.0');
  assert.equal(j.security_patch, '2024-05');
  const k = r.root.children.find(c => c.name === 'kernel');
  assert.equal(k.offset, 2048); assert.equal(k.size, 100);
  assert.equal(r.root.children.find(c => c.name === 'ramdisk').offset, 4096);
  const v3 = await parsed('boot-v3.img');
  assert.equal(v3.j.header_version, 3);
  assert.equal(v3.j.header_size, 1580);
  assert.equal(v3.j.cmdline, 'androidboot.hardware=acme');
  assert.equal(v3.j.android_version, '13.0.0');
  assert.equal(v3.j.security_patch, '2023-11');
  assert.equal(v3.r.root.children.find(c => c.name === 'kernel').offset, 4096);
  assert.equal(v3.r.root.children.find(c => c.name === 'ramdisk').offset, 8192);
  assert.equal(v3.j.page_size, undefined);
});

test('WebAssembly: sections, types, imports, exports and code', async () => {
  const { r, j } = await parsed('module.wasm');
  assert.equal(j.version, 1);
  assert.deepEqual(r.root.children[2].children.map(s => s.label), ['type', 'import', 'function', 'memory', 'export', 'code', 'custom']);
  const body = id => j.sections.find(s => s.id === id).body;
  assert.equal(body(1).types[0].params[0], 0x7F);
  assert.equal(body(2).imports[0].module, 'env');
  assert.equal(body(2).imports[0].field, 'log');
  assert.deepEqual(body(7).exports.map(e => e.name), ['main', 'mem']);
  assert.equal(body(7).exports[1].kind, 2);
  assert.equal(body(5).memories[0].max, 2);
  assert.equal(body(10).bodies[0].size_, 4);
  assert.equal(body(0).name, 'producers');
  const imp = r.root.children[2].children[1].children.find(c => c.name === 'body').children[1].children[0];
  assert.equal(imp.label, 'env.log');
});

test('DEX: header, strings, types, methods, class definitions and the map', async () => {
  const { r, j } = await parsed('classes.dex');
  assert.equal(j.magic, 'dex\n035');
  assert.equal(j.endian_tag, 0x12345678);
  assert.equal(j.header_size, 0x70);
  assert.deepEqual(j.string_ids.map(s => s.text), ['<init>', 'LHello;', 'Ljava/lang/Object;', 'V', 'main']);
  assert.deepEqual(j.type_ids.map(t => t.descriptor), ['LHello;', 'Ljava/lang/Object;']);
  assert.deepEqual(j.method_ids.map(m => m.name), ['main', '<init>']);
  assert.equal(j.proto_ids[0].shorty, 'V');
  assert.equal(j.class_defs[0].class_name, 'LHello;');
  assert.equal(r.root.children.find(c => c.name === 'class_defs').children[0].label, 'LHello;');
  assert.deepEqual(r.root.children.find(c => c.name === 'method_ids').children.map(c => c.label), ['main', '<init>']);
  assert.equal(j.map_list.items.length, 8);
  assert.equal(r.root.children.find(c => c.name === 'map_list').children[1].children[6].label, 'string_data_item');
  assert.equal(j.file_size, r.root.children.find(c => c.name === 'file_size').value);
});

// ---------- deeper ELF and PE ----------

test('ELF: symbol tables with names, the dynamic table with NEEDED and SONAME, summary at the top', async () => {
  for (const f of ['libfoo.so', 'libfoo-be32.so']) {
    const { r, j } = await parsed(f);
    assert.deepEqual(top(r), ['e_ident', 'header', 'section_headers', 'file_type', 'machine', 'entry_point', 'program_header_count', 'section_count']);
    assert.match(r.root.children.find(c => c.name === 'file_type').display, /^Shared object \/ PIE/);
    const sec = n => j.section_headers.find(s => s.name === n);
    assert.deepEqual(sec('.dynsym').symbols.map(s => s.name || ''), ['', 'puts', 'main'], f);
    assert.equal(sec('.dynsym').symbol_count, 3);
    assert.deepEqual(sec('.symtab').symbols.map(s => s.name || ''), ['', 'local_helper', 'main'], f);
    assert.equal(sec('.symtab').symbols[2].st_value, 0x1000);
    assert.equal(sec('.symtab').symbols[2].st_size, 4);
    assert.deepEqual(sec('.dynamic').dynamic.map(d => d.d_tag), [1, 14, 0]);
    assert.deepEqual(sec('.dynamic').dynamic.map(d => d.text), ['libc.so.6', 'libfoo.so', undefined]);
    const shdrs = r.root.children.find(c => c.name === 'section_headers');
    const dynsym = shdrs.children.find(s => s.label === '.dynsym');
    const syms = dynsym.children.find(c => c.name === 'symbols');
    assert.equal(syms.children[2].label, 'main');
    assert.match(syms.children[2].children.find(c => c.name === 'bind').display, /^GLOBAL/);
    assert.match(syms.children[2].children.find(c => c.name === 'kind').display, /^FUNC/);
    const dyn = shdrs.children.find(s => s.label === '.dynamic').children.find(c => c.name === 'dynamic');
    assert.deepEqual(dyn.children.map(d => d.label), ['NEEDED', 'SONAME', 'NULL']);
  }
});

test('PE: import table with DLL and function names, resource types, summary at the top', async () => {
  const { r, j } = await parsed('foo.dll');
  assert.deepEqual(top(r), ['dos_header', 'pe', 'kind', 'machine', 'subsystem', 'entry_point_rva', 'section_count', 'imports', 'resources']);
  assert.equal(j.kind, 'DLL');
  assert.equal(r.root.children.find(c => c.name === 'machine').display, 'x64 (0x8664)');
  assert.match(r.root.children.find(c => c.name === 'subsystem').display, /^Windows GUI/);
  assert.equal(j.imports.length, 2);
  assert.equal(j.imports[0].dll, 'KERNEL32.dll');
  const imports = r.root.children.find(c => c.name === 'imports');
  assert.deepEqual(imports.children.map(c => c.label), ['KERNEL32.dll', '(end of the list)']);
  const fns = imports.children[0].children.find(c => c.name === 'functions');
  assert.deepEqual(fns.children.map(c => c.label), ['ExitProcess', 'ordinal 16', '']);
  assert.equal(j.imports[0].functions[0].hint, 0x123);
  assert.equal(j.imports[0].functions[1].ordinal, 16);
  const types = r.root.children.find(c => c.name === 'resources').children.find(c => c.name === 'types');
  assert.deepEqual(types.children.map(c => c.label), ['ICON', 'VERSION']);
  assert.equal(j.resources.types[0].entries.items.length, 1);
  assert.equal(types.children[1].children.find(c => c.name === 'entries').children.find(c => c.name === 'items').children[0].label, 'id 1');
});

test('addr(): maps an address through a table of structs, -1 when nothing covers it', () => {
  const node = (fields) => ({ __node: true, kind: 'struct', vars: new Map(Object.entries(fields).map(([k, v]) => [k, { __node: true, kind: 'value', value: v }])), children: [] });
  const table = { __node: true, kind: 'array', children: [node({ va: 0x1000, vs: 0x200, raw: 0x400 }), node({ va: 0x2000, vs: 0x100, raw: 0x600 })] };
  const scope = {
    lookup: n => { if (n === 'sections') return table; throw new Error('undefined ' + n); },
    member: (o, k) => { if (o.vars && o.vars.has(k)) return o.vars.get(k); throw new Error(`no field ${k}`); },
    pos: () => 0, size: () => 0, peek: () => 0,
  };
  assert.equal(evaluate("addr(sections, 0x1010, 'va', 'vs', 'raw')", scope), 0x410);
  assert.equal(evaluate("addr(sections, 0x20FF, 'va', 'vs', 'raw')", scope), 0x6FF);
  assert.equal(evaluate("addr(sections, 0x2100, 'va', 'vs', 'raw')", scope), -1);
  assert.equal(evaluate("addr(sections, 0x10, 'va', 'vs', 'raw')", scope), -1);
  assert.equal(evaluate("addr(5, 0x1010, 'va', 'vs', 'raw')", scope), -1);
  assert.throws(() => evaluate('addr(sections, 1, va, vs, raw)', scope), /undefined va/);
});

// ---------- hostile input ----------

test('new samples cut short: a plain error or a partial tree, never a throw, every node inside the file', async () => {
  for (const [file, make] of Object.entries(samples)) {
    const full = make();
    for (const cut of [1, 7, 33, 45, Math.floor(full.length / 2), full.length - 3]) {
      if (cut <= 0 || cut >= full.length) continue;
      const doc = mem(full.subarray(0, cut));
      const r = await T.parse(byId(want[file]), doc, { limits: { maxMs: 3000 } });
      assert.ok(r.error === null || typeof r.error === 'string');
      const walk = n => { assert.ok(n.offset >= 0 && n.offset + n.size <= doc.size, `${file} cut ${cut}: ${n.name} ${n.offset}+${n.size} > ${doc.size}`); (n.children || []).forEach(walk); };
      walk(r.root);
      T.toWire(r.root); T.toJson(r.root); T.toC(r.root, file);
    }
  }
});

test('the new templates claim only their own magic: no steal by extension or by other files', async () => {
  // .img and .bin files without a boot.img magic are not claimed by any of the new templates
  const plain = mem(Buffer.alloc(4096, 0x5A));
  for (const name of ['disk.img', 'firmware.bin', 'x.dtbo', 'x.uf2']) {
    const found = await T.detect(BUILTIN, plain, name);
    assert.ok(!found.some(f => ['bootimg', 'fdt', 'uimage', 'wasm', 'dex'].includes(f.template.id) && f.score > 1), `${name}: ${found.map(f => f.template.id + ':' + f.score)}`);
  }
  // every sample is detected as its own format with a magic score, not an extension score
  for (const file of Object.keys(samples)) {
    const found = await T.detect(BUILTIN, mem(samples[file]()), 'unnamed');
    assert.equal(found[0].template.id, want[file], file);
    assert.ok(found[0].score > 1, file);
  }
});
