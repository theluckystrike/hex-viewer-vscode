#!/usr/bin/env python3
"""Make the sample files for the real VS Code check (scripts/e2e-vscode.mjs).

usage: python3 -I scripts/make_samples.py <dir> [--big]

Small real files of common binary types, two text files that must keep opening in the text editor,
hostile files (empty, no read permission, a symlink loop, one to truncate while open) and, with --big,
a 4 GB sparse file (no disk blocks used) and a 200 MB random file. Delete <dir> after the check.
"""
import io, os, shutil, sqlite3, struct, sys, wave, zipfile, math, random

out = sys.argv[1]
big = '--big' in sys.argv
os.makedirs(out, exist_ok=True)
P = lambda n: os.path.join(out, n)

# 1. Mach-O universal binary from the system
shutil.copyfile('/bin/ls', P('ls'))

# 2. PNG: a real image from the 3D model viewer README (any PNG on the machine works)
png_src = os.path.expanduser('~/plugin-market-intel-work/factory/products/model-viewer-vscode/images/robot-arm.png')
shutil.copyfile(png_src, P('robot-arm.png'))

# 3. ZIP with two entries
with zipfile.ZipFile(P('archive.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('readme.txt', 'Hello from a ZIP file.\n' * 20)
    z.writestr('data/numbers.csv', '\n'.join(f'{i},{i*i}' for i in range(200)))

# 4. PDF from the system documentation
for cand in ['/Library/Documentation/License.lpdf/Contents/Resources/en.lproj/License.pdf',
             '/Library/Documentation/License.lpdf/Contents/Resources/English.lproj/License.pdf']:
    if os.path.exists(cand):
        shutil.copyfile(cand, P('license.pdf')); break
else:
    open(P('license.pdf'), 'wb').write(b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

# 5. SQLite database
if os.path.exists(P('inventory.sqlite')): os.remove(P('inventory.sqlite'))
db = sqlite3.connect(P('inventory.sqlite'))
db.execute('create table parts(id integer primary key, name text, qty integer)')
db.executemany('insert into parts(name, qty) values (?, ?)', [(f'part-{i}', i * 3) for i in range(300)])
db.commit(); db.close()

# 6. Java class file (Java 21, major 65): class Hello extends java.lang.Object, no members
def utf8(s): b = s.encode(); return b'\x01' + struct.pack('>H', len(b)) + b
cp = [utf8('Hello'), b'\x07' + struct.pack('>H', 1), utf8('java/lang/Object'), b'\x07' + struct.pack('>H', 3), utf8('SourceFile'), utf8('Hello.java')]
cls = b'\xca\xfe\xba\xbe' + struct.pack('>HH', 0, 65) + struct.pack('>H', len(cp) + 1) + b''.join(cp)
cls += struct.pack('>HHHHHHH', 0x0021, 2, 4, 0, 0, 0, 1) + struct.pack('>HIH', 5, 2, 6)
open(P('Hello.class'), 'wb').write(cls)

# 7. WAV: 0.5 s of a 440 Hz tone, 16-bit mono
with wave.open(P('tone.wav'), 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)
    w.writeframes(b''.join(struct.pack('<h', int(12000 * math.sin(2 * math.pi * 440 * i / 22050))) for i in range(11025)))

# 8. ELF: a minimal x86-64 Linux executable that exits with code 42
code = bytes.fromhex('b83c000000bf2a0000000f05')  # mov eax,60; mov edi,42; syscall
ehdr = struct.pack('<4sBBBBB7sHHIQQQIHHHHHH', b'\x7fELF', 2, 1, 1, 0, 0, b'\0' * 7, 2, 0x3e, 1, 0x400078, 64, 0, 0, 64, 56, 1, 0, 0, 0)
phdr = struct.pack('<IIQQQQQQ', 1, 5, 0, 0x400000, 0x400000, 0x78 + len(code), 0x78 + len(code), 0x1000)
open(P('exit42.elf'), 'wb').write(ehdr + phdr + code)

# 9. UTF-16 LE text with a BOM
open(P('notes-utf16.txt.bin'), 'wb').write('﻿Hello UTF-16 – café 中文\r\n'.encode('utf-16-le') * 8)

# 10. firmware.bin: 512 KB of pseudo-random bytes, a 6-byte marker across the 64 KB edge at 0x2FFFD,
#     and known values at 0x100 for the data inspector check. Opens in Hex Viewer by default (.bin).
rnd = random.Random(1234)
fw = bytearray(rnd.getrandbits(8) for _ in range(512 * 1024))
fw[0x2FFFD:0x30003] = bytes.fromhex('DEADBEEF1337')
fw[0x100:0x110] = struct.pack('<IhQxx', 0x12345678, -2, 1700000000)
fw[0x200:0x208] = struct.pack('<d', 3.141592653589793)
fw[0x300:0x310] = bytes(range(1, 17))
open(P('firmware.bin'), 'wb').write(fw)

# text files that must still open in the text editor
open(P('readme.txt'), 'w').write('This file must open in the text editor, not in Hex Viewer.\n')
open(P('main.ts'), 'w').write('export const answer: number = 42;\n')

# hostile files
open(P('empty.bin'), 'wb').close()
if os.path.exists(P('locked.bin')): os.chmod(P('locked.bin'), 0o644)
open(P('locked.bin'), 'wb').write(b'secret bytes')
os.chmod(P('locked.bin'), 0)
if not os.path.lexists(P('loop.bin')):
    os.symlink('loop.bin', P('loop.bin'))
open(P('shrinks.bin'), 'wb').write(bytes(rnd.getrandbits(8) for _ in range(64 * 1024)) * 160)  # 10 MB

if big:
    # 4 GB sparse file: a marker at 0xFFFFFFF0 and at the very end
    size = 4 * 1024 ** 3 + 64
    with open(P('big4g.bin'), 'wb') as f:
        f.truncate(size)
        f.seek(0xFFFFFFF0); f.write(b'NEAR-THE-4GB-EDGE')
        f.seek(size - 8); f.write(b'LASTBYTE')
    # 200 MB random file, written in 4 MB pieces
    with open(P('random200m.bin'), 'wb') as f:
        for _ in range(50):
            f.write(os.urandom(4 * 1024 * 1024))
        f.seek(200 * 1024 * 1024 - 1000); f.write(b'NEEDLE-AT-THE-END')
print('samples in', out)
for n in sorted(os.listdir(out)):
    p = P(n)
    print(f'{n:22s}', 'symlink' if os.path.islink(p) else os.lstat(p).st_size)
