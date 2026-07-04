---
"@fits-js/core": minor
---

`readImage(hdu, reader, opts?)`: decode the pixels of a primary or `IMAGE` HDU through any reader:

- Every `BITPIX` (8/16/32/64/-32/-64), decoded from FITS big-endian into the matching typed array
- astropy-parity `BZERO`/`BSCALE`: a scaled image widens to the narrowest float that preserves it, with `BLANK` as `NaN`; the unsigned-integer convention yields `Uint16`/`Uint32`/`BigUint64` (and `Int8` for the signed-byte form)
- Unscaled integer images stay integer with `BLANK` exposed as `blank`, a documented deviation from astropy
- N-dimensional cubes; a `{ region }` rectangular cutout fetches only the bytes the region spans
- `{ raw: true }` returns the on-disk array; an `AbortSignal` cancels the read
- Adds the `FitsImage`, `ImageArray`, `ImageRegion`, and `ReadImageOptions` types
