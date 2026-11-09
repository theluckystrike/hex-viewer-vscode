#!/usr/bin/env python3
"""One small real file per built-in binary template, for test/template.test.js and the real VS Code check.

usage: python3 -I scripts/make_template_samples.py <dir>

Uses only the Python standard library and macOS tools (sips, afconvert, lipo) when they exist; files that
need a missing tool are skipped. Delete <dir> after the check.
"""
import gzip, io, math, os, shutil, sqlite3, struct, subprocess, sys, tarfile, wave, zipfile, zlib

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
P = lambda n: os.path.join(out, n)


def run(*a):
    try:
        return subprocess.run(a, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60).returncode == 0
    except Exception:
        return False


# PNG 3x2 RGB with a tEXt chunk, made by hand (exact values for the test)
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
raw = b''.join(b'\0' + bytes([x * 40, y * 90, 200]) * 1 + bytes([10, 20, 30]) * 2 for y in range(2) for x in range(1))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 3, 2, 8, 2, 0, 0, 0)) + chunk(b'tEXt', b'Comment\0made for Hex Viewer') \
    + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open(P('sample.png'), 'wb').write(png)

# JPEG, GIF, BMP, TIFF from the PNG with sips (macOS)
for fmt, ext in [('jpeg', 'jpg'), ('gif', 'gif'), ('bmp', 'bmp'), ('tiff', 'tiff')]:
    run('sips', '-s', 'format', fmt, P('sample.png'), '--out', P('sample.' + ext))

# ICO with one PNG image and one BMP (DIB) image
dib = struct.pack('<IiiHHIIiiII', 40, 1, 2, 1, 32, 0, 4, 0, 0, 0, 0) + b'\x10\x20\x30\xff' + b'\0\0\0\0'
ico_hdr = struct.pack('<HHH', 0, 1, 2)
off1 = 6 + 16 * 2
off2 = off1 + len(png)
ico = ico_hdr + struct.pack('<BBBBHHII', 3, 2, 0, 0, 1, 32, len(png), off1) + struct.pack('<BBBBHHII', 1, 1, 0, 0, 1, 32, len(dib), off2) + png + dib
open(P('sample.ico'), 'wb').write(ico)

# WebP (lossy header layout; the VP8 bitstream bytes are filler)
vp8 = bytes([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 3, 0, 2, 0]) + b'\0' * 7
vp8x = bytes([0x10, 0, 0, 0]) + (2).to_bytes(3, 'little') + (1).to_bytes(3, 'little')
body = b'WEBP' + b'VP8X' + struct.pack('<I', len(vp8x)) + vp8x + b'VP8 ' + struct.pack('<I', len(vp8)) + vp8 + b'\0'
open(P('sample.webp'), 'wb').write(b'RIFF' + struct.pack('<I', len(body)) + body)

