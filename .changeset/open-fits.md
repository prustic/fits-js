---
"@fits-js/core": minor
---

`openFits(reader)`: lazy HDU enumeration over any byte source:

- Only header blocks are read; each data unit is sized from its keywords and seeked past, never fetched, so a remote file enumerates without materializing it and a later `readImage` cutout fetches only its region
- Same sizing, classification, and strict/lenient code as `readHdus`, so well-formed files enumerate identically
- `maxHeaderBlocks` (default 1000) bounds a malformed source that never emits `END`
