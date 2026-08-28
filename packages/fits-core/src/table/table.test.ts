import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsIoError, FitsStructureError, FitsUnsupportedError } from "../errors.js";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { readHdus } from "../hdu/read-hdus.js";
import type { Hdu } from "../hdu/hdu.js";
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
function card(kw: string, val: number | bigint | boolean | string): string {
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

/** Primary NAXIS=0 block, an extension header from `extCards`, then data. */
function binTableFile(extCards: string[], data: Uint8Array): Uint8Array {
  const primary = headerBlock([card("SIMPLE", true), card("BITPIX", 8), card("NAXIS", 0)]);
  const ext = headerBlock(["XTENSION= 'BINTABLE'", ...extCards]);
  const out = new Uint8Array(primary.length + ext.length + Math.ceil(data.length / 2880) * 2880);
  out.set(primary, 0);
  out.set(ext, primary.length);
  out.set(data, primary.length + ext.length);
  return out;
}

/** Build a BINTABLE file with boilerplate cards and resolve its table HDU. */
function binTableHdu(cards: string[], data: Uint8Array) {
  const supplied = new Set(cards.map((c) => c.slice(0, 8).trim()));
  const ext = [...cards];
  if (!supplied.has("NAXIS")) ext.unshift(card("NAXIS", 2));
  if (!supplied.has("BITPIX")) ext.unshift(card("BITPIX", 8));
  if (!supplied.has("PCOUNT")) ext.push(card("PCOUNT", 0));
  if (!supplied.has("GCOUNT")) ext.push(card("GCOUNT", 1));

  const buf = binTableFile(ext, data);
  const { hdus } = readHdus(buf);
  return { hdu: hdus[1], reader: new BytesReader(buf), buf };
}

/** Concatenate row fragments into one data unit. */
function rows(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Big-endian numeric field bytes: width 1, 2, 4, 8 int or -4, -8 float. */
function be(values: number[] | bigint[], width: number): Uint8Array {
  const bpe = Math.abs(width);
  const b = new Uint8Array(values.length * bpe);
  const dv = new DataView(b.buffer);
  values.forEach((v, i) => {
    const o = i * bpe;
    if (width === 1) dv.setUint8(o, v as number);
    else if (width === 2) dv.setInt16(o, v as number, false);
    else if (width === 4) dv.setInt32(o, v as number, false);
    else if (width === 8) dv.setBigInt64(o, v as bigint, false);
    else if (width === -4) dv.setFloat32(o, v as number, false);
    else dv.setFloat64(o, v as number, false);
  });
  return b;
}

/** An A-field: `s` in a `width`-byte box, space padded. */
function ascii(s: string, width: number): Uint8Array {
  const out = new Uint8Array(width).fill(0x20);
  new TextEncoder().encodeInto(s, out);
  return out;
}

test("hdu and reader arguments are validated", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 1), card("TFIELDS", 1), "TFORM1  = '1I'"],
    be([7], 2),
  );
  await assert.rejects(readTable(undefined as unknown as Hdu, reader), FitsStructureError);
  await assert.rejects(readTable(hdu, {} as RandomAccessReader), FitsIoError);
});

test("malformed structural keywords are structural errors", async () => {
  const wrongBitpix = binTableHdu(
    [
      card("BITPIX", 16),
      card("NAXIS1", 2),
      card("NAXIS2", 1),
      card("TFIELDS", 1),
      "TFORM1  = '1I'",
    ],
    be([7], 2),
  );
  await assert.rejects(readTable(wrongBitpix.hdu, wrongBitpix.reader), /BITPIX 16 is not 8/);

  const wrongNaxis = binTableHdu(
    [card("NAXIS", 1), card("NAXIS1", 2), card("TFIELDS", 1), "TFORM1  = '1I'"],
    be([7], 2),
  );
  await assert.rejects(readTable(wrongNaxis.hdu, wrongNaxis.reader), /NAXIS 1 is not 2/);

  const badNaxis2 = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", -1), card("TFIELDS", 1), "TFORM1  = '1I'"],
    new Uint8Array(0),
  );
  await assert.rejects(
    readTable(badNaxis2.hdu, badNaxis2.reader),
    /NAXIS2 -1 is not a non-negative integer/,
  );

  const badNaxis1 = binTableHdu(
    [card("NAXIS1", -2), card("NAXIS2", 1), card("TFIELDS", 1), "TFORM1  = '1I'"],
    new Uint8Array(0),
  );
  await assert.rejects(
    readTable(badNaxis1.hdu, badNaxis1.reader),
    /NAXIS1 -2 is not a non-negative integer/,
  );

  // readHdus never yields this shape, but the Hdu type admits it.
  const ok = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 1), card("TFIELDS", 1), "TFORM1  = '1I'"],
    be([7], 2),
  );
  await assert.rejects(
    readTable({ ...ok.hdu, dataSizeKnown: false }, ok.reader),
    /the data unit size is unknown/,
  );
});

