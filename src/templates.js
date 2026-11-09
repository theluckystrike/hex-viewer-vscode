'use strict';
// The built-in binary templates (templates/*.json), bundled into the extension by esbuild.
const BUILTIN = [
  require('../templates/png.json'),
  require('../templates/jpeg.json'),
  require('../templates/gif.json'),
  require('../templates/bmp.json'),
  require('../templates/ico.json'),
  require('../templates/tiff.json'),
  require('../templates/webp.json'),
  require('../templates/wav.json'),
  require('../templates/flac.json'),
  require('../templates/mp4.json'),
  require('../templates/zip.json'),
  require('../templates/gzip.json'),
  require('../templates/tar.json'),
  require('../templates/pdf.json'),
  require('../templates/sqlite.json'),
  require('../templates/elf.json'),
  require('../templates/pe.json'),
  require('../templates/macho.json'),
  require('../templates/class.json'),
  require('../templates/pcap.json'),
];

module.exports = { BUILTIN };
