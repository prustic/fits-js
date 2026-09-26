import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AsciiTform,
  BinaryTform,
  ColumnTypeCode,
  FitsTable,
  TableColumn,
  TableColumnData,
} from "@fits-js/core";
import type { Data, Vector } from "apache-arrow";
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

type ElementCode = Exclude<ColumnTypeCode, "P" | "Q">;

function bin(code: ColumnTypeCode, repeat = 1, elementCode?: ElementCode): BinaryTform {
  const raw = elementCode ? `${repeat}${code}${elementCode}` : `${repeat}${code}`;
  return { kind: "binary", code, repeat, elementCode, raw };
}

function asc(code: AsciiTform["code"], width: number): AsciiTform {
  return { kind: "ascii", code, width, raw: `${code}${width}` };
}

let nextIndex = 0;

function column(
  name: string | undefined,
  tform: BinaryTform | AsciiTform,
  extra: Partial<TableColumn> = {},
): TableColumn {
  return {
    index: nextIndex++,
    name,
    tform,
    tscal: 1,
    tzero: 0,
    byteWidth: 0,
    byteOffset: 0,
    ...extra,
  };
}

function table(rowCount: number, ...columns: TableColumnData[]): FitsTable {
  return { rowCount, totalRows: rowCount, columns, warnings: [] };
}

/** The Data of the only column of a one-column table. */
function only(t: FitsTable): { data: Data; vector: Vector } {
  const arrow = toArrowTable(t);
  return { data: arrow.batches[0].data.children[0], vector: arrow.getChildAt(0)! };
}

function sameMemory(arrowBuffer: unknown, values: ArrayBufferView): boolean {
  const view = arrowBuffer as ArrayBufferView;
  return view.buffer === values.buffer && view.byteOffset === values.byteOffset;
}

test("scalar integer columns keep their arrays without copying", () => {
  const b = Uint8Array.from([1, 2]);
  const i = Int16Array.from([-3, 4]);
  const j = Int32Array.from([5, -6]);
  const k = BigInt64Array.from([7n, -(2n ** 62n)]);
  const arrow = toArrowTable(
    table(
      2,
      { column: column("B", bin("B")), values: b },
      { column: column("I", bin("I")), values: i },
      { column: column("J", bin("J")), values: j },
      { column: column("K", bin("K")), values: k },
    ),
  );

  assert.deepEqual(
    arrow.schema.fields.map((f) => String(f.type)),
    ["Uint8", "Int16", "Int32", "Int64"],
  );
  const children = arrow.batches[0].data.children;
  [b, i, j, k].forEach((values, n) => {
    assert.ok(sameMemory(children[n].values, values), `column ${n} shares memory`);
  });
  assert.equal(arrow.getChild("K")!.get(1), -(2n ** 62n));
});

test("unsigned conventions and TZERO -128 keep their integer types", () => {
  const arrow = toArrowTable(
    table(
      1,
      { column: column("u16", bin("I"), { tzero: 32768 }), values: Uint16Array.of(65535) },
      { column: column("u32", bin("J")), values: Uint32Array.of(4294967295) },
      { column: column("u64", bin("K")), values: BigUint64Array.of(2n ** 64n - 1n) },
      { column: column("s8", bin("B"), { tzero: -128 }), values: Int8Array.of(-128) },
    ),
  );

  assert.deepEqual(
    arrow.schema.fields.map((f) => String(f.type)),
    ["Uint16", "Uint32", "Uint64", "Int8"],
  );
  assert.equal(arrow.getChild("u64")!.get(0), 2n ** 64n - 1n);
  assert.equal(arrow.getChild("s8")!.get(0), -128);
});

test("a scaled column is typed by its Float64 values, not its TFORM", () => {
  const { vector } = only(
    table(2, { column: column("s", bin("J"), { tscal: 0.5 }), values: Float64Array.of(1.5, -2) }),
  );
  assert.equal(String(vector.type), "Float64");
  assert.deepEqual(items(vector), [1.5, -2]);
});

test("float NaN stays a value and the field is not nullable", () => {
  const arrow = toArrowTable(
    table(2, { column: column("E", bin("E")), values: Float32Array.of(NaN, 1) }),
  );
  const field = arrow.schema.fields[0];
  assert.equal(field.nullable, false);
  assert.equal(arrow.getChild("E")!.nullCount, 0);
  assert.ok(Number.isNaN(arrow.getChild("E")!.get(0)));
});

