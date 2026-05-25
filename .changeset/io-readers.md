---
"@fits-js/core": minor
---

Add the `RandomAccessReader` byte-source abstraction so one parser runs over any source, with four implementations: `BytesReader` (in-memory), `BlobReader` (browser `Blob`/`File`), `NodeFileReader` (Node/Bun/Deno, imported from `@fits-js/core/node`), and `HttpRangeReader` (HTTP Range).

`NodeFileReader.open()` dynamically imports `node:fs/promises` so the core stays browser-safe, and accepts a path or `URL`. `HttpRangeReader` assembles results from the bytes actually fetched, so reads stay correct regardless of cache eviction; it follows up short `206` responses, concludes end of file only from a known size or `416`, and keeps an LRU page cache. A server that never honors `Range` is read whole once; once `Range` has been used, a later full-body `200` throws rather than silently mixing two representations. Detecting a mid-read change relies on the server sending an `ETag`/`Last-Modified` validator (replayed as `If-Range`); with none, a resource that changes but keeps answering `206` is not detected. The reader takes an injectable `fetch`, extra headers, and an `AbortSignal`.

Add `FitsIoError` carrying structured `url` / `status` / `offset`; range, HTTP, network, and filesystem failures are wrapped in it.
