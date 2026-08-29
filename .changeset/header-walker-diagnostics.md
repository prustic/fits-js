---
"@fits-js/core": patch
---

Header and HDU-walk diagnostics:

- A keyword record with no value indicator, the shape long-keyword conventions produce (`START_AIRMASS = 1.134 / ...`), parses as a commentary card with no warning, as the standard permits. Real archive headers that use it, such as the GSFC testkeys sample, now parse clean in strict mode too
- Input that is not FITS is diagnosed up front: a primary header that does not begin with `SIMPLE` warns in lenient mode and throws `FitsStructureError` in strict, instead of surfacing an unrelated `no END card found` error after the whole header is read. Strict mode also now rejects a `SIMPLE` card that is present but not first
- Trailing bytes that do not form a full 2880-byte record, including a header cut off mid-block, produce a warning instead of ending enumeration silently
