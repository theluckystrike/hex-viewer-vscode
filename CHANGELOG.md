# Changelog

## 0.3.4 (2026-11-10)

- The Structure view is now free at the top level: the root and its fields for every template, with no try used. A field that holds more fields shows one row, "N nested fields: Zovo Pro". A click on it uses one of the 3 free tries and opens every level in that tab. Before, the whole Structure view was Pro after 3 tries. Picking another template is free too.
- 6 new templates written from the public specs: UF2, device tree blob (DTB), U-Boot uImage, Android boot.img, WebAssembly and Android DEX (26 in all).
- ELF: symbol tables (.symtab, .dynsym) with names, and the dynamic table with needed libraries. PE: imported DLLs and functions, and the resource directory.
- When no template fits, the Structure tab now offers 3 choices: request one (free), a template for your format in 2 working days for USD 49 with Zovo Pro included (GitHub Sponsors, or PayPal), or custom work for USD 299 once. It still shows at most once per session and never when a file opens.
- The Pro window compares the price with 010 Editor.
- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.
- The walkthrough ends with a step that links free Zovo extensions for the files that often come with this one. A link opens the extension page; nothing installs on its own.
- The footer link "Zovo Pro, USD 19" and the Marketplace Sponsor button open the Zovo Pro tier (USD 19 once, for every Zovo extension) instead of the general GitHub Sponsors page.
- Everything else in 0.3.3 is unchanged: the free viewer and editor, the other Pro tools with 3 free tries and the rating question.

## 0.3.3 (2026-11-10)

- When no structure template fits the open file, the Structure tab (or the template picker) shows one line: "No template for this format. Request one (free), or we build it for USD 299 once." The first link opens the format request form on GitHub with the file extension filled in (never the file name). The second opens the GitHub Sponsors tier for custom format support. The template picker also gets "None of these matches this file" when the matching templates are wrong.
- The line shows at most once per VS Code session, only after you open the Structure tab or press a button there, never when a file opens. No popup, no notification, and nothing is sent until you click a link.
- The Pro window lists the ways to pay in one order: Get Zovo Pro (GitHub Sponsors), Unlock with GitHub Sponsors, Pay with PayPal, I have a license key (shared license module synced).
- Everything else in 0.3.2 is unchanged: the free viewer and editor, the Pro tools with 3 free tries, the rating question and the support links.

## 0.3.2 (2026-11-10)

- Pay for Zovo Pro with PayPal from inside VS Code: a "Pay with PayPal" button in the Pro window and the Pro tabs, and the command "Pay for Zovo Pro with PayPal". It lists the 3 steps and opens PayPal with the amount filled in: USD 19 for one person, or USD 59 for a team of 5 with one shared key. The transaction ID goes to a short form on GitHub and the license key comes by email.
- The Pro window now says how to buy: "Get Zovo Pro" opens the "$19 one time" tier on GitHub Sponsors, then you come back and choose "Unlock with GitHub Sponsors". The buy buttons come first, the buttons for people who already paid come after them.
- Back from the browser: after "Get Zovo Pro" or a PayPal button, one message asks whether you paid and offers the next step (unlock with GitHub, or send the PayPal transaction ID). It shows once, within 2 hours, and never when Pro is already on.
- When the GitHub check says this account has not bought Zovo Pro, or VS Code has no GitHub sign-in, the message now also offers PayPal and the license key.
- The Get Pro button in the Pro tabs shows the price: "Get Pro, USD 19".
- Everything in 0.3.1 is unchanged, the rating question included.

## 0.3.1 (2026-11-09)

- The rating question comes after 2 files that opened without an error in 2 sessions at least 4 hours apart (was 3 files on 2 calendar days). It still never shows after an error, at most twice in all, and the setting turns it off.
- "Rate it" in the rating question and the Rate link in the viewer footer now open the review page of the store your editor installs from: the Visual Studio Marketplace in VS Code, Open VSX in Cursor, Windsurf, VSCodium and other editors that use Open VSX. Before, they always opened the Marketplace.
- A window that stays open for days now counts a file opened 4 hours or more after its first one as a new session for the rating question.
- Everything in 0.3.0 is unchanged.

## 0.3.0 (2026-11-09)

Everything that was free stays free. New, with the optional Zovo Pro (USD 19 once for every Zovo viewer; each feature has 3 free tries):

- Structure view with binary templates: a tree of the fields of the file, with values, enum names, offsets and sizes; click a field to select its bytes. 20 built-in templates (PNG, JPEG, GIF, BMP, ICO, TIFF, WebP, WAV, FLAC, MP4, ZIP, GZIP, TAR, PDF, SQLite, ELF, PE, Mach-O, Java class, PCAP) and your own as JSON files. Export a struct as JSON or as C structs with its values.
- Bookmarks with a name, a color and a note, saved per file. F2 and Shift+F2 jump, Ctrl+F2 (Cmd+F2) adds. Export as Markdown.
- Checksums of the selection or the whole file: CRC-32, Adler-32, MD5, SHA-1, SHA-256 and SHA-512.
- Compare report: every differing range of two files to a text, CSV or JSON file, also for 4 GB files.
- Find bytes or text in many files, with each match listed by offset; pick one to open the file there.

## 0.2.0 (2026-11-09)

- Insert and delete bytes. Press Insert (or click the mode in the status line) to switch between overwrite and insert mode. Delete, Backspace, Ctrl+X (cut) and paste work on any selection, with undo and redo. "Insert Bytes..." adds a run of bytes, such as `0x100 FF`.
- Insert and delete are instant on files of any size: only a list of changes is kept until you save.
- Safe save: when the size changes, a new copy is written in the same folder and then swapped in. Hex Viewer checks the free disk space first. Symbolic links and file permissions stay as they were.
- Compare two files byte by byte: "Compare in Hex Viewer" in the Explorer menu (select two files) or the Compare... button. Side by side view, F7 and Shift+F7 for the next and previous difference, a count of differing bytes and areas, and marks on the scroll bar. Works on 4 GB and larger files.
- Compare reads into reused buffers, so comparing two 4 GB files keeps memory flat.
- The support links now include PayPal.

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
