# browser-input

Opens a FITS file picked from `<input type="file">` in the browser, wraps
the `File` in a `BlobReader`, enumerates HDUs with `openFits`, and reads
a small cutout from the first 2D image HDU with `readImage`. The same
code path the Node examples use, just with a browser-native reader.

## Run

```sh
pnpm dev
```

Vite serves at `http://localhost:5173`. Click the file picker and choose
any FITS file from disk; the page lists HDUs and prints the cutout
values. `pnpm build` emits a production bundle in `dist/`. Requires
Node.js 22+ for the dev server.
