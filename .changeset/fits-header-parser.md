---
"@fits-js/core": minor
---

Add FITS header parsing. `parseHeader` reads a header from a buffer into a `FitsHeader` with typed values (logical, integer, float including the Fortran D exponent, complex, string), resolves the CONTINUE long-string and HIERARCH conventions, and offers lenient (default, recovers and reports on a warnings channel) or strict (rejects standard violations) modes. Parsing of real archive headers is cross-checked against astropy.
