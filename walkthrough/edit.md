# Copy, inspect and edit bytes

- Select: drag with the mouse, or hold Shift with the arrow keys, Page Up, Page Down, Home and End. Ctrl+A selects the whole file.
- Copy: Ctrl+C (Cmd+C) copies the selection as hex with spaces (setting `hexViewer.copyFormat`). The Copy as... menu also has hex without spaces, a C array, Python bytes, base64 and text.
- Data inspector: the panel on the right reads the bytes at the cursor as 8, 16, 24, 32 and 64-bit integers, float16, float32 and float64, ULEB128, Unix time, Windows FILETIME, a GUID and a UTF-8 or UTF-16 character. Click the byte order to switch between little-endian and big-endian.
- Edit: type hex digits in the hex column, or text in the text column, to overwrite bytes. Edited bytes are colored. Ctrl+Z undoes, Ctrl+Shift+Z redoes and Ctrl+S saves.
- Insert and delete: press Insert (or click Overwrite in the status line) to add bytes before the cursor. Delete removes the selection, Ctrl+X cuts it. A save that changes the size writes a new copy first, so the old file stays whole until the new one is ready.
- Paste hex (`4A 5B 00`) with Ctrl+V: it overwrites from the cursor, or inserts in insert mode.
- Compare: select two files in the Explorer and pick "Compare in Hex Viewer". F7 goes to the next difference.
- Set `hexViewer.readOnly` to open every file as view only.
