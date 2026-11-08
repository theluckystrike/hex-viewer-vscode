# Go to an offset and find bytes

- Ctrl+G (Cmd+G on macOS) opens "Go to offset". Type `0x1F40`, `1F40h`, `8000`, `+0x100`, `-16` or `end`. The box under the toolbar does the same.
- Ctrl+F (Cmd+F) puts the cursor in the Find box. Pick Hex, Text or UTF-16.
  - Hex: `50 4B 03 04`, `504B0304` or `0x50,0x4B`. `??` matches any byte: `DE ?? BE EF`.
  - Text: plain text, with Aa to ignore case.
- Enter finds the next match, Shift+Enter the one before. F3 and Shift+F3 work too. The search goes on from the start of the file when it reaches the end.
- The search runs on the whole file in 1 MB pieces, so a pattern that crosses a piece edge is found, and a 4 GB file does not fill the memory. Esc stops a long search.
- The status bar shows the cursor offset in hex and decimal. Click it to go to an offset.
