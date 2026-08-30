import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsStructureError } from "../errors.js";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { readHdus } from "../hdu/read-hdus.js";
import { readTable } from "./table.js";

/** Wraps a reader to record how much it was asked to fetch. */
class CountingReader implements RandomAccessReader {
  reads = 0;
  bytes = 0;
  constructor(private readonly inner: BytesReader) {}
  get size(): number | undefined {
    return this.inner.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads++;
    const b = await this.inner.read(offset, length);
    this.bytes += b.length;
    return b;
  }
}

// Fixed-format card; value right-justified to column 30 (test-only, not the
// production serializer, so the parser is never tested against its own output).
function card(kw: string, val: number | boolean | string): string {
  const v =
    typeof val === "boolean"
      ? val
        ? "T"
        : "F"
      : typeof val === "string"
        ? `'${val.padEnd(8)}'`
        : String(val);
  return `${kw.padEnd(8)}= ${v.padStart(20)}`;
}

function headerBlock(cards: string[]): Uint8Array {
  let h = cards
    .concat("END")
    .map((c) => c.padEnd(80).slice(0, 80))
    .join("");
  h = h.padEnd(Math.ceil(h.length / 2880) * 2880, " ");
  const out = new Uint8Array(h.length);
  new TextEncoder().encodeInto(h, out);
  return out;
}

/** Build an ASCII TABLE file from card images and row text, and resolve its HDU. */
function asciiTableHdu(cards: string[], rows: string[], naxis1: number) {
  const supplied = new Set(cards.map((c) => c.slice(0, 8).trim()));
  const ext = [...cards];
  if (!supplied.has("NAXIS")) ext.unshift(card("NAXIS", 2));
  if (!supplied.has("BITPIX")) ext.unshift(card("BITPIX", 8));
  if (!supplied.has("NAXIS1")) ext.push(card("NAXIS1", naxis1));
  if (!supplied.has("NAXIS2")) ext.push(card("NAXIS2", rows.length));
  if (!supplied.has("PCOUNT")) ext.push(card("PCOUNT", 0));
  if (!supplied.has("GCOUNT")) ext.push(card("GCOUNT", 1));

  const primary = headerBlock([card("SIMPLE", true), card("BITPIX", 8), card("NAXIS", 0)]);
  const extHdr = headerBlock(["XTENSION= 'TABLE   '", ...ext]);
  const text = rows.map((r) => r.padEnd(naxis1).slice(0, naxis1)).join("");
  // An ASCII table pads its last block with spaces, not zeros (§7.2.3).
  const data = new Uint8Array(Math.ceil(Math.max(1, text.length) / 2880) * 2880).fill(0x20);
  new TextEncoder().encodeInto(text, data);

  const buf = new Uint8Array(primary.length + extHdr.length + data.length);
  buf.set(primary, 0);
  buf.set(extHdr, primary.length);
  buf.set(data, primary.length + extHdr.length);

  const { hdus } = readHdus(buf);
  return { hdu: hdus[1], reader: new BytesReader(buf), buf };
}

/** One column at TBCOL 1, so a single field is the whole row. */
function oneColumn(tform: string, rows: string[], width: number, extra: string[] = []) {
  return asciiTableHdu(
    [card("TFIELDS", 1), `TFORM1  = '${tform}'`, card("TBCOL1", 1), ...extra],
    rows,
    width,
  );
}

test("character fields come back as one string per row", async () => {
  const { hdu, reader } = oneColumn("A8", ["PIXEL   ", "  MID   "], 8);
  const t = await readTable(hdu, reader);
  assert.deepEqual(t.columns[0].values, ["PIXEL", "  MID"]);
  assert.equal(t.columns[0].offsets, undefined);
});

test("integer fields narrow to Int32Array and widen past nine digits", async () => {
  const narrow = oneColumn("I9", ["      -42", "  1000000"], 9);
  const nt = await readTable(narrow.hdu, narrow.reader);
  assert.ok(nt.columns[0].values instanceof Int32Array);
  assert.deepEqual([...nt.columns[0].values], [-42, 1000000]);

  const wide = oneColumn("I11", ["99999999999", "         -1"], 11);
  const wt = await readTable(wide.hdu, wide.reader);
  assert.ok(wt.columns[0].values instanceof BigInt64Array);
  assert.deepEqual([...wt.columns[0].values], [99999999999n, -1n]);
});

