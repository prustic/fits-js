import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpRangeReader,
  openFits,
  readImage,
  type Hdu,
  type RandomAccessReader,
} from "@fits-js/core";

// nginx in docker compose (see docker-compose.yml) serves the committed
// real-archive fixtures with native Range support; the npm `test:integration`
// script brings it up and tears it down around the run.
const URL = "http://localhost:18080/fos-mef.fits";
const N1 = 2064; // primary NAXIS1
const N2 = 2; // primary NAXIS2

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

test("openFits + readImage cutout end to end over real HTTP Range (containerized nginx)", async () => {
  const { reader, reads } = countingReader(new HttpRangeReader(URL));
  const { hdus } = await openFits(reader);
  const primary = hdus[0];

  assert.equal(primary.type, "primary");
  assert.equal(primary.header.getNumber("BITPIX"), -32);
  assert.equal(primary.header.getNumber("NAXIS"), 2);
  assert.equal(primary.header.getNumber("NAXIS1"), N1);
  assert.equal(primary.header.getNumber("NAXIS2"), N2);
  assert.equal(primary.dataSizeKnown, true);

  // The lazy invariant on real HTTP: enumeration touched no data unit.
  assert.equal(readsTouchData(reads(), hdus), false, "enumeration must not read any data unit");

  const region = { start: [100, 0], shape: [16, 2] };
  const cut = await readImage(primary, reader, { region });
  assert.deepEqual([...cut.shape], [...region.shape]);
  assert.ok(cut.data instanceof Float32Array);

  // Independent decode: a second reader fetches each pixel via tiny Range
  // requests and decodes with DataView. The oracle is the bytes themselves.
  const raw = new HttpRangeReader(URL);
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
