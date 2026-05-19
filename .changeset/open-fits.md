---
"@fits-js/core": minor
---

Add `openFits(reader)`: enumerate a FITS file's HDUs through a `RandomAccessReader`, reading only header blocks. Each data unit is located and measured from its keywords then seeked past, never fetched, so a multi-gigabyte remote file is opened from a few kilobytes and a subsequent `readImage` cutout fetches only its region. Sizing, classification, random-groups rejection, and the strict/lenient contract match `readHdus`, which is unchanged for in-memory inputs.
