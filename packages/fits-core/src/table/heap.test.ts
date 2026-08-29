import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeader } from "../header/parse-header.js";
import { heapGeometry, nextHeapWindow, planGather, slotsPerElement } from "./heap.js";

/** Build a header from card images, padding to 2880 with spaces. */
function hdr(cards: string[]): ReturnType<typeof parseHeader>["header"] {
  let s = cards
    .concat("END")
    .map((c) => c.padEnd(80).slice(0, 80))
    .join("");
  s = s.padEnd(Math.max(1, Math.ceil(s.length / 2880)) * 2880, " ");
  return parseHeader(new TextEncoder().encode(s)).header;
}

const f64 = (...v: number[]) => Float64Array.from(v);

test("heap base defaults to the end of the main table", () => {
  const { geometry, problem, warnings } = heapGeometry(hdr(["PCOUNT  = 40"]), 2880, 10, 3);
  assert.equal(problem, undefined);
  assert.deepEqual(warnings, []);
  assert.equal(geometry.base, 2880 + 30);
  assert.equal(geometry.length, 40);
});

test("an explicit THEAP moves the heap and shortens it by the gap", () => {
  // PCOUNT spans gap plus heap, so a 20-byte gap leaves 40 heap bytes.
  const { geometry, problem } = heapGeometry(hdr(["PCOUNT  = 60", "THEAP   = 50"]), 2880, 10, 3);
  assert.equal(problem, undefined);
  assert.equal(geometry.base, 2880 + 50);
  assert.equal(geometry.length, 40);
});

test("THEAP equal to the default is accepted silently", () => {
  const { geometry, problem, warnings } = heapGeometry(
    hdr(["PCOUNT  = 40", "THEAP   = 30"]),
    2880,
    10,
    3,
  );
  assert.equal(problem, undefined);
  assert.deepEqual(warnings, []);
  assert.equal(geometry.base, 2880 + 30);
  assert.equal(geometry.length, 40);
});

test("THEAP without a heap is ignored with a warning", () => {
  const { geometry, problem, warnings } = heapGeometry(
    hdr(["PCOUNT  = 0", "THEAP   = 90"]),
    2880,
    10,
    3,
  );
  assert.equal(problem, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /THEAP 90 is set but PCOUNT is 0; ignored/);
  assert.equal(geometry.length, 0);
});

test("a THEAP overlapping the table or past the data unit is a problem", () => {
  const overlap = heapGeometry(hdr(["PCOUNT  = 40", "THEAP   = 20"]), 2880, 10, 3);
  assert.match(overlap.problem!, /THEAP 20 would overlap the 30-byte main table/);

  const past = heapGeometry(hdr(["PCOUNT  = 40", "THEAP   = 500"]), 2880, 10, 3);
  assert.match(past.problem!, /THEAP 500 is past the end of the data unit/);

  const negative = heapGeometry(hdr(["PCOUNT  = 40", "THEAP   = -1"]), 2880, 10, 3);
  assert.match(negative.problem!, /THEAP -1 is not a non-negative integer/);
});

test("a non-integer PCOUNT is a problem", () => {
  const { problem } = heapGeometry(hdr(["PCOUNT  = 2.5"]), 2880, 10, 3);
  assert.match(problem!, /PCOUNT 2.5 is not a non-negative integer/);
});

test("slotsPerElement doubles only the complex types", () => {
  assert.equal(slotsPerElement("C"), 2);
  assert.equal(slotsPerElement("M"), 2);
  for (const code of ["L", "X", "B", "I", "J", "K", "A", "E", "D"] as const) {
    assert.equal(slotsPerElement(code), 1, code);
  }
});

test("planGather prefix-sums row lengths into Arrow slot boundaries", () => {
  const { plan, problem } = planGather(f64(2, 0, 3), f64(0, 0, 8), "J", 32);
  assert.equal(problem, undefined);
  assert.deepEqual([...plan!.offsets], [0, 2, 2, 5]);
  assert.equal(plan!.total, 5);
  assert.equal(plan!.overMaxRow, undefined);
});

test("planGather counts two slots per complex element", () => {
  const { plan } = planGather(f64(2, 1), f64(0, 16), "M", 64);
  assert.deepEqual([...plan!.offsets], [0, 4, 6]);
  assert.equal(plan!.total, 6);
});

