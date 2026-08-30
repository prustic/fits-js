import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readHdus } from "../hdu/read-hdus.js";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { readTable } from "./table.js";

// Real archive files. Expected values are NOT dumped from astropy: they are
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

// rosat-pspc-rmf HDU 1 (MATRIX): a real ROSAT PSPCB response matrix from the
// HEASARC calibration database, written by a 1994 mission pipeline. It is the
// heap fixture: NAXIS1=22, NAXIS2=729, PCOUNT=74224, and a `PE(34)` column
// whose descriptor carries no leading repeat. Six columns, offsets
// hand-computed from the TFORMs: ENERG_LO 1E @0, ENERG_HI 1E @4, N_GRP 1I @8,
// F_CHAN 1I @10, N_CHAN 1I @12, MATRIX PE @14.
const RMF_ROWS = 729;
const RMF_STRIDE = 22;

test("real ROSAT RMF exposes its variable-length column model", async () => {
  const { bytes } = fixture("rosat-pspc-rmf.fits");
  const { hdus } = readHdus(bytes);
  const t = await readTable(hdus[1], new BytesReader(bytes));

  assert.equal(hdus[1].name, "MATRIX");
  assert.equal(t.totalRows, RMF_ROWS);
  assert.equal(t.warnings.length, 0);
  assert.deepEqual(
    t.columns.map((c) => [c.column.name, c.column.tform.code, c.column.byteOffset]),
    [
      ["ENERG_LO", "E", 0],
      ["ENERG_HI", "E", 4],
      ["N_GRP", "I", 8],
      ["F_CHAN", "I", 10],
      ["N_CHAN", "I", 12],
      ["MATRIX", "P", 14],
    ],
  );

  const matrix = t.columns[5].column;
  assert.equal(matrix.tform.elementCode, "E");
  assert.equal(matrix.tform.maxCount, 34);
  assert.equal(matrix.tform.repeat, 1, "an absent repeat count means 1");
});

test("real ROSAT RMF heap decodes byte-for-byte (independent oracle)", async () => {
  const { bytes, view } = fixture("rosat-pspc-rmf.fits");
  const { hdus } = readHdus(bytes);
  const hdu = hdus[1];
  const t = await readTable(hdu, new BytesReader(bytes));
  const matrix = t.columns[5];
  const values = matrix.values as Float32Array;
  const offsets = matrix.offsets!;

  // No THEAP, so the heap begins right after the main table.
  const heapBase = hdu.dataOffset + RMF_STRIDE * RMF_ROWS;

  let elements = 0;
  for (let row = 0; row < RMF_ROWS; row++) {
    const at = hdu.dataOffset + row * RMF_STRIDE + 14;
    const count = view.getInt32(at, false);
    const heapAt = view.getInt32(at + 4, false);

    assert.equal(offsets[row + 1] - offsets[row], count, `row ${row} length`);
    for (let k = 0; k < count; k++) {
      assert.equal(
        values[offsets[row] + k],
        view.getFloat32(heapBase + heapAt + 4 * k, false),
        `row ${row} element ${k}`,
      );
    }
    elements += count;
  }

  // Every heap byte this file declares is referenced exactly once.
  assert.equal(elements * 4, hdu.header.getNumber("PCOUNT"));
  assert.equal(values.length, elements);
  assert.equal(offsets[RMF_ROWS], values.length);
});

test("real ROSAT RMF row 728 is an empty array, not a null one", async () => {
  const { bytes } = fixture("rosat-pspc-rmf.fits");
  const { hdus } = readHdus(bytes);
  const t = await readTable(hdus[1], new BytesReader(bytes));
  const matrix = t.columns[5];

  assert.equal(matrix.offsets![729] - matrix.offsets![728], 0);
  assert.equal(matrix.mask, undefined, "an empty row is not an undefined value");
});

test("real ROSAT RMF projection fetches only the selected column's heap", async () => {
  const { bytes } = fixture("rosat-pspc-rmf.fits");
  const { hdus } = readHdus(bytes);

  const fixedOnly = countingReader(bytes);
  await readTable(hdus[1], fixedOnly.reader, { columns: ["ENERG_LO"] });
  assert.equal(fixedOnly.bytes(), RMF_STRIDE * RMF_ROWS, "no heap byte is read");

  const withHeap = countingReader(bytes);
  const t = await readTable(hdus[1], withHeap.reader, { rows: { start: 400, count: 1 } });
  assert.equal(t.columns[5].values.length, 33);
  assert.ok(
    withHeap.bytes() < RMF_STRIDE * RMF_ROWS,
    "a single-row range reads less than the whole table",
  );
});