test("a repeat count maps to a fixed-size list over the same array", () => {
  const values = Int16Array.from([1, 2, 3, 4, 5, 6]);
  const { data, vector } = only(table(2, { column: column("v", bin("I", 3)), values }));

  assert.equal(String(vector.type), "FixedSizeList[3]<Int16>");
  assert.ok(sameMemory(data.children[0].values, values));
  assert.deepEqual(items(at(vector, 1)), [4, 5, 6]);
});

test("repeat 0 keeps one empty list per row", () => {
  const { vector } = only(
    table(3, { column: column("z", bin("J", 0)), values: new Int32Array(0) }),
  );
  assert.equal(String(vector.type), "FixedSizeList[0]<Int32>");
  assert.equal(vector.length, 3);
  assert.equal((at(vector, 2) as Vector).length, 0);
});

test("TDIM, TUNIT and TDISP travel as field metadata", () => {
  const arrow = toArrowTable(
    table(
      1,
      {
        column: column("img", bin("E", 6), { tdim: [3, 2], unit: "adu", tdisp: "F8.3" }),
        values: new Float32Array(6),
      },
      { column: column("plain", bin("J")), values: new Int32Array(1) },
    ),
  );
  const [img, plain] = arrow.schema.fields;

  assert.equal(String(img.type), "FixedSizeList[6]<Float32>", "TDIM does not nest");
  assert.deepEqual(
    [...img.metadata],
    [
      ["fits:TFORM", "6E"],
      ["fits:TUNIT", "adu"],
      ["fits:TDISP", "F8.3"],
      ["fits:TDIM", "(3,2)"],
    ],
  );
  assert.deepEqual([...plain.metadata], [["fits:TFORM", "1J"]]);
});

test("a logical column maps to nullable Bool with the mask as nulls", () => {
  const { vector } = only(
    table(3, {
      column: column("L", bin("L")),
      values: Uint8Array.of(1, 0, 0),
      mask: Uint8Array.of(0, 0, 1),
    }),
  );
  assert.equal(String(vector.type), "Bool");
  assert.deepEqual(items(vector), [true, false, null]);
});

test("a logical array puts its nulls on the elements, not the rows", () => {
  const arrow = toArrowTable(
    table(2, {
      column: column("L", bin("L", 3)),
      values: Uint8Array.of(1, 0, 1, 0, 1, 1),
      mask: Uint8Array.of(0, 1, 0, 0, 0, 0),
    }),
  );
  const field = arrow.schema.fields[0];
  const vector = arrow.getChildAt(0)!;

  assert.equal(field.nullable, false);
  assert.equal(String(field.type), "FixedSizeList[3]<Bool>");
  assert.equal(vector.nullCount, 0);
  assert.deepEqual(items(vector.get(0)), [true, null, true]);
  assert.deepEqual(items(vector.get(1)), [false, true, true]);
});

test("bit columns map to Bool, one element per bit", () => {
  const bits13 = Uint8Array.from({ length: 13 }, (_, i) => (i % 3 === 0 ? 1 : 0));
  const arrow = toArrowTable(
    table(
      1,
      { column: column("x1", bin("X")), values: Uint8Array.of(1) },
      { column: column("x13", bin("X", 13)), values: bits13 },
    ),
  );

  assert.equal(String(arrow.schema.fields[0].type), "Bool");
  assert.equal(arrow.schema.fields[0].nullable, false);
  assert.equal(String(arrow.schema.fields[1].type), "FixedSizeList[13]<Bool>");
  assert.deepEqual(
    items(at(arrow.getChild("x13"), 0)),
    [...bits13].map((b) => b === 1),
  );
});

test("character columns map to one Utf8 string per row", () => {
  const { vector } = only(table(2, { column: column("A", bin("A", 8)), values: ["M31", "café"] }));
  assert.equal(String(vector.type), "Utf8");
  assert.deepEqual(items(vector), ["M31", "café"]);
});

