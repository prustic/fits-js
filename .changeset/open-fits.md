---
"@fits-js/core": minor
---

Add `openFits(reader)`: enumerate a FITS file's HDUs through a `RandomAccessReader`. Only header blocks are read. Each data unit is sized from its keywords and seeked past, never fetched, so a remote file is enumerated without materializing it and a subsequent `readImage` cutout fetches only its region. The per-HDU sizing, classification, random-groups rejection, and strict/lenient handling are the same code as `readHdus`, so well-formed files enumerate identically. On malformed or truncated input both fail safe. The sync `readHdus(bytes)` is unchanged for in-memory inputs.