test("a tile-compressed image names the compression, not its heap column", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 8),
      card("NAXIS2", 1),
      "ZIMAGE  =                    T",
      "ZCMPTYPE= 'RICE_1'",
      card("TFIELDS", 1),
      "TFORM1  = '1PB(0)'",
    ],
    new Uint8Array(8),
  );
  await assert.rejects(
    readTable(hdu, reader),
    /HDU 1 is a tile-compressed image \(RICE_1\); compressed images are not supported yet/,
  );
});

test("a non-table HDU is rejected, an ASCII table as unsupported", async () => {
  const { hdu, reader, buf } = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 1), card("TFIELDS", 1), "TFORM1  = '1I'"],
    be([7], 2),
  );
  const primary = readHdus(buf).hdus[0];
  await assert.rejects(readTable(primary, reader), /HDU 0 is not a binary table \(type primary\)/);

  const asciiBuf = binTableFile([], new Uint8Array(0));
  new TextEncoder().encodeInto("XTENSION= 'TABLE   '", asciiBuf.subarray(2880));
  const asciiHdu = readHdus(asciiBuf).hdus[1];
  await assert.rejects(readTable(asciiHdu, new BytesReader(asciiBuf)), FitsUnsupportedError);
  assert.equal(hdu.type, "bintable");
});

test("scalar I, J, E and D columns decode big-endian", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 18),
      card("NAXIS2", 2),
      card("TFIELDS", 4),
      "TFORM1  = '1I'",
      "TFORM2  = '1J'",
      "TFORM3  = '1E'",
      "TFORM4  = '1D'",
    ],
    rows(
      be([-300], 2),
      be([70000], 4),
      be([1.5], -4),
      be([-2.25], -8),
      be([12], 2),
      be([-1], 4),
      be([0.25], -4),
      be([1e100], -8),
    ),
  );
  const t = await readTable(hdu, reader);
  assert.equal(t.rowCount, 2);
  assert.equal(t.totalRows, 2);
  assert.equal(t.warnings.length, 0);
  assert.deepEqual([...(t.columns[0].values as Int16Array)], [-300, 12]);
  assert.deepEqual([...(t.columns[1].values as Int32Array)], [70000, -1]);
  assert.deepEqual([...(t.columns[2].values as Float32Array)], [1.5, 0.25]);
  assert.deepEqual([...(t.columns[3].values as Float64Array)], [-2.25, 1e100]);
});

test("B and K columns; K keeps values past 2^53 exact", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 9), card("NAXIS2", 2), card("TFIELDS", 2), "TFORM1  = '1B'", "TFORM2  = '1K'"],
    rows(be([200], 1), be([9007199254740993n], 8), be([0], 1), be([-5n], 8)),
  );
  const t = await readTable(hdu, reader);
  assert.ok(t.columns[0].values instanceof Uint8Array);
  assert.deepEqual([...t.columns[0].values], [200, 0]);
  assert.deepEqual([...(t.columns[1].values as BigInt64Array)], [9007199254740993n, -5n]);
});

test("repeat counts produce flat column-major arrays", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 6), card("NAXIS2", 2), card("TFIELDS", 1), "TFORM1  = '3I'"],
    rows(be([1, 2, 3], 2), be([4, 5, 6], 2)),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Int16Array)], [1, 2, 3, 4, 5, 6]);
});

test("L columns: T, F, 0x00 as masked undefined, junk flagged", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 4), card("NAXIS2", 2), card("TFIELDS", 1), "TFORM1  = '4L'"],
    rows(Uint8Array.of(0x54, 0x46, 0x00, 0x54), Uint8Array.of(0x46, 0x54, 0x46, 0x2a)),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Uint8Array)], [1, 0, 0, 1, 0, 1, 0, 0]);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /logical bytes outside T\/F\/0x00/);
});

