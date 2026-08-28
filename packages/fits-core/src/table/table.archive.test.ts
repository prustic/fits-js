import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readHdus } from "../hdu/read-hdus.js";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { readTable } from "./table.js";

// Real archive file. Expected values are NOT dumped from astropy: they are
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

// iue-mef HDU 1 (MELO): a single-row IUE spectrum BINTABLE, dataOffset 34560,
// NAXIS1=11535, NAXIS2=1. Nine columns, offsets hand-computed from the TFORMs:
// APERTURE 5A @0, NPOINTS 1I @5, WAVELENGTH 1E @7, DELTAW 1E @11, NET 640E
// @15, BACKGROUND 640E @2575, SIGMA 640E @5135, QUALITY 640I @7695, FLUX
// 640E @8975.
const DATA = 34560;

test("real iue-mef BINTABLE column model matches the hand-read header", async () => {
  const { bytes } = fixture("iue-mef.fits");
  const { hdus } = readHdus(bytes);
  const t = await readTable(hdus[1], new BytesReader(bytes));

  assert.equal(t.totalRows, 1);
  assert.equal(t.rowCount, 1);
  assert.equal(t.warnings.length, 0);
  assert.deepEqual(
    t.columns.map((c) => [
      c.column.name,
      c.column.tform.code,
      c.column.tform.repeat,
      c.column.byteOffset,
    ]),
    [
      ["APERTURE", "A", 5, 0],
      ["NPOINTS", "I", 1, 5],
      ["WAVELENGTH", "E", 1, 7],
      ["DELTAW", "E", 1, 11],
      ["NET", "E", 640, 15],
      ["BACKGROUND", "E", 640, 2575],
      ["SIGMA", "E", 640, 5135],
      ["QUALITY", "I", 640, 7695],
      ["FLUX", "E", 640, 8975],
    ],
  );
  const last = t.columns[8].column;
  assert.equal(last.byteOffset + last.byteWidth, 11535);
});

test("real iue-mef values decode byte-for-byte (independent oracle)", async () => {
  const { bytes, view } = fixture("iue-mef.fits");
  const { hdus } = readHdus(bytes);
  const t = await readTable(hdus[1], new BytesReader(bytes));

  // Scalar columns, decoded in full from the raw bytes.
  const aperture = new TextDecoder("latin1")
    .decode(bytes.subarray(DATA, DATA + 5))
    .replace(/ +$/, "");
  assert.deepEqual(t.columns[0].values, [aperture]);
  assert.deepEqual([...(t.columns[1].values as Int16Array)], [view.getInt16(DATA + 5, false)]);
  assert.deepEqual([...(t.columns[2].values as Float32Array)], [view.getFloat32(DATA + 7, false)]);
  assert.deepEqual([...(t.columns[3].values as Float32Array)], [view.getFloat32(DATA + 11, false)]);

  // Array columns, spot-checked across their span.
  const flux = t.columns[8].values as Float32Array;
  const quality = t.columns[7].values as Int16Array;
  assert.equal(flux.length, 640);
  for (const k of [0, 1, 100, 321, 639]) {
    assert.equal(flux[k], view.getFloat32(DATA + 8975 + 4 * k, false), `FLUX[${k}]`);
    assert.equal(quality[k], view.getInt16(DATA + 7695 + 2 * k, false), `QUALITY[${k}]`);
    assert.equal(
      (t.columns[4].values as Float32Array)[k],
      view.getFloat32(DATA + 15 + 4 * k, false),
      `NET[${k}]`,
    );
  }
});

test("real iue-mef projection matches the corresponding full-read columns", async () => {
  const { bytes } = fixture("iue-mef.fits");
  const { hdus } = readHdus(bytes);
  const reader = new BytesReader(bytes);

  const full = await readTable(hdus[1], reader);
  const projected = await readTable(hdus[1], reader, { columns: ["FLUX", "npoints"] });

  assert.equal(projected.columns.length, 2);
  assert.deepEqual(projected.columns[0].values, full.columns[8].values);
  assert.deepEqual(projected.columns[1].values, full.columns[1].values);
});

test("real iue-mef whole-table read fetches exactly the data bytes", async () => {
  const { bytes } = fixture("iue-mef.fits");
  const { hdus } = readHdus(bytes);
  const counting = countingReader(bytes);

  await readTable(hdus[1], counting.reader);
  assert.equal(counting.bytes(), 11535);
});
