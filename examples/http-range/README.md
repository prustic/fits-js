# http-range

Points `HttpRangeReader` at a FITS file hosted on a public archive,
enumerates HDUs with `openFits`, and reads a small cutout from the first
2D image HDU with `readImage`. `HttpRangeReader` only fetches the byte
ranges those calls actually need.

## Run

```sh
pnpm build && node dist/main.js [https://host/path/file.fits]
```

The URL is optional and defaults to `NICMOSn4hk12010_mos.fits` (five
270x263 NICMOS image extensions) from the NASA FITS Support Office's
public sample tree at `fits.gsfc.nasa.gov/samples/`. Requires Node.js 22+
and network access.

The endpoint should support HTTP `Range`. If the server answers the
initial `bytes=0-0` probe with `200` (ignoring Range), `HttpRangeReader`
reads the whole body once and serves later reads from memory.