test("X columns unpack bits MSB-first across bytes", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 1), card("TFIELDS", 1), "TFORM1  = '12X'"],
    Uint8Array.of(0b10100011, 0b01010000),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Uint8Array)], [1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1]);
  assert.equal(t.columns[0].mask, undefined);
});

test("A columns cut at NUL and strip trailing spaces", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 5), card("NAXIS2", 3), card("TFIELDS", 1), "TFORM1  = '5A'"],
    rows(ascii("AB", 5), Uint8Array.of(0x43, 0x44, 0x00, 0x58, 0x59), ascii("", 5)),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual(t.columns[0].values, ["AB", "CD", ""]);
});

test("E NaN passes through unmasked", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 4), card("NAXIS2", 2), card("TFIELDS", 1), "TFORM1  = '1E'"],
    rows(be([Number.NaN], -4), be([3], -4)),
  );
  const t = await readTable(hdu, reader);
  const v = t.columns[0].values as Float32Array;
  assert.ok(Number.isNaN(v[0]));
  assert.equal(v[1], 3);
  assert.equal(t.columns[0].mask, undefined);
});

test("C and M columns interleave re,im", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 32), card("NAXIS2", 1), card("TFIELDS", 2), "TFORM1  = '2C'", "TFORM2  = '1M'"],
    rows(be([1.5, -2, 3, 4.5], -4), be([-0.5, 8], -8)),
  );
  const t = await readTable(hdu, reader);
  assert.ok(t.columns[0].values instanceof Float32Array);
  assert.deepEqual([...t.columns[0].values], [1.5, -2, 3, 4.5]);
  assert.deepEqual([...(t.columns[1].values as Float64Array)], [-0.5, 8]);
});

test("unsigned-integer conventions stay integer typed arrays", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 15),
      card("NAXIS2", 1),
      card("TFIELDS", 4),
      "TFORM1  = '1B'",
      card("TZERO1", -128),
      "TFORM2  = '1I'",
      card("TZERO2", 32768),
      "TFORM3  = '1J'",
      card("TZERO3", 2147483648),
      "TFORM4  = '1K'",
      card("TZERO4", 9223372036854775808n),
    ],
    rows(be([0x80], 1), be([-32768], 2), be([-1], 4), be([-9223372036854775808n], 8)),
  );
  const t = await readTable(hdu, reader);
  assert.ok(t.columns[0].values instanceof Int8Array);
  assert.equal(t.columns[0].values[0], 0);
  assert.ok(t.columns[1].values instanceof Uint16Array);
  assert.equal(t.columns[1].values[0], 0);
  assert.ok(t.columns[2].values instanceof Uint32Array);
  assert.equal(t.columns[2].values[0], 2147483647);
  assert.ok(t.columns[3].values instanceof BigUint64Array);
  assert.equal(t.columns[3].values[0], 0n);
});

test("general TSCAL/TZERO widens to Float64Array", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 2),
      card("NAXIS2", 2),
      card("TFIELDS", 1),
      "TFORM1  = '1I'",
      card("TSCAL1", 0.5),
      card("TZERO1", 10),
    ],
    rows(be([4], 2), be([-4], 2)),
  );
  const t = await readTable(hdu, reader);
  assert.ok(t.columns[0].values instanceof Float64Array);
  assert.deepEqual([...t.columns[0].values], [12, 8]);
});

test("a scaled complex column scales both components (CFITSIO semantics)", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 8),
      card("NAXIS2", 2),
      card("TFIELDS", 1),
      "TFORM1  = '1C'",
      card("TSCAL1", 2),
      card("TZERO1", 10),
    ],
    rows(be([1.5, -2], -4), be([0.25, 4], -4)),
  );
  const t = await readTable(hdu, reader);
  assert.ok(t.columns[0].values instanceof Float64Array);
  assert.deepEqual([...t.columns[0].values], [13, 6, 10.5, 18]);
});

test("raw bypasses scaling and the unsigned convention", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 4),
      card("NAXIS2", 1),
      card("TFIELDS", 2),
      "TFORM1  = '1I'",
      card("TSCAL1", 0.5),
      "TFORM2  = '1I'",
      card("TZERO2", 32768),
    ],
    rows(be([4], 2), be([-32768], 2)),
  );
  const t = await readTable(hdu, reader, { raw: true });
  assert.ok(t.columns[0].values instanceof Int16Array);
  assert.equal(t.columns[0].values[0], 4);
  assert.ok(t.columns[1].values instanceof Int16Array);
  assert.equal(t.columns[1].values[0], -32768);
});