test("planGather accepts aliased, unordered and gapped offsets", () => {
  const { plan, problem } = planGather(f64(2, 2, 2), f64(40, 8, 8), "I", 64);
  assert.equal(problem, undefined, "aliasing and gaps are legal");
  assert.deepEqual([...plan!.offsets], [0, 2, 4, 6]);
});

test("planGather ignores the offset of a zero-length array", () => {
  // The standard leaves a zero-length descriptor's offset undefined.
  const { plan, problem } = planGather(f64(0, 1), f64(999999, 0), "B", 4);
  assert.equal(problem, undefined);
  assert.deepEqual([...plan!.offsets], [0, 0, 1]);
});

test("planGather refuses descriptors the heap cannot contain", () => {
  assert.match(planGather(f64(-1), f64(0), "J", 32).problem!, /row 0 has a negative/);
  assert.match(
    planGather(f64(1), f64(-8), "J", 32).problem!,
    /negative or non-integer heap offset/,
  );
  assert.match(
    planGather(f64(2), f64(28), "J", 32).problem!,
    /row 0 spans heap bytes 28\.\.36 but the heap is 32 bytes/,
  );
  assert.match(
    planGather(f64(1.5), f64(0), "J", 32).problem!,
    /negative or non-integer array length/,
  );
});

test("planGather bounds an X array by its packed byte length", () => {
  // 12 bits occupy 2 bytes, so this fits a 2-byte heap.
  assert.equal(planGather(f64(12), f64(0), "X", 2).problem, undefined);
  assert.match(planGather(f64(17), f64(0), "X", 2).problem!, /spans heap bytes 0\.\.3/);
});

test("planGather flags the first row past the declared emax", () => {
  const { plan, problem } = planGather(f64(1, 5, 9), f64(0, 4, 24), "B", 64, 4);
  assert.equal(problem, undefined, "emax is advisory, not a bound");
  assert.equal(plan!.overMaxRow, 1);
});

test("planGather refuses a gather too large to index", () => {
  const huge = 2 ** 30;
  const { problem } = planGather(f64(huge, huge, huge), f64(0, 0, 0), "B", Number.MAX_SAFE_INTEGER);
  assert.match(
    problem!,
    /gathered elements exceed 2147483647; read fewer rows with the rows option/,
  );
});

test("nextHeapWindow coalesces arrays that fit the budget", () => {
  const offsets = f64(0, 16, 40);
  const lengths = f64(16, 8, 8);
  const order = Uint32Array.from([0, 1, 2]);
  assert.deepEqual(nextHeapWindow(order, offsets, lengths, 0, 1024), {
    start: 0,
    length: 48,
    end: 3,
  });
});

test("nextHeapWindow starts at a referenced array, skipping gaps", () => {
  const offsets = f64(1000, 1008);
  const lengths = f64(8, 8);
  const order = Uint32Array.from([0, 1]);
  const w = nextHeapWindow(order, offsets, lengths, 0, 1024);
  assert.equal(w.start, 1000, "the leading 1000-byte gap is never fetched");
  assert.equal(w.length, 16);
});

test("nextHeapWindow stops before an array that would blow the budget", () => {
  const offsets = f64(0, 8, 4096);
  const lengths = f64(8, 8, 8);
  const order = Uint32Array.from([0, 1, 2]);
  const w = nextHeapWindow(order, offsets, lengths, 0, 64);
  assert.deepEqual(w, { start: 0, length: 16, end: 2 });

  const next = nextHeapWindow(order, offsets, lengths, w.end, 64);
  assert.deepEqual(next, { start: 4096, length: 8, end: 3 });
});

test("nextHeapWindow gives an oversized array a window of its own", () => {
  const offsets = f64(0, 64);
  const lengths = f64(4096, 8);
  const order = Uint32Array.from([0, 1]);
  assert.deepEqual(nextHeapWindow(order, offsets, lengths, 0, 64), {
    start: 0,
    length: 4096,
    end: 1,
  });
});

test("nextHeapWindow keeps the longer reach when arrays alias", () => {
  const offsets = f64(0, 0, 8);
  const lengths = f64(32, 4, 4);
  const order = Uint32Array.from([0, 1, 2]);
  assert.deepEqual(nextHeapWindow(order, offsets, lengths, 0, 1024), {
    start: 0,
    length: 32,
    end: 3,
  });
});
