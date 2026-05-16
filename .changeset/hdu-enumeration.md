---
"@fits-js/core": minor
---

Add HDU enumeration. `readHdus` walks every Header-Data Unit, parsing each header and locating (without decoding) its data unit per the FITS size formula; `findHdu` looks an extension up by `EXTNAME`/`EXTVER` (an absent `EXTVER` matches version 1). Primary, IMAGE, BINTABLE (including the `A3DTABLE` alias) and ASCII TABLE are recognized; unrecognized conforming extensions are skipped so later HDUs stay reachable. Structural keywords are domain-validated (`BITPIX`, `NAXIS`, `NAXISn`, `PCOUNT`, `GCOUNT`); a missing or out-of-domain value stops enumeration with a warning and `dataSizeKnown: false` on the HDU (lenient) or throws `FitsStructureError` (strict) rather than desyncing later offsets. The random-groups format is rejected with `FitsUnsupportedError`.
