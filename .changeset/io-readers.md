---
"@fits-js/core": minor
---

Add the `RandomAccessReader` byte-source abstraction and four implementations so one parser runs over any source: `BytesReader` (in-memory), `BlobReader` (browser `Blob`/`File`), `NodeFileReader` (Node/Bun/Deno, via the async `NodeFileReader.open()` which dynamically imports `node:fs/promises` so the core stays browser-safe; accepts a path or `URL`), and `HttpRangeReader` (HTTP Range). The HTTP reader assembles results from the bytes actually fetched (correct regardless of cache eviction), follows up short `206` responses until the range is satisfied, concludes end of file only from the known size or `416`, falls back to the whole body when a server ignores `Range`, guards against the resource changing mid-read with `If-Range`, keeps an LRU page cache, and accepts an injectable `fetch`, extra headers, and an `AbortSignal`. Adds `FitsIoError` with structured `url` / `status` / `offset`; range, HTTP, network, and filesystem failures are wrapped in it.
