# Changelog

## 0.2.0 (2026-11-09)

- Insert and delete bytes. Press Insert (or click the mode in the status line) to switch between overwrite and insert mode. Delete, Backspace, Ctrl+X (cut) and paste work on any selection, with undo and redo. "Insert Bytes..." adds a run of bytes, such as `0x100 FF`.
- Insert and delete are instant on files of any size: only a list of changes is kept until you save.
- Safe save: when the size changes, a new copy is written in the same folder and then swapped in. Hex Viewer checks the free disk space first. Symbolic links and file permissions stay as they were.
- Compare two files byte by byte: "Compare in Hex Viewer" in the Explorer menu (select two files) or the Compare... button. Side by side view, F7 and Shift+F7 for the next and previous difference, a count of differing bytes and areas, and marks on the scroll bar. Works on 4 GB and larger files.

## 0.1.0 (2026-11-08)

First release.

- Opens any file: right-click "Open in Hex Viewer", the editor title menu, or "Reopen Editor With...". Default editor for .bin, .dat, .img, .rom, .dmp and .dump.
- Files of any size: range reads, rows drawn on demand and a scroll bar that reaches the end of a 4 GB or larger file.
- Go to offset in hex, decimal or relative (Ctrl+G), with the cursor offset in the status bar.
- Find hex bytes (with ?? wildcards), text and UTF-16 text, forward and back, across the whole file.
- Copy as hex, C array, Python bytes, base64 or text.
- Data inspector: integers from 8 to 64 bits, float16/32/64, LEB128, Unix time, FILETIME, GUID, UTF-8 and UTF-16, little or big-endian.
- Byte editing in overwrite mode with undo, redo, save in place and Save As. Read-only files open as view only.
- 8 to 64 bytes per row; ASCII, Latin-1, UTF-8, UTF-16 and EBCDIC text column.
- Clear messages for empty files, files without read permission, link loops and files that change on disk while open.
