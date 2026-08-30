import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpRangeReader,
  openFits,
  readTable,
  type Hdu,
  type RandomAccessReader,
} from "@fits-js/core";

const URL = "http://localhost:18080/iue-mef.fits";
const ROW_WIDTH = 11535; // NAXIS1 of the MELO BINTABLE

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

test("openFits + readTable end to end over real HTTP Range (containerized nginx)", async () => {
  const { reader, reads } = countingReader(new HttpRangeReader(URL));
  const { hdus } = await openFits(reader);
  const melo = hdus[1];

  assert.equal(melo.type, "bintable");
  assert.equal(melo.header.getNumber("NAXIS1"), ROW_WIDTH);
  assert.equal(melo.header.getNumber("NAXIS2"), 1);

  // The lazy invariant on real HTTP: enumeration touched no data unit.
  assert.equal(readsTouchData(reads(), hdus), false, "enumeration must not read any data unit");
  const enumerationReads = reads().length;

  const t = await readTable(melo, reader, { columns: ["FLUX", "NPOINTS"] });
  assert.equal(t.rowCount, 1);
  assert.equal(t.columns[0].column.name, "FLUX");
  assert.ok(t.columns[0].values instanceof Float32Array);
  assert.equal(t.columns[0].values.length, 640);
  assert.deepEqual([...(t.columns[1].values as Int16Array)], [640]);

  // Every readTable request lands in the row region or the heap region,
  // never in the 2880-byte padding that follows them. This table declares
  // PCOUNT 0, so its heap region is empty and every read is a row read.
  const pcount = melo.header.getNumber("PCOUNT") ?? 0;
  const rowEnd = melo.dataOffset + ROW_WIDTH * 1;
  const heapEnd = rowEnd + pcount;
  assert.equal(pcount, 0);

  const tableReads = reads().slice(enumerationReads);
  assert.ok(tableReads.length > 0);
  for (const [o, l] of tableReads) {
    assert.ok(o >= melo.dataOffset, "reads must start inside the data unit");
    assert.ok(o + l <= heapEnd, "reads must not run past the rows and heap");
  }

  // Independent decode: a second reader fetches spot elements via tiny Range
  // requests and decodes with DataView. The oracle is the bytes themselves.
  const raw = new HttpRangeReader(URL);
  const flux = t.columns[0].values;
  for (const k of [0, 1, 100, 321, 639]) {
    const b = await raw.read(melo.dataOffset + 8975 + 4 * k, 4);
    const expected = new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, false);
    assert.equal(flux[k], expected, `FLUX[${k}]`);
  }
});
