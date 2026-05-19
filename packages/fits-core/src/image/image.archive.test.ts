import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readHdus } from "../hdu/read-hdus.js";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { readImage } from "./image.js";

// Real archive file. The expected pixels are NOT dumped from astropy: they
// are decoded here independently from the committed bytes via DataView, a
// different path than the production decoder, so the test asserts on its own
// authority (differential-testing.md). The astropy cross-check that confirmed
// these bytes was a throwaway oracle and is not committed.
const file = new Uint8Array(
  readFileSync(new URL("../../test-fixtures/fos-mef.fits", import.meta.url)),
);
const view = new DataView(file.buffer, file.byteOffset, file.byteLength);

// fos-mef primary: BITPIX -32, NAXIS=2, NAXIS1=2064 (fastest), NAXIS2=2, no
// BZERO/BSCALE/BLANK. Element (i1, i2) is at dataOffset + (i1 + 2064*i2)*4.
const N1 = 2064;
const N2 = 2;
const DATA_OFFSET = 14400;
const beF32 = (elem: number) => view.getFloat32(DATA_OFFSET + elem * 4, false);

function countingReader(): { reader: RandomAccessReader; bytes: () => number } {
  const inner = new BytesReader(file);
  let total = 0;
  return {
    reader: {
      size: inner.size,
      read: (o, l) => {
        total += l;
        return inner.read(o, l);
      },
    },
    bytes: () => total,
  };
}

test("real fos-mef primary image decodes byte-for-byte (independent oracle)", async () => {
  const { hdus } = readHdus(file);
  const img = await readImage(hdus[0], new BytesReader(file));

  assert.equal(hdus[0].dataOffset, DATA_OFFSET);
  assert.deepEqual(img.shape, [N1, N2]);
  assert.ok(img.data instanceof Float32Array);
  assert.equal(img.data.length, N1 * N2);
  assert.equal(img.bitpix, -32);
  assert.equal(img.bscale, 1);
  assert.equal(img.bzero, 0);
  assert.equal(img.blank, undefined);

  const expected = new Float32Array(N1 * N2);
  for (let e = 0; e < expected.length; e++) expected[e] = beF32(e);
  assert.deepEqual(img.data, expected); // deepEqual treats NaN === NaN
});

test("real fos-mef cutout is correct and reads only the region bytes", async () => {
  const { hdus } = readHdus(file);
  const { reader, bytes } = countingReader();

  const start = [100, 0];
  const shape = [16, 2];
  const img = await readImage(hdus[0], reader, { region: { start, shape } });

  const expected = new Float32Array(shape[0] * shape[1]);
  let k = 0;
  for (let i2 = 0; i2 < shape[1]; i2++) {
    for (let i1 = 0; i1 < shape[0]; i1++) {
      expected[k++] = beF32(start[0] + i1 + N1 * (start[1] + i2));
    }
  }
  assert.deepEqual(img.shape, shape);
  assert.deepEqual(img.data, expected);

  // 16x2 region = 2 runs of 64 bytes; nowhere near the full 16512-byte image.
  assert.ok(bytes() <= 512, `read ${bytes()} bytes for the cutout`);
});
