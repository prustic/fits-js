import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import {
  HttpRangeReader,
  openFits,
  readImage,
  type Hdu,
  type RandomAccessReader,
} from "@fits-js/core";

// Local HTTP server over a committed real-archive fixture. Real sockets,
// real Range, real archive bytes, fully under our control: no third-party
// uptime in the PR-blocking CI path. A separate optional smoke against a
// live archive belongs in its own non-blocking workflow if ever needed.
const FIXTURE = new URL("../../../packages/fits-core/test-fixtures/fos-mef.fits", import.meta.url);
const N1 = 2064; // primary NAXIS1
const N2 = 2; // primary NAXIS2

function serveBytes(bytes: Uint8Array) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers = {
      "Content-Type": "application/fits",
      "Accept-Ranges": "bytes",
    };
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { ...headers, "Content-Length": String(bytes.length) });
      res.end(Buffer.from(bytes));
      return;
    }
    // Trivial anchored match on a header we trust (test-only server).
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (!m) {
      res.writeHead(400).end();
      return;
    }
    const a = Number(m[1]);
    if (a >= bytes.length) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${bytes.length}` }).end();
      return;
    }
    const b = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${a}-${b}/${bytes.length}`,
      "Content-Length": String(b - a + 1),
    });
    res.end(Buffer.from(bytes.subarray(a, b + 1)));
  });
}

function countingReader(inner: RandomAccessReader): {
  reader: RandomAccessReader;
  reads: () => ReadonlyArray<readonly [number, number]>;
} {
  const log: Array<readonly [number, number]> = [];
  return {
    reader: {
      size: inner.size,
      read: (o, l) => {
        log.push([o, l]);
        return inner.read(o, l);
      },
    },
    reads: () => log,
  };
}

function readsTouchData(
  reads: ReadonlyArray<readonly [number, number]>,
  hdus: readonly Hdu[],
): boolean {
  return reads.some(([o, l]) =>
    hdus.some((h) => o < h.dataOffset + h.dataByteLength && o + l > h.dataOffset),
  );
}

test("openFits + readImage cutout end to end over real HTTP Range (local server, archive fixture)", async (t) => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const server = serveBytes(bytes);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/file.fits`;

  const { reader, reads } = countingReader(new HttpRangeReader(url));
  const { hdus } = await openFits(reader);
  const primary = hdus[0];

  assert.equal(primary.type, "primary");
  assert.equal(primary.header.getNumber("BITPIX"), -32);
  assert.equal(primary.header.getNumber("NAXIS"), 2);
  assert.equal(primary.header.getNumber("NAXIS1"), N1);
  assert.equal(primary.header.getNumber("NAXIS2"), N2);
  assert.equal(primary.dataSizeKnown, true);

  // The lazy invariant on a real HTTP transport: enumeration touched no
  // data unit, only header blocks were fetched.
  assert.equal(readsTouchData(reads(), hdus), false, "enumeration must not read any data unit");

  const region = { start: [100, 0], shape: [16, 2] };
  const cut = await readImage(primary, reader, { region });
  assert.deepEqual([...cut.shape], [...region.shape]);
  assert.ok(cut.data instanceof Float32Array);

  // Independent decode: a second reader fetches each pixel via tiny Range
  // requests and decodes with DataView. The oracle is the bytes themselves.
  const raw = new HttpRangeReader(url);
  const expected = new Float32Array(region.shape[0] * region.shape[1]);
  let k = 0;
  for (let i2 = 0; i2 < region.shape[1]; i2++) {
    for (let i1 = 0; i1 < region.shape[0]; i1++) {
      const e = region.start[0] + i1 + N1 * (region.start[1] + i2);
      const b = await raw.read(primary.dataOffset + e * 4, 4);
      expected[k++] = new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, false);
    }
  }
  assert.deepEqual(cut.data, expected);
});
