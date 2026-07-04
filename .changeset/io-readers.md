---
"@fits-js/core": minor
---

The `RandomAccessReader` byte-source abstraction, one parser over any source:

- `BytesReader` (in-memory) and `BlobReader` (browser `Blob`/`File`)
- `NodeFileReader` (Node/Bun/Deno): async factory taking a path or `URL`, dynamic `node:fs/promises` import so importing the barrel stays browser-safe
- `HttpRangeReader` (HTTP `Range`): LRU page cache, request coalescing, `If-Range` validators, short-`206` follow-up, whole-body fallback when the server ignores `Range`, injectable `fetch`, `AbortSignal`
- Failures are typed: request, HTTP-status, and mid-stream body errors all throw `FitsIoError` carrying `url` / `status` / `offset` and the underlying cause
