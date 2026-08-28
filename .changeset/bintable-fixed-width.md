---
"@fits-js/core": minor
---

`readTable(hdu, reader, opts?)`: decode the fixed-width columns of a `BINTABLE` extension, column-major:

- Every fixed-width `TFORMn` type (`L X B I J K A E D C M`) with repeat counts, decoded from FITS big-endian into one flat typed array per column; `A` columns come back as one string per row, complex columns interleave re,im
- The full column keyword model on each result column: `TTYPEn`, `TUNITn`, `TSCALn`/`TZEROn`, `TNULLn`, `TDIMn` (metadata, data stays flat), `TDISPn`, byte offset and width
- astropy-parity scaling: the unsigned-integer convention stays integer (`Uint16`/`Uint32`/`BigUint64`, and `Int8` for the signed-byte form), any other `TSCALn`/`TZEROn` widens to `Float64Array`; `raw: true` bypasses
- Undefined elements surface on a per-column `mask` side channel with stored values untouched; float columns keep `NaN` in the values
- `columns` selects by `TTYPEn` name or index, `rows` decodes a contiguous range, and rows are fetched in bounded slabs with `AbortSignal` support
- Variable-length array columns (`P`/`Q`) parse into the column model and reject decoding with `FitsUnsupportedError`; project around them to read the rest of the table
- Adds the `FitsTable`, `TableColumnData`, `TableColumn`, `TableColumnArray`, `ParsedTform`, `ColumnTypeCode`, and `ReadTableOptions` types
