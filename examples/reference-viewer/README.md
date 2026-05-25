# reference-viewer

Opens a FITS file picked from `<input type="file">`, reads the first 2D
image HDU with `readImage`, and paints it to a `<canvas>` as 8-bit
grayscale. Display contrast is set by a linear stretch between the 0.5%
and 99.5% percentile of the finite pixel values, the standard "show me
what's there" baseline; NaN is rendered black. The image is Y-flipped
because FITS pixel (0,0) is bottom-left and canvas (0,0) is top-left.

## Run

```sh
pnpm dev
```

Vite serves at `http://localhost:5173`. Pick any FITS file with a 2D
primary or `IMAGE` extension. `pnpm build` emits a production bundle in
`dist/`. Requires Node.js 22+ for the dev server.

This example decodes the full image into memory; that's deliberate for
a viewer, but it's not how lazy access is meant to be used in production
(see [`http-range`](../http-range/) for the lazy-cutout pattern).

Pixel values are coerced to `Float64` for the percentile sort and the
display normalization, which loses precision above ±2^53 for the
`BigInt64Array`/`BigUint64Array` cases. The display path is 8-bit
grayscale, so this loss never reaches the canvas.
