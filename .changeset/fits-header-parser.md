---
"@fits-js/core": minor
---

Header parsing:

- `parseHeader(bytes)`: fixed and free-format cards into a `FitsHeader`, reporting `byteLength`, `endFound`, and recovered violations on `warnings`
- Typed values: logical, integer, float including the Fortran `D` exponent, complex, string with quote escaping
- `CONTINUE` long strings and `HIERARCH` keywords including the ESO dialect
- `FitsHeader` accessors `get`, `getAll`, `getString`, `getNumber`, `getBoolean`, `comments`, `history`; big integers come back exact as `bigint`
- Lenient by default, matching astropy tolerance on real archive headers; `{ strict: true }` rejects standard violations
