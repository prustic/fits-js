# node-read-file

Opens a FITS file with `NodeFileReader`, enumerates HDUs lazily with
`openFits`, and reads a small image cutout from the primary HDU with
`readImage`. No bytes outside the headers and the cutout window are touched.

## Run

```sh
pnpm build && node dist/main.js [path/to/file.fits]
```

The default path is `fixtures/sample.fits` (an HST/FOS multi-extension
file checked into the example), so `pnpm start` works without arguments.
Requires Node.js 22+.
