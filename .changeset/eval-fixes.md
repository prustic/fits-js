---
"@fits-js/core": minor
---

Adopter-evaluation fixes to the read path:

- A mid-stream HTTP body failure (early-terminated response, connection reset) now throws `FitsIoError` carrying `url`, `status`, and the underlying error as `cause`, instead of leaking an untyped `TypeError`. Aborts during a body read still surface the caller's abort reason.
- Empty, truncated-to-nothing, or all-zero input now reports `no HDUs: ...` on the `warnings` channel in lenient mode and throws `FitsStructureError` in strict mode, instead of returning `{ hdus: [], warnings: [] }` silently.
- `SIMPLE = F` is surfaced as a warning in both modes. It never throws: the card is legal syntax, and astropy accepts it too.
- The npm tarball no longer ships compiled test files or `tsbuildinfo`.
