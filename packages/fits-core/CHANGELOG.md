# @fits-js/core

## 0.2.0

### Minor Changes

- [#56](https://github.com/prustic/fits-js/pull/56) [`23a3554`](https://github.com/prustic/fits-js/commit/23a35547fd53eb2f6821243ef063c155c9273cf4) Thanks [@prustic](https://github.com/prustic)! - `readTable(hdu, reader, opts?)`: decode the fixed-width columns of a `BINTABLE` extension, column-major:
  - Every fixed-width `TFORMn` type (`L X B I J K A E D C M`) with repeat counts, decoded from FITS big-endian into one flat typed array per column; `A` columns come back as one string per row, complex columns interleave re,im
  - The full column keyword model on each result column: `TTYPEn`, `TUNITn`, `TSCALn`/`TZEROn`, `TNULLn`, `TDIMn` (metadata, data stays flat), `TDISPn`, byte offset and width
  - astropy-parity scaling: the unsigned-integer convention stays integer (`Uint16`/`Uint32`/`BigUint64`, and `Int8` for the signed-byte form), any other `TSCALn`/`TZEROn` widens to `Float64Array`; `raw: true` bypasses
  - Undefined elements surface on a per-column `mask` side channel with stored values untouched; float columns keep `NaN` in the values
  - `columns` selects by `TTYPEn` name or index, `rows` decodes a contiguous range, and rows are fetched in bounded slabs with `AbortSignal` support
  - Variable-length array columns (`P`/`Q`) parse into the column model and reject decoding with `FitsUnsupportedError`; project around them to read the rest of the table
  - Adds the `FitsTable`, `TableColumnData`, `TableColumn`, `TableColumnArray`, `ParsedTform`, `ColumnTypeCode`, and `ReadTableOptions` types

- [#62](https://github.com/prustic/fits-js/pull/62) [`3d095ef`](https://github.com/prustic/fits-js/commit/3d095ef5cff5f2609d813b4cb11bd49cda684890) Thanks [@prustic](https://github.com/prustic)! - `readTable` now decodes variable-length array columns (`TFORMn` `rPt(emax)` and `rQt(emax)`) from the `BINTABLE` heap:
  - 32-bit `P` and 64-bit `Q` descriptors, `THEAP` with or without a gap ahead of the heap, and heaps whose arrays are unordered, aliased, or separated by unreferenced bytes
  - Rows gather into an Arrow-shaped list: a flat `values` array plus a `rowCount + 1` entry `offsets` array on `TableColumnData`, so row `i` is `values.subarray(offsets[i], offsets[i + 1])`
  - Every element type over the heap, with `TSCALn`/`TZEROn` and `TNULLn` applied to the heap data rather than the descriptors; a variable-length `A` column comes back as one string per row
  - Descriptors are bounds-checked against the heap extent, so an array reaching past it is refused rather than silently truncated
  - Only the arrays the selected columns and rows reference are fetched, in one forward pass, so a projection over a variable-length column now saves I/O as well as memory
  - `TSCALn`/`TZEROn` on a `1PA` or `1PL` column are ignored with a warning, matching their fixed-width equivalents

### Patch Changes

- [#60](https://github.com/prustic/fits-js/pull/60) [`8a7a2c1`](https://github.com/prustic/fits-js/commit/8a7a2c1377d5a59eea18d290e7f10648aa8cf274) Thanks [@prustic](https://github.com/prustic)! - Header and HDU-walk diagnostics:
  - A keyword record with no value indicator, the shape long-keyword conventions produce (`START_AIRMASS = 1.134 / ...`), parses as a commentary card with no warning, as the standard permits. Real archive headers that use it, such as the GSFC testkeys sample, now parse clean in strict mode too
  - Input that is not FITS is diagnosed up front: a primary header that does not begin with `SIMPLE` warns in lenient mode and throws `FitsStructureError` in strict, instead of surfacing an unrelated `no END card found` error after the whole header is read. Strict mode also now rejects a `SIMPLE` card that is present but not first
  - Trailing bytes that do not form a full 2880-byte record, including a header cut off mid-block, produce a warning instead of ending enumeration silently

## 0.1.0

### Minor Changes

- [#4](https://github.com/prustic/fits-js/pull/4) [`26916cd`](https://github.com/prustic/fits-js/commit/26916cdb2f71d77d9dd0a3de27d3046689d32347) Thanks [@prustic](https://github.com/prustic)! - Header parsing:
  - `parseHeader(bytes)`: fixed and free-format cards into a `FitsHeader`, reporting `byteLength`, `endFound`, and recovered violations on `warnings`
  - Typed values: logical, integer, float including the Fortran `D` exponent, complex, string with quote escaping
  - `CONTINUE` long strings and `HIERARCH` keywords including the ESO dialect
  - `FitsHeader` accessors `get`, `getAll`, `getString`, `getNumber`, `getBoolean`, `comments`, `history`; big integers come back exact as `bigint`
  - Lenient by default, matching astropy tolerance on real archive headers; `{ strict: true }` rejects standard violations

- [#6](https://github.com/prustic/fits-js/pull/6) [`74e8422`](https://github.com/prustic/fits-js/commit/74e842230dfb131409458999ecb7b0b57477f508) Thanks [@prustic](https://github.com/prustic)! - HDU enumeration:
  - `readHdus(bytes)`: walk every Header-Data Unit, locating and sizing each data unit from its keywords per the FITS size formula
  - `findHdu(hdus, name, version?)`: lookup by `EXTNAME`/`EXTVER`; an absent `EXTVER` matches version 1
  - Primary, `IMAGE`, `BINTABLE` (including the `A3DTABLE` alias), and ASCII `TABLE` recognized; unknown conforming extensions are skipped so later HDUs stay reachable
  - Structural keywords are domain-validated; a missing or out-of-domain value stops enumeration with a warning and `dataSizeKnown: false` (lenient) or throws `FitsStructureError` (strict), rather than desyncing later offsets
  - Empty, shorter-than-one-block, or all-zero input reports `no HDUs` on `warnings` (lenient) or throws (strict); `SIMPLE = F` is surfaced as a warning in both modes
  - Random groups rejected with `FitsUnsupportedError`

- [#8](https://github.com/prustic/fits-js/pull/8) [`a1ec3a0`](https://github.com/prustic/fits-js/commit/a1ec3a0f66f56e8da12f2d68abf5ba5fa832c685) Thanks [@prustic](https://github.com/prustic)! - `readImage(hdu, reader, opts?)`: decode the pixels of a primary or `IMAGE` HDU through any reader:
  - Every `BITPIX` (8/16/32/64/-32/-64), decoded from FITS big-endian into the matching typed array
  - astropy-parity `BZERO`/`BSCALE`: a scaled image widens to the narrowest float that preserves it, with `BLANK` as `NaN`; the unsigned-integer convention yields `Uint16`/`Uint32`/`BigUint64` (and `Int8` for the signed-byte form)
  - Unscaled integer images stay integer with `BLANK` exposed as `blank`, a documented deviation from astropy
  - N-dimensional cubes; a `{ region }` rectangular cutout fetches only the bytes the region spans
  - `{ raw: true }` returns the on-disk array; an `AbortSignal` cancels the read
  - Tile-compressed images (`ZIMAGE = T`) reject with `FitsUnsupportedError` naming the algorithm, not a malformed-file error
  - Adds the `FitsImage`, `ImageArray`, `ImageRegion`, and `ReadImageOptions` types

- [#7](https://github.com/prustic/fits-js/pull/7) [`853b19a`](https://github.com/prustic/fits-js/commit/853b19a8237dab6a568aec6deea3fb6bf07373f8) Thanks [@prustic](https://github.com/prustic)! - The `RandomAccessReader` byte-source abstraction, one parser over any source:
  - `BytesReader` (in-memory) and `BlobReader` (browser `Blob`/`File`)
  - `NodeFileReader` (Node/Bun/Deno): async factory taking a path or `URL`, dynamic `node:fs/promises` import so importing the barrel stays browser-safe
  - `HttpRangeReader` (HTTP `Range`): LRU page cache, request coalescing, `If-Range` validators, short-`206` follow-up, whole-body fallback when the server ignores `Range`, injectable `fetch`, `AbortSignal`
  - Failures are typed: request, HTTP-status, and mid-stream body errors all throw `FitsIoError` carrying `url` / `status` / `offset` and the underlying cause

- [#12](https://github.com/prustic/fits-js/pull/12) [`1783b56`](https://github.com/prustic/fits-js/commit/1783b5659ca520825053d2d51cd2fad3425bc223) Thanks [@prustic](https://github.com/prustic)! - `openFits` accepts `signal?: AbortSignal`, checked before every block read. A header without an `END` card reports `dataSizeKnown: false`, so `readImage` refuses the declared data unit of a malformed header.

- [#11](https://github.com/prustic/fits-js/pull/11) [`8f15e80`](https://github.com/prustic/fits-js/commit/8f15e80076164d768f4feff9509c4db9fa2a1640) Thanks [@prustic](https://github.com/prustic)! - `openFits(reader)`: lazy HDU enumeration over any byte source:
  - Only header blocks are read; each data unit is sized from its keywords and seeked past, never fetched, so a remote file enumerates without materializing it and a later `readImage` cutout fetches only its region
  - Same sizing, classification, and strict/lenient code as `readHdus`, so well-formed files enumerate identically
  - `maxHeaderBlocks` (default 1000) bounds a malformed source that never emits `END`
