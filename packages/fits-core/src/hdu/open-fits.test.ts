import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { NodeFileReader } from "../io/node-file-reader.js";
import { readImage } from "../image/image.js";
import type { Hdu } from "./hdu.js";
import { readHdus, openFits } from "./read-hdus.js";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../test-fixtures/${name}`, import.meta.url)));
}

/** The structural fields openFits must reproduce identically to readHdus. */
const shape = (hdus: readonly Hdu[]) =>
  hdus.map((h) => ({
    index: h.index,
    type: h.type,
    name: h.name,
    version: h.version,
    dataOffset: h.dataOffset,
    dataByteLength: h.dataByteLength,
    dataSizeKnown: h.dataSizeKnown,
    cards: h.header.cards.length,
  }));

function countingReader(bytes: Uint8Array): { reader: RandomAccessReader; read: () => number } {
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
    read: () => total,
  };
}

for (const name of ["fos-mef.fits", "dss-poss2.fits"]) {
  test(`openFits matches readHdus structurally on ${name}`, async () => {
    const bytes = fixture(name);
    const sync = readHdus(bytes);
    const async_ = await openFits(new BytesReader(bytes));
    assert.deepEqual(shape(async_.hdus), shape(sync.hdus));
    assert.deepEqual(async_.warnings, sync.warnings);
  });
}

test("openFits enumerates without materializing the data units", async () => {
  const bytes = fixture("fos-mef.fits");
  const { reader, read } = countingReader(bytes);
  const { hdus } = await openFits(reader);

  assert.ok(hdus.length >= 1);
  assert.equal(hdus[0].dataSizeKnown, true); // derived from reader.size, no data read
  // Only header blocks were fetched: far less than the whole file.
  assert.ok(read() < bytes.length, `read ${read()} of ${bytes.length} bytes`);
});

test("an openFits HDU drives a lazy readImage cutout end to end", async () => {
  const bytes = fixture("fos-mef.fits");
  const { reader, read } = countingReader(bytes);
  const { hdus } = await openFits(reader);

  const enumBytes = read();
  const img = await readImage(hdus[0], reader, { region: { start: [100, 0], shape: [16, 2] } });
  assert.deepEqual([...img.shape], [16, 2]);

  // The whole thing (enumerate + cutout) stays well under the file size.
  assert.ok(read() < bytes.length, `read ${read()} of ${bytes.length} bytes`);
  assert.ok(read() > enumBytes); // the cutout did fetch its region
});

test("size-undefined source: header-declared length is trusted (dataSizeKnown true)", async () => {
  const bytes = fixture("dss-poss2.fits");
  const unsized: RandomAccessReader = {
    size: undefined,
    read: (o, l) => Promise.resolve(bytes.subarray(o, Math.min(o + l, bytes.length))),
  };
  const { hdus } = await openFits(unsized);
  assert.equal(hdus[0].dataSizeKnown, true);
  assert.equal(hdus[0].type, "primary");
});

test("openFits over a real NodeFileReader matches readHdus", async () => {
  const path = new URL("../../test-fixtures/fos-mef.fits", import.meta.url);
  const reader = await NodeFileReader.open(path);
  try {
    const async_ = await openFits(reader);
    const sync = readHdus(new Uint8Array(readFileSync(path)));
    assert.deepEqual(shape(async_.hdus), shape(sync.hdus));
  } finally {
    await reader.close();
  }
});