test("TNULL masks elements and leaves the sentinel in values", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 12),
      card("NAXIS2", 2),
      card("TFIELDS", 1),
      "TFORM1  = '3J'",
      card("TNULL1", -999),
    ],
    rows(be([1, -999, 3], 4), be([4, 5, 6], 4)),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Int32Array)], [1, -999, 3, 4, 5, 6]);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [0, 1, 0, 0, 0, 0]);
});

test("a scaled TNULL column masks on the raw value, then scales it", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 2),
      card("NAXIS2", 2),
      card("TFIELDS", 1),
      "TFORM1  = '1I'",
      card("TNULL1", -1),
      card("TSCAL1", 2),
      card("TZERO1", 10),
    ],
    rows(be([-1], 2), be([3], 2)),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Float64Array)], [8, 16]);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [1, 0]);
});

test("a column with no undefined elements has no mask", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 4),
      card("NAXIS2", 1),
      card("TFIELDS", 1),
      "TFORM1  = '1J'",
      card("TNULL1", -999),
    ],
    be([7], 4),
  );
  const t = await readTable(hdu, reader);
  assert.equal(t.columns[0].mask, undefined);
});

test("a K column masks a bigint TNULL sentinel", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 8),
      card("NAXIS2", 2),
      card("TFIELDS", 1),
      "TFORM1  = '1K'",
      card("TNULL1", -9223372036854775808n),
    ],
    rows(be([-9223372036854775808n], 8), be([1n], 8)),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].mask as Uint8Array)], [1, 0]);
});

test("selecting a variable-length column is unsupported, projecting around it works", async () => {
  const heap = be([1.5, 2.5], -4);
  const { hdu, buf } = binTableHdu(
    [
      card("NAXIS1", 12),
      card("NAXIS2", 1),
      card("PCOUNT", heap.length),
      card("TFIELDS", 2),
      "TFORM1  = '1J'",
      "TTYPE1  = 'VAL'",
      "TFORM2  = '1PE(2)'",
      "TTYPE2  = 'SPEC'",
    ],
    rows(be([42], 4), be([2], 4), be([0], 4), heap),
  );
  const counting = new CountingReader(new BytesReader(buf));
  await assert.rejects(readTable(hdu, counting), FitsUnsupportedError);
  await assert.rejects(readTable(hdu, counting, { columns: ["SPEC"] }), FitsUnsupportedError);

  const t = await readTable(hdu, counting, { columns: ["val"] });
  assert.deepEqual([...(t.columns[0].values as Int32Array)], [42]);
  assert.equal(counting.bytes, 12, "heap bytes must never be fetched");
});

test("projection selects by name and index, in selection order", async () => {
  const { hdu, reader } = binTableHdu(
    [
      card("NAXIS1", 6),
      card("NAXIS2", 1),
      card("TFIELDS", 3),
      "TFORM1  = '1I'",
      "TTYPE1  = 'A'",
      "TFORM2  = '1I'",
      "TTYPE2  = 'B'",
      "TFORM3  = '1I'",
      "TTYPE3  = 'C'",
    ],
    be([1, 2, 3], 2),
  );
  const t = await readTable(hdu, reader, { columns: ["c", 0] });
  assert.equal(t.columns.length, 2);
  assert.equal(t.columns[0].column.name, "C");
  assert.equal((t.columns[0].values as Int16Array)[0], 3);
  assert.equal(t.columns[1].column.name, "A");

  await assert.rejects(readTable(hdu, reader, { columns: ["missing"] }), /no column is named/);
  await assert.rejects(readTable(hdu, reader, { columns: [3] }), /column index 3 is out of/);
});

test("a rows range decodes the slice and fetches only its bytes", async () => {
  const { hdu, buf } = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 5), card("TFIELDS", 1), "TFORM1  = '1I'"],
    be([10, 11, 12, 13, 14], 2),
  );
  const counting = new CountingReader(new BytesReader(buf));
  const t = await readTable(hdu, counting, { rows: { start: 1, count: 3 } });
  assert.equal(t.rowCount, 3);
  assert.equal(t.totalRows, 5);
  assert.deepEqual([...(t.columns[0].values as Int16Array)], [11, 12, 13]);
  assert.equal(counting.bytes, 6);

  await assert.rejects(
    readTable(hdu, counting, { rows: { start: 3, count: 3 } }),
    /rows \[3, 6\) is out of 0..5/,
  );
  await assert.rejects(
    readTable(hdu, counting, { rows: { start: -1, count: 1 } }),
    /is not a valid range/,
  );
});

