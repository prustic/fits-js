import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BytesReader,
  FitsStructureError,
  readHdus,
  readTable,
  type Hdu,
  type RandomAccessReader,
} from "@fits-js/core";
import {
  RecordBatchStreamWriter,
  Table,
  tableFromIPC,
  type RecordBatch,
  type Vector,
} from "apache-arrow";
import { readArrowBatches, type ReadArrowBatchesOptions } from "./batches.js";
import { toArrowTable } from "./table.js";

/** Walk nested vectors: `at(v, 1, 2)` is `v.get(1).get(2)`. */
function at(vector: Vector | null, ...path: number[]): unknown {
  let node: unknown = vector;
  for (const i of path) {
    node = (node as Vector).get(i);
  }
  return node;
}

/** A vector's elements as plain values. */
function items(value: unknown): unknown[] {
  return [...(value as Iterable<unknown>)];
}

/** Wraps a reader to count the bytes it was asked for. */
function counting(bytes: Uint8Array): RandomAccessReader & { fetched: number } {
  const inner = new BytesReader(bytes);
  const reader = {
    fetched: 0,
    size: inner.size,
    read(offset: number, length: number) {
      reader.fetched += length;
      return inner.read(offset, length);
    },
  };
  return reader;
}

function fixture(name: string): { hdus: readonly Hdu[]; bytes: Uint8Array } {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../fits-core/test-fixtures/${name}`, import.meta.url)),
  );
  return { hdus: readHdus(bytes).hdus, bytes };
}

// Fixed-format card; value right-justified to column 30.
function card(kw: string, val: number | boolean | string): string {
  const v =
    typeof val === "boolean"
      ? val
        ? "T"
        : "F"
      : typeof val === "string"
        ? `'${val}'`
        : String(val);
  return `${kw.padEnd(8)}= ${v.padStart(20)}`;
}

function block(cards: string[]): string {
  const h = [...cards, "END"].map((c) => c.padEnd(80)).join("");
  return h.padEnd(Math.ceil(h.length / 2880) * 2880);
}

/** A primary HDU plus one BINTABLE built from `cards` and `data`. */
function bintable(cards: string[], data: Uint8Array): { hdu: Hdu; bytes: Uint8Array } {
  const head = block([card("SIMPLE", true), card("BITPIX", 8), card("NAXIS", 0)]);
  const ext = block(["XTENSION= 'BINTABLE'", card("BITPIX", 8), card("NAXIS", 2), ...cards]);
  const bytes = new Uint8Array(head.length + ext.length + Math.ceil(data.length / 2880) * 2880);
  new TextEncoder().encodeInto(head + ext, bytes);
  bytes.set(data, head.length + ext.length);
  return { hdu: readHdus(bytes).hdus[1], bytes };
}

async function collect(
  hdu: Hdu,
  reader: RandomAccessReader,
  opts?: ReadArrowBatchesOptions,
): Promise<RecordBatch[]> {
  const batches: RecordBatch[] = [];
  for await (const batch of readArrowBatches(hdu, reader, opts)) {
    batches.push(batch);
  }
  return batches;
}

function rows(t: Table): string {
  return JSON.stringify(t.toArray());
}

function types(batch: RecordBatch | Table): string[] {
  return batch.schema.fields.map((f) => `${f.name}:${String(f.type)}${f.nullable ? "?" : ""}`);
}

const rosat = fixture("rosat-pspc-rmf.fits");
const matrix = rosat.hdus[1];

test("batches split the table and concatenate to the whole-table conversion", async () => {
  const reader = new BytesReader(rosat.bytes);
  const batches = await collect(matrix, reader, { batchRows: 100 });
  const whole = toArrowTable(await readTable(matrix, reader));

  assert.deepEqual(
    batches.map((b) => b.numRows),
    [100, 100, 100, 100, 100, 100, 100, 29],
  );
  for (const batch of batches) {
    assert.deepEqual(types(batch), types(whole));
  }
  assert.equal(rows(new Table(batches)), rows(whole));
});

test("batches stream through an IPC writer and read back whole", async () => {
  const reader = new BytesReader(rosat.bytes);
  const writer = new RecordBatchStreamWriter();
  for await (const batch of readArrowBatches(matrix, reader, { batchRows: 300 })) {
    writer.write(batch);
  }
  writer.finish();

  const back = tableFromIPC(writer.toUint8Array(true));
  assert.equal(back.batches.length, 3);
  assert.equal(rows(back), rows(toArrowTable(await readTable(matrix, reader))));
});

test("rows limits the range and batchRows splits it", async () => {
  const reader = new BytesReader(rosat.bytes);
  const batches = await collect(matrix, reader, {
    rows: { start: 50, count: 250 },
    batchRows: 100,
  });
  const whole = toArrowTable(await readTable(matrix, reader));

  assert.deepEqual(
    batches.map((b) => b.numRows),
    [100, 100, 50],
  );
  assert.equal(JSON.stringify(batches[0].get(0)), JSON.stringify(whole.get(50)));
  assert.equal(JSON.stringify(batches[2].get(49)), JSON.stringify(whole.get(299)));
});

test("columns projects by name and index, in selection order", async () => {
  const batches = await collect(matrix, new BytesReader(rosat.bytes), {
    columns: ["matrix", 0],
    batchRows: 400,
  });
  assert.deepEqual(types(batches[0]), ["MATRIX:List<Float32>", "ENERG_LO:Float32"]);
});

test("an empty range yields one batch that still carries the schema", async () => {
  const reader = counting(rosat.bytes);
  const batches = await collect(matrix, reader, { rows: { start: 729, count: 0 } });

  assert.equal(batches.length, 1);
  assert.equal(batches[0].numRows, 0);
  assert.equal(batches[0].schema.fields.length, 6);
  assert.equal(reader.fetched, 0, "no row bytes are fetched");
});

test("the default batch size counts table and heap bytes per row", async () => {
  // 1 MiB rows plus 10 MiB of heap averaged over 10 rows: 2 MiB a row, so 8
  // rows fit in 16 MiB. Without the heap share it would be all 10.
  const naxis1 = 1024 * 1024;
  const { hdu, bytes } = bintable(
    [
      card("NAXIS1", naxis1),
      card("NAXIS2", 10),
      card("PCOUNT", 10 * naxis1),
      card("GCOUNT", 1),
      card("TFIELDS", 1),
      card("TFORM1", `${naxis1}B`),
    ],
    new Uint8Array(20 * naxis1),
  );
  const batches = await collect(hdu, new BytesReader(bytes));
  assert.deepEqual(
    batches.map((b) => b.numRows),
    [8, 2],
  );

  const dss = fixture("dss-poss2.fits");
  const all = await collect(dss.hdus[1], new BytesReader(dss.bytes));
  assert.deepEqual(
    all.map((b) => b.numRows),
    [1600],
  );
});

test("an invalid batchRows is refused before any read", async () => {
  for (const batchRows of [0, -1, 1.5, Number.NaN]) {
    const reader = counting(rosat.bytes);
    await assert.rejects(collect(matrix, reader, { batchRows }), RangeError);
    assert.equal(reader.fetched, 0);
  }
});

test("rows out of range fail the way readTable does", async () => {
  const reader = new BytesReader(rosat.bytes);
  const direct = await readTable(matrix, reader, { rows: { start: 700, count: 30 } }).catch(
    (e: unknown) => e as Error,
  );

  await assert.rejects(collect(matrix, reader, { rows: { start: 700, count: 30 } }), (e) => {
    assert.ok(e instanceof FitsStructureError);
    assert.equal(e.hduIndex, 1);
    assert.equal(e.message, (direct as Error).message);
    return true;
  });
  await assert.rejects(
    collect(matrix, reader, { rows: { start: 0, count: -1 } }),
    /is not a valid range/,
  );
});

test("a non-table HDU is refused by readTable", async () => {
  await assert.rejects(
    collect(rosat.hdus[0], new BytesReader(rosat.bytes)),
    /HDU 0 is not a table/,
  );
});

test("an abort stops the stream before or between batches", async () => {
  const reader = new BytesReader(rosat.bytes);
  await assert.rejects(collect(matrix, reader, { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });

  const controller = new AbortController();
  const stream = readArrowBatches(matrix, reader, { batchRows: 100, signal: controller.signal });
  assert.equal((await stream.next()).done, false);
  controller.abort();
  await assert.rejects(stream.next(), { name: "AbortError" });
});

test("breaking out early stops reading", async () => {
  const full = counting(rosat.bytes);
  await collect(matrix, full, { batchRows: 100 });

  const partial = counting(rosat.bytes);
  for await (const batch of readArrowBatches(matrix, partial, { batchRows: 100 })) {
    assert.equal(batch.numRows, 100);
    break;
  }
  assert.ok(partial.fetched < full.fetched / 4, `${partial.fetched} of ${full.fetched}`);
});

/** Six rows of L, K and 3X; no PCOUNT card, and one invalid logical byte. */
function logicalTable() {
  const T = 0x54;
  const F = 0x46;
  const logicals = [T, F, 0, T, 0x02, F];
  const data = new Uint8Array(6 * 10);
  const view = new DataView(data.buffer);
  logicals.forEach((l, row) => {
    data[row * 10] = l;
    view.setBigInt64(row * 10 + 1, BigInt(row) - 3n, false);
    data[row * 10 + 9] = 0b1010_0000;
  });

  return bintable(
    [
      card("NAXIS1", 10),
      card("NAXIS2", 6),
      card("GCOUNT", 1),
      card("TFIELDS", 3),
      card("TTYPE1", "FLAG"),
      card("TFORM1", "L"),
      card("TTYPE2", "ID"),
      card("TFORM2", "K"),
      card("TTYPE3", "BITS"),
      card("TFORM3", "3X"),
    ],
    data,
  );
}

test("logical, 64-bit and bit columns stream with their nulls", async () => {
  const { hdu, bytes } = logicalTable();
  const t = new Table(await collect(hdu, new BytesReader(bytes), { batchRows: 4 }));

  assert.deepEqual(types(t), ["FLAG:Bool?", "ID:Int64", "BITS:FixedSizeList[3]<Bool>"]);
  assert.deepEqual(items(t.getChild("FLAG")), [true, false, null, true, null, false]);
  assert.deepEqual(items(t.getChild("ID")), [-3n, -2n, -1n, 0n, 1n, 2n]);
  assert.deepEqual(items(at(t.getChild("BITS"), 5)), [true, false, true]);
});

test("onWarning hears each distinct warning once per stream", async () => {
  const { hdu, bytes } = logicalTable();
  const heard: string[] = [];
  await collect(hdu, new BytesReader(bytes), { batchRows: 2, onWarning: (w) => heard.push(w) });

  assert.equal(heard.length, 2, heard.join("\n"));
  assert.match(heard[0], /PCOUNT is missing/);
  assert.match(heard[1], /logical bytes outside T\/F\/0x00/);

  // Without a listener, warnings are dropped rather than thrown.
  assert.equal((await collect(hdu, new BytesReader(bytes), { batchRows: 2 })).length, 3);
});

test("warnings name rows counted from the start of the table", async () => {
  // 1PJ(1): row 3 holds two elements, one more than declared.
  const counts = [1, 1, 1, 2, 1];
  const data = new Uint8Array(5 * 8 + 6 * 4);
  const view = new DataView(data.buffer);
  let heap = 0;
  counts.forEach((count, row) => {
    view.setInt32(row * 8, count, false);
    view.setInt32(row * 8 + 4, heap * 4, false);
    heap += count;
  });
  const { hdu, bytes } = bintable(
    [
      card("NAXIS1", 8),
      card("NAXIS2", 5),
      card("PCOUNT", 24),
      card("GCOUNT", 1),
      card("TFIELDS", 1),
      card("TFORM1", "1PJ(1)"),
    ],
    data,
  );

  const heard: string[] = [];
  await collect(hdu, new BytesReader(bytes), { batchRows: 2, onWarning: (w) => heard.push(w) });
  assert.equal(heard.length, 1);
  assert.match(heard[0], /row 3 holds 2 elements/);
});
