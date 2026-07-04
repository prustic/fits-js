<p align="center">
  <h2 align="center">fits-js</h2>
  <p align="center">
    FITS file format implementation for JavaScript runtimes
    <br />
    <br />
    <a href="https://github.com/prustic/fits-js/issues">Issues</a>
    ·
    <a href="https://github.com/prustic/fits-js/blob/main/CONTRIBUTING.md">Contributing</a>
    ·
    <a href="https://prustic.github.io/fits-js/">Docs</a>
  </p>

  <p align="center">
    <a href="https://github.com/prustic/fits-js/actions/workflows/ci.yml"><img src="https://github.com/prustic/fits-js/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://codecov.io/gh/prustic/fits-js"><img src="https://codecov.io/gh/prustic/fits-js/graph/badge.svg" alt="codecov" /></a>
    <a href="https://www.npmjs.com/package/@fits-js/core"><img src="https://img.shields.io/npm/v/@fits-js/core?style=flat&colorA=000000&colorB=000000" alt="npm version" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License" /></a>
  </p>
</p>

> [!NOTE]
> This project is in early development and is not recommended for production usage, but feedback is very welcome on [GitHub](https://github.com/prustic/fits-js/issues).

## About

FITS (Flexible Image Transport System) is the container format astronomy runs on. Telescopes, sky surveys, and public data archives store images and tabular catalogs as FITS. A sequence of header-and-data units holds N-dimensional image arrays, binary and ASCII tables, and optionally tile-compressed image data.

fits-js reads and writes FITS in TypeScript. The parser handles the full header grammar (including `CONTINUE` and `HIERARCH`), the image decoder covers every `BITPIX` with astropy-parity scaling, and I/O goes through a small web-standard byte-source interface, so the same code runs on Node, Bun, Deno, Cloudflare Workers, and the browser. `@fits-js/core` carries no runtime dependencies.

## Quick start

```bash
npm install @fits-js/core
```

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

`openFits` enumerates HDUs and reads only header blocks. `readImage` with a `region` reads only the bytes that region covers, so a small cutout from a multi-gigabyte cube stays cheap. `HttpRangeReader` and `BlobReader` are the byte-source adapters for URLs and browser `File` inputs.

Requires Node 22 or later. In the browser, any environment with `fetch`, `Blob`, and `TypedArray` works.

## Packages

| Package         | Description                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@fits-js/core` | Parser, image decoder, and four `RandomAccessReader` implementations (in-memory, `Blob`/`File`, Node file, HTTP `Range`) |

## Documentation

Full docs at [prustic.github.io/fits-js](https://prustic.github.io/fits-js/).

- [Quickstart](https://prustic.github.io/fits-js/quickstart/)
- [Reading a FITS file](https://prustic.github.io/fits-js/guides/reading-a-file/)
- [Reading over HTTP](https://prustic.github.io/fits-js/guides/reading-over-http/)
- [Working with image data](https://prustic.github.io/fits-js/guides/working-with-image-data/)
- [Roadmap](https://prustic.github.io/fits-js/roadmap/)

## Contribution

fits-js is free and open source, licensed under [Apache-2.0](LICENSE).

- [Contribute to the source code](CONTRIBUTING.md)
- [Report bugs and suggest features](https://github.com/prustic/fits-js/issues)

## Security

If you discover a security vulnerability, please see [SECURITY.md](SECURITY.md) for how to report it responsibly.
