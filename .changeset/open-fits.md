---
"@fits-js/core": minor
---

Add `openFits(reader)`: enumerate a FITS file's HDUs through a `RandomAccessReader`. Only header blocks are read. Each data unit is sized from its keywords and seeked past, never fetched, so a remote file is enumerated without materializing it and a subsequent `readImage` cutout fetches only its region. The per-HDU sizing, classification, random-groups rejection, and strict/lenient handling are the same code as `readHdus`, so well-formed files enumerate identically. On malformed or truncated input both fail safe. The sync `readHdus(bytes)` is unchanged for in-memory inputs.

Strict-mode multi-block headers are handled by deferring strict checks to a final authoritative parse, and a configurable `maxHeaderBlocks` (default 1000) caps the grow loop against a malformed source that never emits `END`. `parseHeader` now also exposes `endFound: boolean` on its result so reader walkers do not need to match warning text.

Observable change: `readHdus`'s wrong-input-type guard now throws `FitsIoError` instead of `FitsStructureError`, matching `openFits` and the reading-side error model. Callers that branched on the specific class for non-`Uint8Array` arguments need to update.