test("complex values map to (re, im) pairs over the interleaved array", () => {
  const c = Float32Array.of(1, 2, 3, 4);
  const m = Float64Array.from({ length: 12 }, (_, i) => i);
  const arrow = toArrowTable(
    table(
      2,
      { column: column("c", bin("C")), values: c },
      { column: column("m", bin("M", 3)), values: m.subarray(0, 12) },
    ),
  );
  const [cData, mData] = arrow.batches[0].data.children;

  assert.equal(String(arrow.schema.fields[0].type), "FixedSizeList[2]<Float32>");
  assert.ok(sameMemory(cData.children[0].values, c));
  assert.deepEqual(items(at(arrow.getChild("c"), 1)), [3, 4]);

  assert.equal(String(arrow.schema.fields[1].type), "FixedSizeList[3]<FixedSizeList[2]<Float64>>");
  assert.ok(sameMemory(mData.children[0].children[0].values, m));
  assert.deepEqual(items(at(arrow.getChild("m"), 1, 2)), [10, 11]);
});

test("TNULL marks a scalar integer column nullable and keeps the stored value", () => {
  const values = Int32Array.of(5, -999);
  const { data, vector } = only(
    table(2, {
      column: column("J", bin("J"), { tnull: -999 }),
      values,
      mask: Uint8Array.of(0, 1),
    }),
  );

  assert.deepEqual(items(vector), [5, null]);
  assert.equal((data.values as Int32Array)[1], -999, "the sentinel is not overwritten");
  assert.ok(sameMemory(data.values, values));
});

test("a 64-bit TNULL makes the field nullable even with no nulls read", () => {
  const arrow = toArrowTable(
    table(1, {
      column: column("K", bin("K"), { tnullBig: 2n ** 62n }),
      values: BigInt64Array.of(1n),
    }),
  );
  assert.equal(arrow.schema.fields[0].nullable, true);
  assert.equal(arrow.getChildAt(0)!.nullCount, 0);
});

test("TNULL on an integer array nulls the elements inside the list", () => {
  const arrow = toArrowTable(
    table(2, {
      column: column("J", bin("J", 2), { tnull: 0 }),
      values: Int32Array.of(1, 0, 0, 4),
      mask: Uint8Array.of(0, 1, 1, 0),
    }),
  );
  const listType = arrow.schema.fields[0].type as { children: { nullable: boolean }[] };

  assert.equal(arrow.schema.fields[0].nullable, false);
  assert.equal(listType.children[0].nullable, true);
  assert.deepEqual(items(at(arrow.getChildAt(0), 0)), [1, null]);
  assert.deepEqual(items(at(arrow.getChildAt(0), 1)), [null, 4]);
});

test("a variable-length column maps to a List over core's offsets", () => {
  const values = Int32Array.of(1, 2, 3);
  const offsets = Int32Array.of(0, 2, 2, 3);
  const { data, vector } = only(
    table(3, { column: column("pj", bin("P", 1, "J")), values, offsets }),
  );

  assert.equal(String(vector.type), "List<Int32>");
  assert.ok(sameMemory(data.valueOffsets, offsets));
  assert.ok(sameMemory(data.children[0].values, values));
  assert.deepEqual(items(vector.get(0)), [1, 2]);
  assert.equal((at(vector, 1) as Vector).length, 0, "an empty row is an empty list");
  assert.equal(vector.nullCount, 0);
});

test("variable-length complex offsets count pairs, not floats", () => {
  const { vector } = only(
    table(2, {
      column: column("pc", bin("P", 1, "C")),
      values: Float32Array.of(1, 2, 3, 4, 5, 6),
      offsets: Int32Array.of(0, 2, 6),
    }),
  );

  assert.equal(String(vector.type), "List<FixedSizeList[2]<Float32>>");
  assert.equal((at(vector, 0) as Vector).length, 1);
  assert.deepEqual(items(at(vector, 1, 1)), [5, 6]);
});

test("variable-length bits and logicals map to List<Bool>", () => {
  const arrow = toArrowTable(
    table(
      2,
      {
        column: column("px", bin("P", 1, "X")),
        values: Uint8Array.of(1, 0, 1),
        offsets: Int32Array.of(0, 1, 3),
      },
      {
        column: column("pl", bin("P", 1, "L")),
        values: Uint8Array.of(1, 0, 0),
        offsets: Int32Array.of(0, 2, 3),
        mask: Uint8Array.of(0, 0, 1),
      },
    ),
  );

  assert.equal(String(arrow.schema.fields[0].type), "List<Bool>");
  assert.deepEqual(items(at(arrow.getChild("px"), 1)), [false, true]);
  assert.deepEqual(items(at(arrow.getChild("pl"), 1)), [null]);
});

