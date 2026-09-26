---
"@fits-js/arrow": minor
---

New package: `@fits-js/arrow` converts tables read by `@fits-js/core` into Apache Arrow, with `apache-arrow` 17 through 21 as a peer dependency.

- `toArrowTable(table)` turns a `readTable` result into an Arrow `Table`. Numeric columns share memory with the decoded arrays instead of being copied
- `readArrowBatches(hdu, reader, opts)` streams a table as record batches, one bounded read per batch, with `readTable`'s `columns`, `rows`, `raw` and `signal` options, a `batchRows` size, and an `onWarning` callback
- Scalar columns map to the Arrow type of their decoded values, repeat counts to `FixedSizeList`, variable-length arrays to `List`, `L` and `X` to `Bool`, character columns to `Utf8`, and complex values to `FixedSizeList<Float, 2>` pairs of real and imaginary parts
- Null masks become validity bitmaps on the values they cover, and a field is nullable when its definition allows undefined values, so every batch of a table has the same schema
- `TFORMn`, `TUNITn`, `TDISPn` and `TDIMn` travel as `fits:` field metadata

IPC bytes written from these tables read back in apache-arrow 17, the version DuckDB-wasm bundles, so `tableToIPC` output can go straight to `insertArrowFromIPCStream`.