test("an aborted signal rejects before any read", async () => {
  const { hdu, buf } = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 1), card("TFIELDS", 1), "TFORM1  = '1I'"],
    be([7], 2),
  );
  const counting = new CountingReader(new BytesReader(buf));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readTable(hdu, counting, { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(counting.reads, 0);
});

test("a truncated data unit is a structural error", async () => {
  const { hdu, buf } = binTableHdu(
    [card("NAXIS1", 4), card("NAXIS2", 4), card("TFIELDS", 1), "TFORM1  = '1J'"],
    be([1, 2, 3, 4], 4),
  );
  const short = new BytesReader(buf.subarray(0, buf.length - 2880 + 6));
  await assert.rejects(readTable(hdu, short), /table data is truncated at byte/);
});

test("empty tables succeed without reading", async () => {
  const zeroRows = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 0), card("TFIELDS", 1), "TFORM1  = '1I'"],
    new Uint8Array(0),
  );
  const counting = new CountingReader(new BytesReader(zeroRows.buf));
  const t = await readTable(zeroRows.hdu, counting);
  assert.equal(t.rowCount, 0);
  assert.equal((t.columns[0].values as Int16Array).length, 0);
  assert.equal(counting.reads, 0);

  const zeroCols = binTableHdu(
    [card("NAXIS1", 0), card("NAXIS2", 0), card("TFIELDS", 0)],
    new Uint8Array(0),
  );
  const t2 = await readTable(zeroCols.hdu, new BytesReader(zeroCols.buf));
  assert.equal(t2.columns.length, 0);
});

test("row padding past the last column is ignored with a warning", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 4), card("NAXIS2", 2), card("TFIELDS", 1), "TFORM1  = '1I'"],
    rows(be([5], 2), be([0], 2), be([6], 2), be([0], 2)),
  );
  const t = await readTable(hdu, reader);
  assert.deepEqual([...(t.columns[0].values as Int16Array)], [5, 6]);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /2 trailing bytes not covered by any column/);
});

test("columns wider than NAXIS1 are a structural error", async () => {
  const { hdu, reader } = binTableHdu(
    [card("NAXIS1", 2), card("NAXIS2", 1), card("TFIELDS", 1), "TFORM1  = '1J'"],
    be([1], 4),
  );
  await assert.rejects(readTable(hdu, reader), /columns span 4 bytes but NAXIS1 is 2/);
});

test("GCOUNT and PCOUNT deviations warn without failing", async () => {
  const data = be([7], 2);
  const buf = binTableFile(
    [
      card("BITPIX", 8),
      card("NAXIS", 2),
      card("NAXIS1", 2),
      card("NAXIS2", 1),
      card("GCOUNT", 2),
      card("TFIELDS", 1),
      "TFORM1  = '1I'",
    ],
    data,
  );
  const { hdus } = readHdus(buf);
  const t = await readTable(hdus[1], new BytesReader(buf));
  assert.equal((t.columns[0].values as Int16Array)[0], 7);
  assert.ok(t.warnings.some((w) => /GCOUNT 2 is not 1/.test(w)));
  assert.ok(t.warnings.some((w) => /PCOUNT is missing/.test(w)));
});

test("rows spanning multiple slabs decode across the boundary", async () => {
  // A row wider than the slab budget forces one read per row.
  const rowWidth = 8 * 1024 * 1024 + 8;
  const data = new Uint8Array(2 * rowWidth);
  const dv = new DataView(data.buffer);
  dv.setInt32(0, 111, false);
  dv.setInt32(rowWidth, 222, false);
  const { hdu, buf } = binTableHdu(
    [card("NAXIS1", rowWidth), card("NAXIS2", 2), card("TFIELDS", 1), "TFORM1  = '1J'"],
    data,
  );
  const counting = new CountingReader(new BytesReader(buf));
  const t = await readTable(hdu, counting);
  assert.deepEqual([...(t.columns[0].values as Int32Array)], [111, 222]);
  assert.equal(counting.reads, 2);
});
