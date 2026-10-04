import { test } from "node:test";
import assert from "node:assert/strict";
import type { BinaryTform, FitsTable, TableColumn, TableColumnData } from "@fits-js/core";
import { tableFromIPC, tableToIPC, type Table, type Vector } from "apache-arrow";
import * as arrow17 from "apache-arrow-17";
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

function column(index: number, name: string, tform: string, extra: Partial<TableColumn> = {}) {
  const [, repeat, code, elementCode] = /^(\d*)([A-Z])([A-Z]?)/.exec(tform)!;
  const binary = {
    kind: "binary",
    code,
    repeat: repeat === "" ? 1 : Number(repeat),
    elementCode: elementCode === "" ? undefined : elementCode,
    raw: tform,
  } as BinaryTform;
  return { index, name, tform: binary, tscal: 1, tzero: 0, byteWidth: 0, byteOffset: 0, ...extra };
}

/** One column per mapping row, two rows, with nulls where the type allows. */
function everyType(): FitsTable {
  const columns: TableColumnData[] = [
    { column: column(0, "b", "1B"), values: Uint8Array.of(1, 255) },
    {
      column: column(1, "i", "1I", { tnull: -1 }),
      values: Int16Array.of(-1, 2),
      mask: Uint8Array.of(1, 0),
    },
    { column: column(2, "u", "1J"), values: Uint32Array.of(0, 4294967295) },
    { column: column(3, "k", "1K"), values: BigInt64Array.of(-(2n ** 63n), 3n) },
    { column: column(4, "e", "2E", { unit: "Jy" }), values: Float32Array.of(1, 2, 3, 4) },
    { column: column(5, "z", "0D"), values: new Float64Array(0) },
    {
      column: column(6, "l", "1L"),
      values: Uint8Array.of(1, 0),
      mask: Uint8Array.of(0, 1),
    },
    { column: column(7, "x", "11X"), values: Uint8Array.from({ length: 22 }, (_, i) => i & 1) },
    { column: column(8, "a", "8A"), values: ["NGC 224", "café"] },
    { column: column(9, "c", "2C"), values: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8) },
    {
      column: column(10, "pj", "1PJ"),
      values: Int32Array.of(7, 8, 9),
      offsets: Int32Array.of(0, 0, 3),
    },
    {
      column: column(11, "pm", "1QM"),
      values: Float64Array.of(1, 2),
      offsets: Int32Array.of(0, 2, 2),
    },
    {
      column: column(12, "pl", "1PL"),
      values: Uint8Array.of(1, 0, 1),
      offsets: Int32Array.of(0, 1, 3),
      mask: Uint8Array.of(0, 1, 0),
    },
  ];
  return { rowCount: 2, totalRows: 2, columns, warnings: [] };
}

function describe(t: Table | arrow17.Table): string[] {
  return t.schema.fields.map(
    (f) => `${f.name}:${String(f.type)}${f.nullable ? "?" : ""} ${JSON.stringify([...f.metadata])}`,
  );
}

function rows(t: Table | arrow17.Table): string {
  return JSON.stringify(t.toArray(), (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
}

test("every column type survives an IPC stream round trip", () => {
  const original = toArrowTable(everyType());
  const back = tableFromIPC(tableToIPC(original, "stream"));

  assert.deepEqual(describe(back), describe(original));
  assert.equal(rows(back), rows(original));
  assert.deepEqual(
    back.schema.fields.map((f) => back.getChild(f.name)!.nullCount),
    [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(items(at(back.getChild("pl"), 1)), [null, true]);
});

test("the IPC file format round-trips too", () => {
  const original = toArrowTable(everyType());
  const back = tableFromIPC(tableToIPC(original, "file"));
  assert.equal(rows(back), rows(original));
});

test("IPC bytes cross between apache-arrow 17 and the installed version", () => {
  // duckdb-wasm bundles arrow 17, so its reader sees our bytes this way.
  const original = toArrowTable(everyType());
  const in17 = arrow17.tableFromIPC(tableToIPC(original, "stream"));
  assert.deepEqual(describe(in17), describe(original));
  assert.equal(rows(in17), rows(original));

  const back = tableFromIPC(arrow17.tableToIPC(in17, "stream"));
  assert.deepEqual(describe(back), describe(original));
  assert.equal(rows(back), rows(original));
});

test("an empty table round-trips with its schema", () => {
  const empty = everyType();
  const zero: FitsTable = {
    ...empty,
    rowCount: 0,
    columns: [
      { column: column(0, "j", "2J"), values: new Int32Array(0) },
      { column: column(1, "pj", "1PJ"), values: new Int32Array(0), offsets: Int32Array.of(0) },
      { column: column(2, "a", "4A"), values: [] },
    ],
  };
  const back = tableFromIPC(tableToIPC(toArrowTable(zero), "stream"));
  assert.equal(back.numRows, 0);
  assert.deepEqual(
    back.schema.fields.map((f) => String(f.type)),
    ["FixedSizeList[2]<Int32>", "List<Int32>", "Utf8"],
  );

  const none = tableFromIPC(tableToIPC(toArrowTable({ ...empty, columns: [] }), "stream"));
  assert.equal(none.schema.fields.length, 0);
});