test("F, E and D decode identical text identically, always as float64", async () => {
  const text = ["1.2345E+02"];
  const out: number[] = [];
  for (const code of ["F10.4", "E10.4", "D10.4"]) {
    const { hdu, reader } = oneColumn(code, text, 10);
    const t = await readTable(hdu, reader);
    assert.ok(t.columns[0].values instanceof Float64Array, code);
    out.push(t.columns[0].values[0]);
  }
  assert.deepEqual(out, [123.45, 123.45, 123.45]);
});

test("gaps between fields and trailing row bytes stay silent", async () => {
  const { hdu, reader } = asciiTableHdu(
    [card("TFIELDS", 2), "TFORM1  = 'I5'", card("TBCOL1", 1), "TFORM2  = 'I5'", card("TBCOL2", 10)],
    ["   11 xx   22   ", "   33 yy   44   "],
    16,
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual(t.warnings, []);
  assert.deepEqual([...(t.columns[0].values as Int32Array)], [11, 33]);
  assert.deepEqual([...(t.columns[1].values as Int32Array)], [22, 44]);
});

test("a blank numeric field is zero and unmasked", async () => {
  const { hdu, reader } = oneColumn("F6.2", ["      ", " -3.12"], 6);
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Float64Array)], [0, -3.12]);
  assert.equal(t.columns[0].mask, undefined);
});

test("a field that violates its TFORM is masked and warned about once", async () => {
  const { hdu, reader } = oneColumn("F6.2", [" -3.12", "1 2.34", "abcdef"], 6);
  const t = await readTable(hdu, reader);
  const values = t.columns[0].values as Float64Array;
  assert.equal(values[0], -3.12);
  assert.ok(Number.isNaN(values[1]));
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 1, 1]);
  assert.equal(t.warnings.length, 1, "one warning names the first bad row");
  assert.match(t.warnings[0], /row 1 does not match TFORM F6.2/);
});

test("an integer too large for int64 is masked, not wrapped", async () => {
  // The standard caps neither the digits nor the range of an Iw field.
  const { hdu, reader } = oneColumn("I20", ["99999999999999999999", "                  42"], 20);
  const t = await readTable(hdu, reader);
  const values = t.columns[0].values as BigInt64Array;
  assert.equal(values[0], 0n, "no wrapped value is stored");
  assert.equal(values[1], 42n);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [1, 0]);
  assert.match(t.warnings[0], /does not fit a 64-bit integer/);
});

test("a malformed integer masks and holds zero", async () => {
  const { hdu, reader } = oneColumn("I5", ["   12", "1 2  "], 5);
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Int32Array)], [12, 0]);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 1]);
});

test("TNULL masks the field and leaves a parsable sentinel readable", async () => {
  const { hdu, reader } = oneColumn("I6", ["    12", "  -999"], 6, ["TNULL1  = '-999'"]);
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Int32Array)], [12, -999]);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 1]);
  assert.deepEqual(t.warnings, [], "a declared null is not a format violation");
});

test("a non-numeric TNULL masks without warning", async () => {
  const { hdu, reader } = oneColumn("F6.2", [" -3.12", "  ****"], 6, ["TNULL1  = '****'"]);
  const t = await readTable(hdu, reader);
  const values = t.columns[0].values as Float64Array;
  assert.equal(values[0], -3.12);
  assert.ok(Number.isNaN(values[1]));
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 1]);
  assert.deepEqual(t.warnings, []);
});

// §7.2.2 puts no type restriction on TNULLn, so it holds for A fields too.
// astropy leaves such a field unmasked; the standard is followed here.
test("TNULL works on a character column too", async () => {
  const { hdu, reader } = oneColumn("A6", ["OBJECT", "INDEF ", "OTHER "], 6, ["TNULL1  = 'INDEF'"]);
  const t = await readTable(hdu, reader);
  assert.deepEqual(t.columns[0].values, ["OBJECT", "INDEF", "OTHER"]);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 1, 0]);
});

