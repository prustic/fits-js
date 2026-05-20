---
"@fits-js/core": minor
---

`openFits` now accepts `signal?: AbortSignal` via `OpenFitsOptions`. The signal is checked before every block read, so a caller-driven abort surfaces unwrapped and matches the cancellation contract already in `readImage`.

`openFits` and `readHdus` now return `dataSizeKnown: false` when a header lacks an `END` card, even if its sizing keywords look valid. The warning ("no END card found before end of input") and the HDU flag now agree, and `readImage` refuses to read the declared data unit of a malformed header rather than trusting its NAXIS.
