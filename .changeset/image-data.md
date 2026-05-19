---
"@fits-js/core": minor
---

Add `readImage(hdu, reader, opts?)`: decode the pixels of a primary or `IMAGE` HDU through any `RandomAccessReader`.

Every `BITPIX` is supported (8/16/32/64/-32/-64), decoded from FITS big-endian into the matching typed array. `BZERO`/`BSCALE` are applied by default following astropy: a scaled image becomes the narrowest float that preserves it with `BLANK` pixels set to `NaN`, and the unsigned-integer convention yields `Uint16`/`Uint32`/`BigUint64` (or `Int8Array` for the `BITPIX` 8 signed-byte form). An integer image with no scaling is returned in its native integer array; a declared `BLANK` is exposed for the caller to mask rather than forcing a float copy, a deliberate deviation from astropy noted in the `FitsImage` docs. `{ raw: true }` returns the unscaled on-disk array, and an `AbortSignal` cancels the read. N-dimensional cubes are supported, and `{ region }` reads a rectangular cutout that fetches only the bytes the region spans, so a small window of a multi-gigabyte cube stays cheap.

Adds the `FitsImage`, `ImageArray`, `ImageRegion`, and `ReadImageOptions` types.