test("an all-blank TNULL marks blank fields undefined", async () => {
  const { hdu, reader } = oneColumn("I5", ["   12", "     "], 5, ["TNULL1  = '     '"]);
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Int32Array)], [12, 0]);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 1]);
});

test("TSCAL and TZERO scale into float64, and raw bypasses them", async () => {
  const { hdu, reader } = oneColumn("I5", ["    4", "   -4"], 5, [
    card("TSCAL1", 0.5),
    card("TZERO1", 10),
  ]);
  const scaled = await readTable(hdu, reader);
  assert.ok(scaled.columns[0].values instanceof Float64Array);
  assert.deepEqual([...scaled.columns[0].values], [12, 8]);

  const raw = await readTable(hdu, reader, { raw: true });
  assert.ok(raw.columns[0].values instanceof Int32Array);
  assert.deepEqual([...raw.columns[0].values], [4, -4]);
});

test("a character field holding a control byte warns once and still decodes", async () => {
  const { hdu, buf } = oneColumn("A4", ["ABCD"], 4);
  // Overwrite the first data byte with a tab, which §7.2.5 excludes.
  buf[buf.length - 2880] = 0x09;
  const t = await readTable(hdu, new BytesReader(buf));
  assert.equal((t.columns[0].values as string[])[0].length, 4);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /outside 0x20\.\.0x7e \(first saw 0x09\)/);
});

test("projection and a rows range behave as they do for a binary table", async () => {
  const { hdu, buf } = asciiTableHdu(
    [
      card("TFIELDS", 2),
      "TFORM1  = 'I5'",
      card("TBCOL1", 1),
      "TTYPE1  = 'A'",
      "TFORM2  = 'I5'",
      card("TBCOL2", 6),
      "TTYPE2  = 'B'",
    ],
    ["   11   21", "   12   22", "   13   23"],
    10,
  );
  const projected = await readTable(hdu, new BytesReader(buf), { columns: ["b"] });
  assert.equal(projected.columns.length, 1);
  assert.deepEqual([...(projected.columns[0].values as Int32Array)], [21, 22, 23]);

  const counting = new CountingReader(new BytesReader(buf));
  const ranged = await readTable(hdu, counting, { rows: { start: 1, count: 1 } });
  assert.equal(ranged.rowCount, 1);
  assert.deepEqual([...(ranged.columns[0].values as Int32Array)], [12]);
  assert.equal(counting.bytes, 10, "only the one row is fetched");

  await assert.rejects(readTable(hdu, new BytesReader(buf), { columns: ["nope"] }), /no column/);
});

test("an aborted signal rejects, and a truncated data unit is structural", async () => {
  const { hdu, buf } = oneColumn("I5", ["   11", "   12"], 5);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readTable(hdu, new BytesReader(buf), { signal: controller.signal }), {
    name: "AbortError",
  });

  const short = new BytesReader(buf.subarray(0, buf.length - 2880 + 4));
  await assert.rejects(readTable(hdu, short), /table data is truncated at byte/);
});

test("an empty ASCII table reads without fetching anything", async () => {
  const { hdu, buf } = asciiTableHdu(
    [card("TFIELDS", 1), "TFORM1  = 'I5'", card("TBCOL1", 1), card("NAXIS2", 0)],
    [],
    5,
  );
  const counting = new CountingReader(new BytesReader(buf));
  const t = await readTable(hdu, counting);
  assert.equal(t.rowCount, 0);
  assert.equal(t.columns[0].values.length, 0);
  assert.equal(counting.reads, 0);
});

test("a structurally wrong ASCII table is refused", async () => {
  const bad = asciiTableHdu([card("TFIELDS", 1), "TFORM1  = 'I5'", card("TBCOL1", 3)], ["  12"], 4);
  await assert.rejects(readTable(bad.hdu, bad.reader), FitsStructureError);
});
