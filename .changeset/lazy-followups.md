---
"@fits-js/core": minor
---

`openFits` accepts `signal?: AbortSignal`, checked before every block read. A header without an `END` card reports `dataSizeKnown: false`, so `readImage` refuses the declared data unit of a malformed header.