test("variable-length character arrays map to Utf8", () => {
  const { vector } = only(table(2, { column: column("pa", bin("P", 1, "A")), values: ["ab", ""] }));
  assert.equal(String(vector.type), "Utf8");
  assert.deepEqual(items(vector), ["ab", ""]);
});

test("ASCII table columns are all nullable scalars", () => {
  const arrow = toArrowTable(
    table(
      2,
      {
        column: column("i", asc("I", 5)),
        values: Int32Array.of(12, 0),
        mask: Uint8Array.of(0, 1),
      },
      { column: column("wide", asc("I", 20)), values: BigInt64Array.of(1n, 2n) },
      { column: column("f", asc("F", 6)), values: Float64Array.of(1.5, 0) },
      { column: column("a", asc("A", 4)), values: ["ab", ""], mask: Uint8Array.of(0, 1) },
    ),
  );

  assert.deepEqual(
    arrow.schema.fields.map((f) => `${String(f.type)}${f.nullable ? "?" : ""}`),
    ["Int32?", "Int64?", "Float64?", "Utf8?"],
  );
  assert.deepEqual(items(arrow.getChild("i")), [12, null]);
  assert.deepEqual(items(arrow.getChild("a")), ["ab", null]);
});

test("an unnamed column takes its TTYPE position and duplicate names are kept", () => {
  const arrow = toArrowTable(
    table(
      1,
      { column: { ...column(undefined, bin("J")), index: 2 }, values: new Int32Array(1) },
      { column: column("dup", bin("J")), values: new Int32Array(1) },
      { column: column("dup", bin("J")), values: new Int32Array(1) },
    ),
  );
  assert.deepEqual(
    arrow.schema.fields.map((f) => f.name),
    ["col3", "dup", "dup"],
  );
});

test("an empty table keeps its schema", () => {
  const empty = toArrowTable(
    table(
      0,
      { column: column("J", bin("J", 2)), values: new Int32Array(0) },
      { column: column("A", bin("A", 4)), values: [] },
    ),
  );
  assert.equal(empty.numRows, 0);
  assert.equal(empty.batches.length, 1);
  assert.deepEqual(
    empty.schema.fields.map((f) => String(f.type)),
    ["FixedSizeList[2]<Int32>", "Utf8"],
  );

  const noColumns = toArrowTable(table(4));
  assert.equal(noColumns.schema.fields.length, 0);
  assert.equal(noColumns.batches.length, 1);
});

test("input that does not match readTable's shape is refused", () => {
  const cases: [string, TableColumnData, number][] = [
    ["values for", { column: column("n", bin("J", 2)), values: new Int32Array(3) }, 2],
    ["strings for", { column: column("s", bin("A", 2)), values: ["a"] }, 2],
    [
      "offsets do not",
      {
        column: column("p", bin("P", 1, "J")),
        values: new Int32Array(2),
        offsets: Int32Array.of(0, 1),
      },
      2,
    ],
    [
      "cannot hold nulls",
      { column: column("e", bin("E")), values: new Float32Array(1), mask: Uint8Array.of(1) },
      1,
    ],
    [
      "mask has",
      { column: column("l", bin("L")), values: new Uint8Array(2), mask: Uint8Array.of(1) },
      2,
    ],
    [
      "not a supported typed array",
      { column: column("b", bin("B")), values: new Uint8ClampedArray(1) as unknown as Uint8Array },
      1,
    ],
    ["must be a Uint8Array", { column: column("l", bin("L")), values: new Int8Array(1) }, 1],
    [
      "(re, im) pairs",
      {
        column: column("pc", bin("P", 1, "C")),
        values: new Float32Array(3),
        offsets: Int32Array.of(0, 3),
      },
      1,
    ],
  ];

  for (const [message, columnData, rowCount] of cases) {
    assert.throws(() => toArrowTable(table(rowCount, columnData)), {
      name: "TypeError",
      message: new RegExp(message.replace(/[()]/g, "\\$&")),
    });
  }
});
