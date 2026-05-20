import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpRangeReader,
  openFits,
  readImage,
  type Hdu,
  type RandomAccessReader,
} from "@fits-js/core";

// A stable public sample on NASA GSFC: a real HST/WFPC2 cube, BITPIX -32,
// NAXIS=3 with shape 200x200x4. Static URL, supports HTTP Range. The test
// skips cleanly if the host is unreachable, so a third-party outage cannot
// red the build.
const URL = "https://fits.gsfc.nasa.gov/samples/WFPC2u5780205r_c0fx.fits";
const N1 = 200;
const N2 = 200;

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(URL, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return res.ok || res.status === 405; // 405 hosts can still serve GET + Range
  } catch {
    return false;
  }
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

test("openFits + readImage cutout against a real archive over live HTTP Range", async (t) => {
  if (!(await reachable())) {
    t.skip(`archive unreachable; skipping live integration test (${URL})`);
    return;
  }

  const { reader, reads } = countingReader(new HttpRangeReader(URL));
  const { hdus } = await openFits(reader);
  const primary = hdus[0];

  assert.equal(primary.type, "primary");
  assert.equal(primary.header.getNumber("BITPIX"), -32);
  assert.equal(primary.header.getNumber("NAXIS"), 3);
  assert.equal(primary.header.getNumber("NAXIS1"), N1);
  assert.equal(primary.header.getNumber("NAXIS2"), N2);
  assert.equal(primary.header.getNumber("NAXIS3"), 4);
  assert.equal(primary.dataSizeKnown, true);

  // Lazy invariant on a real remote file: enumeration touched no data unit.
  assert.equal(readsTouchData(reads(), hdus), false, "enumeration must not read any data unit");

  const region = { start: [10, 20, 1], shape: [4, 3, 1] };
  const cut = await readImage(primary, reader, { region });
  assert.deepEqual([...cut.shape], [...region.shape]);
  assert.ok(cut.data instanceof Float32Array);

  // Independent decode: a second reader fetches each pixel via tiny Range
  // requests and decodes with DataView. The oracle is the bytes themselves.
  const raw = new HttpRangeReader(URL);
  const expected = new Float32Array(region.shape[0] * region.shape[1] * region.shape[2]);
  let k = 0;
  for (let i3 = 0; i3 < region.shape[2]; i3++) {
    for (let i2 = 0; i2 < region.shape[1]; i2++) {
      for (let i1 = 0; i1 < region.shape[0]; i1++) {
        const e = region.start[0] + i1 + N1 * (region.start[1] + i2 + N2 * (region.start[2] + i3));
        const b = await raw.read(primary.dataOffset + e * 4, 4);
        expected[k++] = new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, false);
      }
    }
  }
  assert.deepEqual(cut.data, expected);
});
