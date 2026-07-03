# @fits-js/core

[![npm version](https://img.shields.io/npm/v/@fits-js/core?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@fits-js/core)
[![CI](https://github.com/prustic/fits-js/actions/workflows/ci.yml/badge.svg)](https://github.com/prustic/fits-js/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/prustic/fits-js/graph/badge.svg)](https://codecov.io/gh/prustic/fits-js)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/prustic/fits-js/blob/main/LICENSE)

FITS parser, image decoder, and byte-source readers for JavaScript runtimes, in pure TypeScript with zero runtime dependencies.

> **Note:** This project is in early development (v0.1.0) and is not recommended for production usage, but feedback is very welcome on [GitHub](https://github.com/prustic/fits-js/issues).

## Install

```bash
npm install @fits-js/core
```

Requires Node 22 or later. In the browser, any environment with `fetch`, `Blob`, and `TypedArray` works.

## Quick example

```typescript
import { NodeFileReader, openFits, readImage } from "@fits-js/core";

const reader = await NodeFileReader.open("data/image.fits");
try {
  const { hdus } = await openFits(reader);
  const region = { start: [0, 0], shape: [16, 16] };
  const { data } = await readImage(hdus[0], reader, { region });
  console.log(data.slice(0, 8));
} finally {
  await reader.close();
}
```

## Public surface

- `openFits(reader)` enumerates HDUs lazily, reading only header blocks.
- `readImage(hdu, reader, { region? })` decodes a 2D or higher image HDU. With a `region`, only the bytes covering that cutout are fetched.
- `RandomAccessReader` implementations: `BytesReader` (in-memory), `BlobReader` (browser `Blob`/`File`), `HttpRangeReader` (HTTP `Range` with LRU paging and `If-Range`), `NodeFileReader` (`fs`-backed).
- `FitsHeader` with typed accessors (`getNumber`, `getString`, `getBoolean`, `get`, `getAll`).
- Typed error hierarchy: `FitsError`, `FitsHeaderError`, `FitsStructureError`, `FitsUnsupportedError`, `FitsIoError`.

## Documentation

Full docs at [prustic.github.io/fits-js](https://prustic.github.io/fits-js/).

- [Quickstart](https://prustic.github.io/fits-js/quickstart/)
- [Reading a FITS file](https://prustic.github.io/fits-js/guides/reading-a-file/)
- [Reading over HTTP](https://prustic.github.io/fits-js/guides/reading-over-http/)
- [Working with image data](https://prustic.github.io/fits-js/guides/working-with-image-data/)
- [Error handling](https://prustic.github.io/fits-js/guides/error-handling/)
- [Roadmap](https://prustic.github.io/fits-js/roadmap/)

## License

[Apache-2.0](https://github.com/prustic/fits-js/blob/main/LICENSE)
