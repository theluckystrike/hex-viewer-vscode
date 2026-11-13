# Hex Viewer & Binary Viewer, Hex Editor (Large Files)

![License MIT](https://img.shields.io/badge/license-MIT-blue)
![Works offline](https://img.shields.io/badge/network-none-green)
![Any file size](https://img.shields.io/badge/files-4%20GB%2B-orange)

Free, no sign-in, works offline. See and edit the bytes of any file in VS Code, from a 0-byte file to a 4 GB disk image, with go to offset, search, a data inspector and copy as hex, C array, Python bytes or base64.

![A PNG file open in Hex Viewer inside VS Code. Bytes 0x10 to 0x13 of the IHDR chunk are selected, and the data inspector on the right reads them as big-endian uint32 1400, the image width. The toolbar has Go to offset, Find with Hex, Text and UTF-16 modes, bytes per row, the text encoding and Copy as. The status line shows the offset, the selection, PNG image, 134.5 KB and Overwrite.](https://github.com/theluckystrike/hex-viewer-vscode/raw/HEAD/images/hex-viewer-png.png)

*Real output from VS Code 1.142 on macOS. The file is `robot-arm.png`. `scripts/e2e-vscode.mjs` installed the packaged extension in a clean VS Code profile, opened the file and saved the window through the debug port.*

- Big files open at once. Only the rows on screen are read, in 64 KB pieces. In the release check a 4 GB file opened in 0.6 s, Ctrl+End went to its last byte, and the extension host used 127 MB.
- You can get anywhere. Go to an offset in hex or decimal, or jump by `+0x100` or `-16`. Find hex bytes with `??` wildcards, text, or UTF-16 text. The status bar shows the offset of the cursor.
- Editing stays put. Type two hex digits to overwrite a byte; the cursor moves one byte and stops. Each byte is one undo step. Save writes only the changed bytes.

## Quick start

1. Install Hex Viewer.
2. Right-click any file in the Explorer and pick "Open in Hex Viewer". Files that end in `.bin`, `.dat`, `.img`, `.rom`, `.dmp` or `.dump` open in Hex Viewer when you click them.

For a file that is already open, use "Open in Hex Viewer" in the editor title menu (`...`) or the tab's right-click menu, or "Reopen Editor With...". Text files such as `.txt`, `.ts` and Intel `.hex` files still open in the text editor. "Hex Viewer: Get Started" in the Command Palette opens a short tour.

## Large files

![A 4 GB sparse file at its last row, offset 0x100000030, with LASTBYTE in the text column. The row above shows NEAR-THE-4GB-EDGE at offset 0xFFFFFFF0.](https://github.com/theluckystrike/hex-viewer-vscode/raw/HEAD/images/big-4gb-end.png)

- Local files of any size open. The extension never reads the whole file: it reads the rows you look at, and Find reads the file in 1 MB pieces.
- The scroll bar is drawn by the viewer, so it reaches the last row of a 4 GB or larger file. Drag it, use the mouse wheel, Page Up and Page Down, or Ctrl+Home and Ctrl+End.
- If the file changes on disk while it is open, the view shows the new bytes. If it got shorter, a message gives the old and new size and the view moves to the new end. Nothing crashes and nothing goes blank.
- Empty files and files you have no permission to read show a plain message instead of a blank tab.
- Files on remote and virtual file systems open up to 256 MB (setting `hexViewer.maxRemoteMB`).

## Find, go to and copy

![firmware.bin with the 6 bytes DE AD BE EF 13 37 found at offset 0x2FFFD, across a 64 KB edge. The match is highlighted in the hex and text columns and the toolbar says Match at 0x2FFFD.](https://github.com/theluckystrike/hex-viewer-vscode/raw/HEAD/images/find-across-64k.png)

| Action | Keys | Notes |
|---|---|---|
| Go to offset | Ctrl+G (Cmd+G) | `0x1F40`, `1F40h`, `8000`, `+0x100`, `-16`, `end`, `end-15`. Also the box at the left of the toolbar, and a click on the status bar. |
| Find | Ctrl+F (Cmd+F) | Hex `50 4B 03 04` with `??` for any byte, text (with Aa to ignore case) or UTF-16. Unsaved edits are found too. |
| Next, previous match | Enter, Shift+Enter, F3, Shift+F3 | The search goes on from the start after the end. Esc stops a long search. |
| Copy | Ctrl+C (Cmd+C) | Hex with spaces from the hex column (setting `hexViewer.copyFormat`), text from the text column |
| Copy as... | toolbar | Hex, hex with spaces, C array, Python bytes, base64, UTF-8 text, Latin-1 text. Up to 32 MB. |
| Select | Shift + arrows, Page Up, Page Down, Home, End; drag; Ctrl+A | |
| Switch column | Tab | Between the hex and the text column |

## Data inspector

The panel on the right reads the bytes at the cursor, or at the start of the selection, as:

- the offset in hex and decimal, binary and octal
- uint8, int8, uint16, int16, uint24, uint32, int32, uint64, int64
- float16, float32, float64
- ULEB128 and SLEB128, with their length
- Unix time (32 and 64-bit) and Windows FILETIME
- a GUID, and a UTF-8 and UTF-16 character with its code point

Click "Little-endian" to switch to big-endian. In the release check, the values at 5 offsets were the same as Python's `struct` and `uuid` modules.

## Edit bytes

![edit-me.bin after typing AB CD 12 at offset 0x10. The three edited bytes are colored and the tab shows unsaved changes.](https://github.com/theluckystrike/hex-viewer-vscode/raw/HEAD/images/edited-3-bytes.png)

- Type hex digits in the hex column, or characters in the text column, to overwrite bytes. Edited bytes are colored until you save.
- Paste hex (`4A 5B 00`, `0x4A, 0x5B` or `\x4a\x5b`) with Ctrl+V to overwrite from the cursor.
- Ctrl+Z undoes one byte, Ctrl+Shift+Z redoes, and Ctrl+S saves. Save writes only the changed bytes into the file, so it is fast on a 4 GB file. Save As writes a full copy.
- Overwrite only: bytes are not inserted or deleted, so the file size does not change.
- Read-only files open as view only. Set `hexViewer.readOnly` to turn editing off for every file.

## Display

![The same PNG in the light theme at 16 bytes per row, with the cursor on offset 0x10.](https://github.com/theluckystrike/hex-viewer-vscode/raw/HEAD/images/light-theme.png)

- 8, 16, 24, 32, 48 or 64 bytes per row.
- Text column in ASCII, Latin-1, UTF-8, UTF-16 LE, UTF-16 BE or EBCDIC (code page 037). Control bytes show as a dot or as symbols such as ␀ and ␊.
- The file type from its first bytes in the status line: PNG, JPEG, ZIP, PDF, SQLite, ELF, Mach-O, PE, Java class, WAV, WebAssembly and more.
- The editor font, the theme colors in dark and light themes, and the editor font size (or `hexViewer.fontSize`).
- Screen readers hear the offset and value of the byte under the cursor.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `hexViewer.bytesPerRow` | 16 | Bytes in each row when a file opens |
| `hexViewer.encoding` | ascii | Text column encoding when a file opens |
| `hexViewer.controlChars` | dot | Show control bytes as a dot or as symbols |
| `hexViewer.uppercase` | true | 4A or 4a |
| `hexViewer.fontSize` | 0 | Font size of the byte grid; 0 uses the editor font size |
| `hexViewer.copyFormat` | hexSpaced | What Ctrl+C copies from the hex column |
| `hexViewer.littleEndian` | true | Byte order of the data inspector |
| `hexViewer.showInspector` | true | Show the data inspector when a file opens |
| `hexViewer.readOnly` | false | Turn off byte editing |
| `hexViewer.maxRemoteMB` | 256 | Largest file from a remote or virtual file system |
| `hexViewer.askForRating` | true | Ask one time for a Marketplace rating after a few days of use. Nothing is sent anywhere. |
| `hexViewer.showSupportLinks` | true | Show the small Sponsor and More free viewers links in the status line |

## Privacy and safety

The extension makes no network calls and has no telemetry. It writes to a file only when you save. The webview runs under a strict Content Security Policy (`default-src 'none'`, scripts by nonce, no remote sources) and gets bytes only from the extension host.

## Limits

- Overwrite only. Insert and delete come in a later version.
- No structure templates yet (PNG chunks, ZIP entries, ELF and PE headers).
- Copy as... works up to 32 MB, and a paste up to 16 MB.

## Support Zovo

Zovo extensions are free, with no ads and no tracking. They are made by [theluckystrike](https://github.com/theluckystrike) on GitHub. If this one saves you time, you can support the work:

- [Sponsor on GitHub](https://github.com/sponsors/theluckystrike)
- [Follow theluckystrike on GitHub](https://github.com/theluckystrike)

## More tools by Zovo

- [Large JSON Viewer, JSON Browser & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [SQLite DB Viewer & SQLite Viewer, Database Viewer (Read-Only)](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [ZIP Viewer & Archive Explorer (JAR, TAR, GZ)](https://marketplace.visualstudio.com/items?itemName=zovo.zip-archive-explorer) browses ZIP, JAR, VSIX, TAR and GZ files, opens entries in tabs and extracts them safely.
- [XLSX Viewer, Excel Viewer, CSV Viewer & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens CSV, TSV, Excel and Parquet files as a sortable, filterable table.
- [JSONL Viewer, Large JSONL Table & NDJSON Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.

See [all Zovo extensions on the Marketplace](https://marketplace.visualstudio.com/publishers/zovo).

## License

MIT

## More from zovo

- [All free zovo VS Code extensions](https://marketplace.visualstudio.com/publishers/zovo) — file viewers, database clients, formatters. Offline, no telemetry, no sign-up.
- [Full MCP server catalogue](https://theluckystrike.github.io/mcp/) — local-first MCP servers for back-office work: invoices, VAT, PDFs, spreadsheets, payroll.
- [Hosted no-install MCP endpoints](https://mcp.zovo.one) — paste a URL in Claude / Cursor, nothing to install.
