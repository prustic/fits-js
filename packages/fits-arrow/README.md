# @fits-js/arrow

[![npm version](https://img.shields.io/npm/v/@fits-js/arrow?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@fits-js/arrow)
[![CI](https://github.com/prustic/fits-js/actions/workflows/ci.yml/badge.svg)](https://github.com/prustic/fits-js/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/prustic/fits-js/graph/badge.svg?flag=fits-arrow)](https://codecov.io/gh/prustic/fits-js)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/prustic/fits-js/blob/main/LICENSE)

Apache Arrow adapter for FITS tables read with [`@fits-js/core`](https://www.npmjs.com/package/@fits-js/core). Turns `BINTABLE` and ASCII `TABLE` extensions into Arrow tables and record batches for DuckDB-wasm, Observable, Polars, or anything else that reads Arrow.

> **Note:** This project is in early development and is not recommended for production usage, but feedback is very welcome on [GitHub](https://github.com/prustic/fits-js/issues).

## Install

```bash
npm install @fits-js/core @fits-js/arrow apache-arrow
```

`@fits-js/core` and `apache-arrow` are peer dependencies, so the `Hdu` and reader you pass in come from the same core your app uses; `apache-arrow` versions 17 through 21 work. Requires Node 22 or later, or any browser `@fits-js/core` runs in.

## Quick example

```typescript
import { NodeFileReader, findHdu, openFits, readTable } from "@fits-js/core";
import { toArrowTable } from "@fits-js/arrow";
import { tableToIPC } from "apache-arrow";

const reader = await NodeFileReader.open("data/catalog.fits");
try {
  const { hdus } = await openFits(reader);
  const hdu = findHdu(hdus, "CATALOG")!;
  const table = toArrowTable(await readTable(hdu, reader, { columns: ["RA", "DEC", "MAG"] }));

  // DuckDB-wasm: hand over IPC bytes, not the Table object.
  await conn.insertArrowFromIPCStream(tableToIPC(table, "stream"), { name: "catalog" });
} finally {
  await reader.close();
}
```

## Public surface

- `toArrowTable(table)` converts a `readTable` result into an Arrow `Table` with one record batch.
- `readArrowBatches(hdu, reader, opts?)` reads a table as an async stream of record batches, one bounded read per batch. It takes `readTable`'s `columns`, `rows`, `raw` and `signal`, plus `batchRows` (default: about 16 MiB of rows, at most 65,536) and `onWarning`.

```typescript
const writer = new RecordBatchStreamWriter();
for await (const batch of readArrowBatches(hdu, reader, { batchRows: 10_000 })) {
  writer.write(batch);
}
writer.finish();
const ipc = writer.toUint8Array(true);
```

## Column types

| FITS column                            | Arrow type                                                       |
| -------------------------------------- | ---------------------------------------------------------------- |
| `B`, `I`, `J`, `K`, `E`, `D`           | `Uint8`, `Int16`, `Int32`, `Int64`, `Float32`, `Float64`         |
| unsigned convention (`TZEROn`)         | `Uint16`, `Uint32`, `Uint64`; `Int8` for `B` with `TZERO = -128` |
| other `TSCALn`/`TZEROn` scaling        | `Float64` (or the on-disk type with `raw: true`)                 |
| repeat count `r` > 1                   | `FixedSizeList<T, r>`; `TDIMn` stays metadata                    |
| `L`, `X`                               | `Bool`                                                           |
| `A`                                    | `Utf8`, one string per row                                       |
| `C`, `M`                               | `FixedSizeList<Float32 or Float64, 2>` of (re, im)               |
| `P`/`Q` variable-length arrays         | `List<T>`                                                        |
| ASCII `Aw`, `Iw`, `Fw.d`/`Ew.d`/`Dw.d` | `Utf8`, `Int32` or `Int64`, `Float64`                            |

The type comes from the decoded array, so it always matches what `readTable` returned. Arrow has no complex type; the `fits:TFORM` metadata tells a complex pair apart from a two-element float array.

Fields are named after `TTYPEn`, made unique ignoring case since DuckDB compares names that way: a repeated name takes a `_1`, `_2` suffix, and a column without `TTYPEn` is named `col<n>` after its position. Each field carries `fits:TFORM` metadata, plus `fits:TTYPE`, `fits:TUNIT`, `fits:TDISP` and `fits:TDIM` when the header sets them, so a renamed column still has its header name.

## Nulls

A field is nullable when its definition allows undefined values: `L` columns, integer columns with `TNULLn`, and every ASCII table column. Floats are never nullable, since NaN is their undefined value. The decision depends on the header only, so every batch of a table has the same schema.

Nulls sit on the values they cover. For an array column the list itself is never null, its elements are; a variable-length row with no elements is an empty list, not a null one.

## Memory

Numeric columns are not copied: their Arrow buffers are views of the arrays `readTable` returned, so changing one changes the other. Bitmaps (for `L`, `X` and nulls) and UTF-8 strings are built new, and complex variable-length columns get new list offsets.

## DuckDB-wasm and IPC

DuckDB-wasm bundles its own copy of `apache-arrow` (17), and Arrow JS checks types with `instanceof`, which fails across copies. Passing a `Table` from one copy to the other breaks, so pass IPC bytes: `tableToIPC(table, "stream")` into `insertArrowFromIPCStream`. The tests confirm that IPC written by this package reads back in apache-arrow 17.

## Documentation

Full docs at [prustic.github.io/fits-js](https://prustic.github.io/fits-js/).

## License

[Apache-2.0](https://github.com/prustic/fits-js/blob/main/LICENSE)
