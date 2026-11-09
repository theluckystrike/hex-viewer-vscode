# Writing binary templates for Hex Viewer Pro

A template is a JSON file that describes the structures of a file format. The Structure view reads the file with it and shows a tree of fields. Templates are data: Hex Viewer never runs code from them. Expressions in a template use a small built-in language (below), with limits on length and steps.

Put your templates in the `.vscode/hex-templates` folder of a workspace, or in any folder listed in the setting `hexViewer.templateFolders`. Files end in `.json` or `.jsonc`; `//` and `/* */` comments and trailing commas are allowed. The built-in templates in the [templates](templates) folder are working examples.

## A small example

```jsonc
{
  "id": "myformat",
  "name": "My format",
  "extensions": ["myf"],
  "match": [[{ "offset": 0, "text": "MYF1" }]],
  "endian": "little",
  "structs": {
    "File": [
      { "name": "magic", "type": "char", "length": 4 },
      { "name": "count", "type": "u16" },
      { "name": "records", "type": "Record", "count": "count" }
    ],
    "Record": { "label": "name", "fields": [
      { "name": "kind", "type": "u8", "enum": { "1": "Text", "2": "Image" } },
      { "name": "length", "type": "u32" },
      { "name": "name", "type": "zstring", "length": 64 },
      { "name": "data", "type": "bytes", "length": "length" }
    ] }
  }
}
```

## Top level

| Key | Meaning |
|---|---|
| `id` | A short id. Your templates show as `user:<id>`. |
| `name` | The name in the Structure view. |
| `extensions` | File extensions, used only when no `match` fits. |
| `match` | A list of alternatives. Each alternative is a list of checks that must all pass: `{ "offset", "hex": "89 50 4E 47" }`, `{ "offset", "text": "GIF89a" }` or `{ "offset", "type": "u16", "endian": "big", "min": 45, "max": 200 }`. A negative offset counts from the end. |
| `endian` | `little` (the default) or `big`. |
| `root` | The struct to start with. The default is `File`. |
| `structs` | Named structs. A struct is a list of fields, or `{ "fields", "endian", "size", "label" }`. |
| `enums`, `flags` | Named value lists: `{ "Name": { "1": "Text", "0x10": "Big" } }`. Fields refer to them by name or list them inline. |

## Fields

| Key | Meaning |
|---|---|
| `name` | The field name. Later expressions read the value by this name. |
| `type` | `u8` `u16` `u24` `u32` `u64` `i8` `i16` `i24` `i32` `i64` `f32` `f64`, `bytes`, `char` (a C text field that ends at the first zero byte), `string`, `zstring` (ends at a zero byte), `line` (ends at a line break), `asciiint` (digits as text, as in PDF), `uleb128`, `sleb128`, a struct name, an inline list of fields, or a switch: `{ "switch": "kind", "cases": { "1": "TextRecord", "0x2": "u32" }, "default": "Raw" }`. |
| `length` | The size of `bytes`, `char` and `string`, or the longest `zstring` and `line`. |
| `count` | Makes the field a list of this many items. |
| `until` | A list that stops after the item for which the expression is true. `_` is the last item, `i` its index. `"eof"` reads items until the end of the enclosing struct or file. |
| `while` | A list that goes on while the expression is true, checked before each item. |
| `elementAt` | For a list: the offset of each item, for example `entries[i].offset`. |
| `at` | Read the field at this offset (an expression), or search for it: `{ "find": "50 4B 05 06", "from": "end", "within": 65557 }` or `{ "findText": "startxref", "from": "end", "within": 4096 }`. |
| `peek` | With `at`: go back to where you were after the field. |
| `size` | For a struct: it takes exactly this many bytes; reading goes on after them. Inside, `end()` is the end of that struct. |
| `arraySize` | For a list: it takes exactly this many bytes. |
| `if` | Read the field only when the expression is true. |
| `endian` | `little`, `big`, or an expression such as `"byte_order == 'II' ? 'little' : 'big'"`. |
| `enum`, `flags` | Show the value by name. |
| `format` | `hex`, `dec`, `char`, `unix` (seconds since 1970), `dosdate`, `dostime`. |
| `expect` | The value the field should have (a number, text, or hex bytes). A different value is marked in the tree. |
| `label` | For structs: an expression shown next to the name, such as the chunk type. |
| `comment` | Shown in the tooltip. |
| `encoding` | For text: `utf8` (default), `latin1`, `ascii`, `utf16le`, `utf16be`. |
| `value` | A computed field: an expression, shown in italics. With `"hidden": true` it is kept for later expressions only. |

Directives without a name: `{ "seek": "offset" }`, `{ "skip": 4 }`, `{ "align": 512 }`, `{ "skipWhitespace": true }`.

## Expressions

Numbers (`12`, `0x1F`, `0b101`), text in quotes, `true` and `false`. Names of earlier fields, `a.b`, `a[2]`, `a[-1]` (the last item), `a.length`, `x.offset` and `x.size`. `parent` is the struct that holds this one, `root` the top struct, `this` the current struct, `i` the index in the nearest list.

Operators: `+ - * /`, `//` (whole-number division), `%`, `<< >> & | ^ ~` (64-bit), `== != < <= > >=`, `&& || !`, `a ? b : c`. `+` joins text.

Functions: `min()`, `max()`, `abs()`, `align(x, n)`, `pos()` (the current offset), `size()` (the file size), `start()` (the offset of the current struct), `end()` (the end of the enclosing sized struct, or the file size), `len(x)`, `defined(x)`, `hex(x)`, `str(x)`, `oct(text)` (octal text, as in TAR), and `u8(offset)`, `u16(offset)`, `u32(offset)`, `u16le`, `u16be`, `u32le`, `u32be` to look at bytes anywhere in the file.

`addr(table, a, 'vfield', 'sizefield', 'filefield')` maps an address through a list of structs, such as PE sections or ELF program headers. It finds the first item `e` with `e.vfield <= a < e.vfield + e.sizefield` and returns `a - e.vfield + e.filefield`, the file offset. When no item covers `a`, it returns -1. The PE template uses it to read the import table: `addr(pe.sections, rva, 'virtual_address', 'virtual_size', 'pointer_to_raw_data')`.

A computed field (`value`) that later expressions read must have `"hidden": true`; a visible computed field is shown in the tree only. To show and reuse a value, add a hidden copy and a visible field that reads it, as the DEX template does with `desc` and `descriptor`.

## Limits

A parse stops with a message after 50,000 fields, after 15 seconds, at 100,000 items in one list, or at structs nested 48 deep. An expression may have 2,000 characters and 20,000 steps. A search for a marker reads at most 16 MB. Fields that would run past the end of the file are cut there and marked.
