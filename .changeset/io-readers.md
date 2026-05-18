---
"@fits-js/core": minor
---

Add the `RandomAccessReader` byte-source abstraction so one parser runs over any source, with four implementations: `BytesReader` (in-memory), `BlobReader` (browser `Blob`/`File`), `NodeFileReader` (Node/Bun/Deno), and `HttpRangeReader` (HTTP Range).

`NodeFileReader.open()` dynamically imports `node:fs/promises` so the core stays browser-safe, and accepts a path or `URL`. `HttpRangeReader` assembles results from the bytes actually fetched, so reads stay correct regardless of cache eviction; it follows up short `206` responses, concludes end of file only from a known size or `416`, and keeps an LRU page cache. A server that never honors `Range` is read whole once; once `Range` has been used, a later full-body `200` (the resource changed mid-read) throws rather than silently mixing two representations. The reader takes an injectable `fetch`, extra headers, and an `AbortSignal`.

Add `FitsIoError` carrying structured `url` / `status` / `offset`; range, HTTP, network, and filesystem failures are wrapped in it.