# WAV: 0.1 s, 16-bit stereo 8000 Hz
with wave.open(P('sample.wav'), 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(b''.join(struct.pack('<hh', int(9000 * math.sin(i / 5)), 0) for i in range(800)))

# FLAC and M4A (MP4 boxes) with afconvert (macOS)
run('afconvert', '-f', 'flac', '-d', 'flac', P('sample.wav'), P('sample.flac'))
run('afconvert', '-f', 'm4af', '-d', 'aac', P('sample.wav'), P('sample.m4a'))
if not os.path.exists(P('sample.flac')):
    si = struct.pack('>HH', 4096, 4096) + (0).to_bytes(3, 'big') * 2 + ((8000 << 44) | (1 << 41) | (15 << 36) | 800).to_bytes(8, 'big') + b'\0' * 16
    open(P('sample.flac'), 'wb').write(b'fLaC' + bytes([0x80]) + len(si).to_bytes(3, 'big') + si + b'\xff\xf8' + b'\0' * 10)

# ZIP with two entries and a comment
with zipfile.ZipFile(P('sample.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('readme.txt', 'Hello from a ZIP file.\n' * 20)
    z.writestr('data/numbers.csv', '\n'.join(f'{i},{i*i}' for i in range(200)))
    z.comment = b'sample comment'

# GZIP with a file name
with open(P('sample.txt.gz'), 'wb') as f:
    with gzip.GzipFile(filename='notes.txt', mode='wb', fileobj=f, mtime=1700000000) as g:
        g.write(b'gzip body ' * 100)

# TAR with a file and a folder
with tarfile.open(P('sample.tar'), 'w', format=tarfile.USTAR_FORMAT) as t:
    info = tarfile.TarInfo('docs/'); info.type = tarfile.DIRTYPE; info.mtime = 1700000000; t.addfile(info)
    data = b'tar member data\n' * 50
    info = tarfile.TarInfo('docs/a.txt'); info.size = len(data); info.mtime = 1700000000; t.addfile(info, io.BytesIO(data))

# PDF with a classic xref table (offsets computed)
objs = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>']
pdf = bytearray(b'%PDF-1.4\n')
offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(pdf)); pdf += b'%d 0 obj\n' % i + o + b'\nendobj\n'
xref = len(pdf)
pdf += b'xref\n0 %d\n' % (len(objs) + 1) + b'0000000000 65535 f \n' + b''.join(b'%010d 00000 n \n' % o for o in offs)
pdf += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
open(P('sample.pdf'), 'wb').write(bytes(pdf))

# SQLite database
if os.path.exists(P('sample.sqlite')): os.remove(P('sample.sqlite'))
db = sqlite3.connect(P('sample.sqlite'))
db.execute('pragma page_size = 4096')
db.execute('create table parts(id integer primary key, name text)')
db.executemany('insert into parts(name) values (?)', [(f'part-{i}',) for i in range(50)])
db.commit(); db.close()

# ELF x86-64 with program header and 3 sections (NULL, .text, .shstrtab)
code = bytes.fromhex('b83c000000bf2a0000000f05')
shstr = b'\0.text\0.shstrtab\0'
text_off = 64 + 56
shstr_off = text_off + len(code)
sh_off = shstr_off + len(shstr)
sh_off += (8 - sh_off % 8) % 8
ehdr = struct.pack('<4sBBBBB7sHHIQQQIHHHHHH', b'\x7fELF', 2, 1, 1, 0, 0, b'\0' * 7, 2, 0x3e, 1, 0x400000 + text_off, 64, sh_off, 0, 64, 56, 1, 64, 3, 2)
phdr = struct.pack('<IIQQQQQQ', 1, 5, 0, 0x400000, 0x400000, sh_off, sh_off, 0x1000)
sh = struct.pack('<IIQQQQIIQQ', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
sh += struct.pack('<IIQQQQIIQQ', 1, 1, 6, 0x400000 + text_off, text_off, len(code), 0, 0, 16, 0)
sh += struct.pack('<IIQQQQIIQQ', 7, 3, 0, 0, shstr_off, len(shstr), 0, 0, 1, 0)
elf = ehdr + phdr + code + shstr
elf += b'\0' * (sh_off - len(elf)) + sh
open(P('sample.elf'), 'wb').write(elf)

# PE32+ (x64) with 2 sections; headers only, enough for the template
dos = bytearray(64); dos[0:2] = b'MZ'; struct.pack_into('<I', dos, 0x3c, 0x80)
stub = dos + b'\0' * (0x80 - 64)
coff = struct.pack('<HHIIIHH', 0x8664, 2, 1700000000, 0, 0, 240, 0x22)
opt = struct.pack('<HBBIIIII', 0x20b, 14, 0, 0x200, 0x200, 0, 0x1000, 0x1000) + struct.pack('<Q', 0x140000000)
opt += struct.pack('<IIHHHHHHIIIIHH', 0x1000, 0x200, 6, 0, 0, 0, 6, 0, 0, 0x3000, 0x400, 0, 3, 0x8160)
opt += struct.pack('<QQQQII', 0x100000, 0x1000, 0x100000, 0x1000, 0, 16) + struct.pack('<II', 0x2000, 0x40) + b'\0' * 8 * 15
assert len(opt) == 240, len(opt)
secs = struct.pack('<8sIIIIIIHHI', b'.text', 0x10, 0x1000, 0x200, 0x400, 0, 0, 0, 0, 0x60000020)
secs += struct.pack('<8sIIIIIIHHI', b'.rdata', 0x40, 0x2000, 0x200, 0x600, 0, 0, 0, 0, 0x40000040)
pe = bytes(stub) + b'PE\0\0' + coff + opt + secs
pe += b'\0' * (0x400 - len(pe)) + b'\xc3' + b'\0' * 0x1ff + b'\0' * 0x200
open(P('sample.exe'), 'wb').write(pe)

# Mach-O: universal binary from the system, and one thin slice
shutil.copyfile('/bin/ls', P('ls-universal'))
if not run('lipo', '-thin', 'arm64', '/bin/ls', '-output', P('ls-arm64')):
    run('lipo', '-thin', 'x86_64', '/bin/ls', '-output', P('ls-arm64'))

# Java class (Java 21) with a long constant (takes two constant pool slots) and one field
def utf8(s): b = s.encode(); return b'\x01' + struct.pack('>H', len(b)) + b
cp = [utf8('Hello'), b'\x07' + struct.pack('>H', 1), utf8('java/lang/Object'), b'\x07' + struct.pack('>H', 3),
      b'\x05' + struct.pack('>q', 1 << 40), utf8('answer'), utf8('J'), utf8('SourceFile'), utf8('Hello.java')]
# slots: 1 Hello, 2 Class, 3 Object, 4 Class, 5-6 Long, 7 answer, 8 J, 9 SourceFile, 10 Hello.java
cls = b'\xca\xfe\xba\xbe' + struct.pack('>HH', 0, 65) + struct.pack('>H', 11) + b''.join(cp)
cls += struct.pack('>HHHH', 0x0021, 2, 4, 0)
cls += struct.pack('>H', 1) + struct.pack('>HHHH', 0x0019, 7, 8, 0)
cls += struct.pack('>H', 0) + struct.pack('>H', 1) + struct.pack('>HIH', 9, 2, 10)
open(P('Hello.class'), 'wb').write(cls)

# PCAP, little-endian, Ethernet, 2 packets
pc = struct.pack('<IHHiIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1)
for i, n in enumerate([60, 74]):
    pc += struct.pack('<IIII', 1700000000 + i, 1000 * i, n, n) + bytes((i + k) & 255 for k in range(n))
open(P('sample.pcap'), 'wb').write(pc)

print('\n'.join(sorted(os.listdir(out))))
