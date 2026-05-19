---
"@fits-js/core": minor
---

Add `readImage(hdu, reader, opts?)`: decode the pixels of a primary or `IMAGE` HDU through any `RandomAccessReader`.

Every `BITPIX` is supported (8/16/32/64/-32/-64), decoded from FITS big-endian into the matching typed array. `BZERO`/`BSCALE` are applied by default following astropy, including the unsigned-integer convention (`Uint8`/`Uint16`/`Uint32`/`BigUint64`) and `BLANK` to `NaN`; `{ raw: true }` returns the unscaled on-disk array. N-dimensional cubes are supported, and `{ region }` reads a rectangular cutout that fetches only the bytes the region spans, so a small window of a multi-gigabyte cube stays cheap.

Adds the `FitsImage`, `ImageArray`, `ImageRegion`, and `ReadImageOptions` types.
