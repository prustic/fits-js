---
"@fits-js/core": minor
---

HDU enumeration:

- `readHdus(bytes)`: walk every Header-Data Unit, locating and sizing each data unit from its keywords per the FITS size formula
- `findHdu(hdus, name, version?)`: lookup by `EXTNAME`/`EXTVER`; an absent `EXTVER` matches version 1
- Primary, `IMAGE`, `BINTABLE` (including the `A3DTABLE` alias), and ASCII `TABLE` recognized; unknown conforming extensions are skipped so later HDUs stay reachable
- Structural keywords are domain-validated; a missing or out-of-domain value stops enumeration with a warning and `dataSizeKnown: false` (lenient) or throws `FitsStructureError` (strict), rather than desyncing later offsets
- Empty, shorter-than-one-block, or all-zero input reports `no HDUs` on `warnings` (lenient) or throws (strict); `SIMPLE = F` is surfaced as a warning in both modes
- Random groups rejected with `FitsUnsupportedError`
