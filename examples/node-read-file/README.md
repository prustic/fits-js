# node-read-file

Opens a FITS file with `NodeFileReader`, enumerates HDUs lazily with
`openFits`, and reads a small image cutout from the primary HDU with
`readImage`. No bytes outside the headers and the cutout window are touched.

## Run

```sh
pnpm build && node dist/main.js [path/to/file.fits]
```

The path is optional and defaults to `fixtures/sample.fits`, an HST/FOS
multi-extension file from the public MAST archive checked into the example.
Requires Node.js 22+.
