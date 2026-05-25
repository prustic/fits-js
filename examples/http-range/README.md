# http-range

Points `HttpRangeReader` at a FITS file hosted on a public archive,
enumerates HDUs with `openFits`, and reads a small cutout from the first
2D image HDU with `readImage`. `HttpRangeReader` only fetches the byte
ranges those calls actually need.

## Run

```sh
pnpm build && node dist/main.js [https://host/path/file.fits]
```

The URL is optional; it defaults to `NICMOSn4hk12010_mos.fits` (1.17 MB,
five 270x263 NICMOS image extensions) from the NASA FITS Support Office's
public sample tree at `fits.gsfc.nasa.gov/samples/`, which has served these
files at stable URLs since 2004 and returns `Accept-Ranges: bytes`.
Requires Node.js 22+ and network access.

The endpoint must support HTTP `Range`; `HttpRangeReader` falls back to a
single full fetch only if the server explicitly refuses (`416` or no
`Accept-Ranges` on the first probe).
