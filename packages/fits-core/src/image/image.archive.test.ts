import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readHdus } from "../hdu/read-hdus.js";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { readImage } from "./image.js";

// Real archive files. Expected pixels are NOT dumped from astropy: they are
// decoded here independently from the committed bytes via DataView, a
// different path than the production decoder, so the test asserts on its own
// authority (differential-testing.md). The astropy cross-check that confirmed
// these bytes was a throwaway oracle and is not committed.

function fixture(name: string): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../test-fixtures/${name}`, import.meta.url)),
  );
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

function countingReader(bytes: Uint8Array): { reader: RandomAccessReader; bytes: () => number } {
  const inner = new BytesReader(bytes);
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

// fos-mef primary: BITPIX -32, NAXIS=2, NAXIS1=2064 (fastest), NAXIS2=2, no
// BZERO/BSCALE/BLANK. Element (i1, i2) is at dataOffset + (i1 + 2064*i2)*4.
test("real fos-mef primary image decodes byte-for-byte (independent oracle)", async () => {
  const { bytes, view } = fixture("fos-mef.fits");
  const N1 = 2064;
  const N2 = 2;
  const beF32 = (e: number) => view.getFloat32(14400 + e * 4, false);

  const { hdus } = readHdus(bytes);
  const img = await readImage(hdus[0], new BytesReader(bytes));

  assert.equal(hdus[0].dataOffset, 14400);
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
  const { bytes, view } = fixture("fos-mef.fits");
  const N1 = 2064;
  const beF32 = (e: number) => view.getFloat32(14400 + e * 4, false);

  const { hdus } = readHdus(bytes);
  const { reader, bytes: counted } = countingReader(bytes);

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
  assert.ok(counted() <= 512, `read ${counted()} bytes for the cutout`);
});

// dss-poss2: a real POSS-II cutout, BITPIX 16, NAXIS=2, 119x119, no
// BZERO/BSCALE/BLANK. Adds real big-endian Int16 decode coverage (the only
// other real fixture is fos-mef's -32 float); the scaled/unsigned path stays
// synthetic-only until a real scaled file is sourced (roadmap 1.7).
test("real DSS POSS-II image decodes as big-endian Int16 (no scaling)", async () => {
  const { bytes, view } = fixture("dss-poss2.fits");
  const N = 119;
  const beI16 = (e: number) => view.getInt16(14400 + e * 2, false);

  const { hdus } = readHdus(bytes);
  const img = await readImage(hdus[0], new BytesReader(bytes));

  assert.equal(hdus[0].dataOffset, 14400);
  assert.deepEqual(img.shape, [N, N]);
  assert.ok(img.data instanceof Int16Array);
  assert.equal(img.data.length, N * N);
  assert.equal(img.bitpix, 16);
  assert.equal(img.bscale, 1);
  assert.equal(img.bzero, 0);
  assert.equal(img.blank, undefined);

  const expected = new Int16Array(N * N);
  for (let e = 0; e < expected.length; e++) expected[e] = beI16(e);
  assert.deepEqual(img.data, expected);
});

test("real DSS cutout is correct and reads only the region bytes", async () => {
  const { bytes, view } = fixture("dss-poss2.fits");
  const N = 119;
  const beI16 = (e: number) => view.getInt16(14400 + e * 2, false);

  const { hdus } = readHdus(bytes);
  const { reader, bytes: counted } = countingReader(bytes);

  const start = [10, 5];
  const shape = [8, 4];
  const img = await readImage(hdus[0], reader, { region: { start, shape } });

  const expected = new Int16Array(shape[0] * shape[1]);
  let k = 0;
  for (let i2 = 0; i2 < shape[1]; i2++) {
    for (let i1 = 0; i1 < shape[0]; i1++) {
      expected[k++] = beI16(start[0] + i1 + N * (start[1] + i2));
    }
  }
  assert.deepEqual(img.shape, shape);
  assert.deepEqual(img.data, expected);

  // 8x4 region = 4 runs of 16 bytes; far under the full 28322-byte image.
  assert.ok(counted() <= 256, `read ${counted()} bytes for the cutout`);
});
