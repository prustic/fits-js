import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BytesReader, readHdus, readTable } from "@fits-js/core";
import { Table, tableFromIPC, tableToIPC, type Vector } from "apache-arrow";
import { readArrowBatches } from "./batches.js";
import { toArrowTable } from "./table.js";

// Real archive files shared with @fits-js/core. Expected values are decoded
// here straight from the bytes with DataView, not through core, so a core
// and adapter bug that cancel out still fails.

function fixture(name: string) {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../fits-core/test-fixtures/${name}`, import.meta.url)),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { bytes, view, hdus: readHdus(bytes).hdus };
}

function fieldText(bytes: Uint8Array, at: number, width: number): string {
  return new TextDecoder("latin1").decode(bytes.subarray(at, at + width));
}

test("real iue-mef spectrum maps its repeat columns to fixed-size lists", async () => {
  const { bytes, view, hdus } = fixture("iue-mef.fits");
  const hdu = hdus[1];
  const t = toArrowTable(await readTable(hdu, new BytesReader(bytes)));
  const data = hdu.dataOffset;

  assert.deepEqual(
    t.schema.fields.map((f) => `${f.name}:${String(f.type)}`),
    [
      "APERTURE:Utf8",
      "NPOINTS:Int16",
      "WAVELENGTH:Float32",
      "DELTAW:Float32",
      "NET:FixedSizeList[640]<Float32>",
      "BACKGROUND:FixedSizeList[640]<Float32>",
      "SIGMA:FixedSizeList[640]<Float32>",
      "QUALITY:FixedSizeList[640]<Int16>",
      "FLUX:FixedSizeList[640]<Float32>",
    ],
  );

  // Byte offsets from the TFORMs: NPOINTS @5, NET 640E @15, QUALITY 640I @7695.
  assert.equal(t.getChild("NPOINTS")!.get(0), view.getInt16(data + 5, false));
  const net = t.getChild("NET")!.get(0) as Vector;
  const quality = t.getChild("QUALITY")!.get(0) as Vector;
  for (const k of [0, 1, 321, 639]) {
    assert.equal(net.get(k), view.getFloat32(data + 15 + 4 * k, false), `NET[${k}]`);
    assert.equal(quality.get(k), view.getInt16(data + 7695 + 2 * k, false), `QUALITY[${k}]`);
  }
});

test("real ROSAT RMF matrix maps to a List that matches its heap", async () => {
  const { bytes, view, hdus } = fixture("rosat-pspc-rmf.fits");
  const hdu = hdus[1];
  const rowCount = 729;
  const stride = 22;
  const heapBase = hdu.dataOffset + stride * rowCount;

  // Through IPC too, the way the table reaches another Arrow reader.
  const t = tableFromIPC(tableToIPC(toArrowTable(await readTable(hdu, new BytesReader(bytes)))));
  const matrix = t.getChild("MATRIX")!;
  assert.equal(String(matrix.type), "List<Float32>");
  assert.equal(matrix.nullCount, 0);

  for (let row = 0; row < rowCount; row++) {
    const at = hdu.dataOffset + row * stride + 14;
    const count = view.getInt32(at, false);
    const heapAt = view.getInt32(at + 4, false);
    const list = matrix.get(row) as Vector;

    assert.equal(list.length, count, `row ${row} length`);
    for (let k = 0; k < count; k++) {
      assert.equal(list.get(k), view.getFloat32(heapBase + heapAt + 4 * k, false));
    }
  }
});

test("real fos-mef ASCII table maps every field to a nullable scalar", async () => {
  const { bytes, hdus } = fixture("fos-mef.fits");
  const hdu = hdus[1];
  const table = await readTable(hdu, new BytesReader(bytes));
  const t = toArrowTable(table);
  const stride = hdu.header.getNumber("NAXIS1")!;

  assert.ok(t.schema.fields.every((f) => f.nullable));
  assert.deepEqual(
    [...new Set(t.schema.fields.map((f) => String(f.type)))],
    ["Float64", "Int64", "Utf8"],
  );

  for (const { column } of table.columns) {
    const vector = t.getChild(column.name!)!;
    for (let row = 0; row < 2; row++) {
      const text = fieldText(
        bytes,
        hdu.dataOffset + row * stride + column.byteOffset,
        column.byteWidth,
      );
      const got: unknown = vector.get(row);
      if (column.tform.code === "A") {
        assert.equal(got, text.trimEnd(), `${column.name} row ${row}`);
      } else {
        assert.equal(Number(got), Number(text.trim()), `${column.name} row ${row}`);
      }
    }
  }
});

test("real dss-poss2 ASCII table streams in batches that match the bytes", async () => {
  const { bytes, hdus } = fixture("dss-poss2.fits");
  const hdu = hdus[1];
  const batches = [];
  for await (const batch of readArrowBatches(hdu, new BytesReader(bytes), { batchRows: 500 })) {
    batches.push(batch);
  }
  assert.deepEqual(
    batches.map((b) => b.numRows),
    [500, 500, 500, 100],
  );

  const t = new Table(batches);
  assert.deepEqual(
    t.schema.fields.map((f) => f.metadata.get("fits:TUNIT")),
    ["DEGREES", "DEGREES", "ARCSEC", "ARCSEC"],
  );
  for (const [n, field] of t.schema.fields.entries()) {
    const vector = t.getChild(field.name)!;
    for (let row = 0; row < 1600; row++) {
      const text = fieldText(bytes, hdu.dataOffset + row * 24 + n * 6, 6);
      assert.equal(vector.get(row), Number(text.trim()), `${field.name} row ${row}`);
    }
  }
});
