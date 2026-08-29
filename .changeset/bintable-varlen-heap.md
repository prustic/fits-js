---
"@fits-js/core": minor
---

`readTable` now decodes variable-length array columns (`TFORMn` `rPt(emax)` and `rQt(emax)`) from the `BINTABLE` heap:

- 32-bit `P` and 64-bit `Q` descriptors, `THEAP` with or without a gap ahead of the heap, and heaps whose arrays are unordered, aliased, or separated by unreferenced bytes
- Rows gather into an Arrow-shaped list: a flat `values` array plus a `rowCount + 1` entry `offsets` array on `TableColumnData`, so row `i` is `values.subarray(offsets[i], offsets[i + 1])`
- Every element type over the heap, with `TSCALn`/`TZEROn` and `TNULLn` applied to the heap data rather than the descriptors; a variable-length `A` column comes back as one string per row
- Descriptors are bounds-checked against the heap extent, so an array reaching past it is refused rather than silently truncated
- Only the arrays the selected columns and rows reference are fetched, in one forward pass, so a projection over a variable-length column now saves I/O as well as memory
- `TSCALn`/`TZEROn` on a `1PA` or `1PL` column are ignored with a warning, matching their fixed-width equivalents
