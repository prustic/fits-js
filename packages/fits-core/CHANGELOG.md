# @fits-js/core

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
