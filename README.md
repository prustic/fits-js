<p align="center">
  <h2 align="center">fits-js</h2>
  <p align="center">
    FITS file format implementation for JavaScript runtimes
    <br />
    <br />
    <a href="https://github.com/prustic/fits-js/issues">Issues</a>
    ·
    <a href="https://github.com/prustic/fits-js/blob/main/CONTRIBUTING.md">Contributing</a>
  </p>

  <p align="center">
    <a href="https://github.com/prustic/fits-js/actions/workflows/ci.yml"><img src="https://github.com/prustic/fits-js/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://codecov.io/gh/prustic/fits-js"><img src="https://codecov.io/gh/prustic/fits-js/graph/badge.svg" alt="codecov" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License" /></a>
  </p>
</p>

> **Note:** This project is in early development (v0.1.0) and is not recommended for production usage, but feedback is very welcome on [GitHub](https://github.com/prustic/fits-js/issues).

## About

FITS (Flexible Image Transport System) is the container format astronomy runs on. Telescopes, sky surveys, and public data archives store images and tabular catalogs as FITS: a sequence of header-and-data units holding N-dimensional image arrays, binary and ASCII tables, and optionally tile-compressed image data.

fits-js reads and writes FITS in TypeScript. It parses image, binary-table, and ASCII-table HDUs and compressed-image extensions, exposes table data as Apache Arrow, and resolves World Coordinate System headers to sky coordinates. I/O goes through a small web-standard byte-source interface, so the same code runs on Node, Bun, Deno, Cloudflare Workers, and the browser, and `@fits-js/core` carries no runtime dependencies.

## License

[Apache-2.0](LICENSE).
