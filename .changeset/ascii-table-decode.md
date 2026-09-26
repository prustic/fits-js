---
"@fits-js/core": minor
---

`readTable` now decodes ASCII table extensions (`XTENSION = 'TABLE'`) through the same entry point as `BINTABLE`, returning the same result types:

- All five `TFORMn` codes (`Aw`, `Iw`, `Fw.d`, `Ew.d`, `Dw.d`), positioned by `TBCOLn` rather than by a running width, so characters that belong to no field, gaps between fields, and overlapping fields all read correctly
- The field grammar the standard specifies: leading and trailing blanks, `E`, `D` and bare-sign exponents, the deprecated implicit decimal point taken from `d`, a blank field as zero, and embedded blanks refused
- `Aw` comes back as one string per row, `Iw` as `Int32Array` up to nine digits and `BigInt64Array` beyond, and `Fw.d`/`Ew.d`/`Dw.d` always as `Float64Array`, since the standard defines no difference between the three
- `TNULLn` on an ASCII column is the character string the standard defines, on `TableColumn.tnullText`, compared blank-trimmed against the field text and honoured on every field type including `A`. A field that violates its `TFORMn` is masked and warned about rather than failing the column, so one bad field costs one value instead of the table
- `columns`, `rows`, `raw` and `signal` behave as they do for a `BINTABLE`

Two places where the standard and astropy disagree are settled in favour of the standard, and noted in the tests: an ASCII field with no decimal point takes its point from `d`, which astropy ignores, and a bare-sign exponent is read rather than refused.

`ParsedTform` is now a discriminated union, `{ kind: "binary", code, repeat, ... }` or `{ kind: "ascii", code, width, decimals?, ... }`. The code letters overlap between the two table kinds without meaning the same thing, so a consumer mapping columns to another type system has to say which it is handling.
