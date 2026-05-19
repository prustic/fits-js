import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsStructureError } from "../errors.js";
import { BytesReader } from "../io/reader.js";
import { readHdus } from "../hdu/read-hdus.js";
import { readImage } from "./image.js";

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

function fits(cards: string[], data: Uint8Array): Uint8Array {
  let h = cards
    .concat("END")
    .map((c) => c.padEnd(80).slice(0, 80))
    .join("");
  h = h.padEnd(Math.ceil(h.length / 2880) * 2880, " ");
  const out = new Uint8Array(h.length + Math.ceil(data.length / 2880) * 2880);
  new TextEncoder().encodeInto(h, out);
  out.set(data, h.length);
  return out;
}

function be(values: number[] | bigint[], bitpix: number): Uint8Array {
  const bpe = Math.abs(bitpix) / 8;
  const b = new Uint8Array(values.length * bpe);
  const dv = new DataView(b.buffer);
  values.forEach((v, i) => {
    const o = i * bpe;
    if (bitpix === 8) dv.setUint8(o, v as number);
    else if (bitpix === 16) dv.setInt16(o, v as number, false);
    else if (bitpix === 32) dv.setInt32(o, v as number, false);
    else if (bitpix === 64) dv.setBigInt64(o, v as bigint, false);
    else if (bitpix === -32) dv.setFloat32(o, v as number, false);
    else dv.setFloat64(o, v as number, false);
  });
  return b;
}

/** Build a single-image FITS file and resolve its primary HDU. */
function imageHdu(cards: string[], data: Uint8Array) {
  const buf = fits(["SIMPLE  =                    T", ...cards], data);
  const { hdus } = readHdus(buf);
  return { hdu: hdus[0], reader: new BytesReader(buf) };
}

test("BITPIX 16: big-endian decode, FITS row-major cube order", async () => {
  // 2x3: NAXIS1=2 varies fastest, so on-disk order is row-by-row.
  const vals = [1, 2, 3, 4, 5, 6];
  const { hdu, reader } = imageHdu(
    [card("BITPIX", 16), card("NAXIS", 2), card("NAXIS1", 2), card("NAXIS2", 3)],
    be(vals, 16),
  );
  const img = await readImage(hdu, reader);
  assert.deepEqual(img.shape, [2, 3]);
  assert.ok(img.data instanceof Int16Array);
  assert.deepEqual([...img.data], vals);
});

test("BITPIX -32 and 64 decode to Float32Array / BigInt64Array", async () => {
  const f = imageHdu(
    [card("BITPIX", -32), card("NAXIS", 1), card("NAXIS1", 3)],
    be([1.5, -2.25, 0], -32),
  );
  const fImg = await readImage(f.hdu, f.reader);
  assert.ok(fImg.data instanceof Float32Array);
  assert.deepEqual([...fImg.data], [1.5, -2.25, 0]);

  const i = imageHdu(
    [card("BITPIX", 64), card("NAXIS", 1), card("NAXIS1", 2)],
    be([5n, 9007199254740993n], 64),
  );
  const iImg = await readImage(i.hdu, i.reader);
  assert.ok(iImg.data instanceof BigInt64Array);
  assert.deepEqual([...iImg.data], [5n, 9007199254740993n]);
});

test("BZERO/BSCALE scale to Float64; BLANK becomes NaN", async () => {
  const { hdu, reader } = imageHdu(
    [
      card("BITPIX", 16),
      card("NAXIS", 1),
      card("NAXIS1", 4),
      card("BSCALE", 2),
      card("BZERO", 10),
      card("BLANK", -1),
    ],
    be([0, 5, -1, 7], 16),
  );
  const img = await readImage(hdu, reader);
  assert.ok(img.data instanceof Float64Array);
  assert.deepEqual([...img.data], [10, 20, NaN, 24]);
  assert.equal(img.blank, -1);
});

test("unsigned-integer convention: 16/8/64", async () => {
  const u16 = imageHdu(
    [card("BITPIX", 16), card("NAXIS", 1), card("NAXIS1", 2), card("BZERO", 32768)],
    be([-32768, 32767], 16),
  );
  const u16Img = await readImage(u16.hdu, u16.reader);
  assert.ok(u16Img.data instanceof Uint16Array);
  assert.deepEqual([...u16Img.data], [0, 65535]);

  const i8 = imageHdu(
    [card("BITPIX", 8), card("NAXIS", 1), card("NAXIS1", 2), card("BZERO", -128)],
    be([0, 255], 8),
  );
  const i8Img = await readImage(i8.hdu, i8.reader);
  assert.ok(i8Img.data instanceof Int8Array);
  assert.deepEqual([...i8Img.data], [-128, 127]);

  const u64 = imageHdu(
    [card("BITPIX", 64), card("NAXIS", 1), card("NAXIS1", 2), card("BZERO", 1n << 63n)],
    be([-(1n << 63n), (1n << 63n) - 1n], 64),
  );
  const u64Img = await readImage(u64.hdu, u64.reader);
  assert.ok(u64Img.data instanceof BigUint64Array);
  assert.deepEqual([...u64Img.data], [0n, (1n << 64n) - 1n]);
});

test("{ raw: true } skips scaling and returns the native array", async () => {
  const { hdu, reader } = imageHdu(
    [card("BITPIX", 16), card("NAXIS", 1), card("NAXIS1", 2), card("BSCALE", 3), card("BZERO", 1)],
    be([4, 5], 16),
  );
  const img = await readImage(hdu, reader, { raw: true });
  assert.ok(img.data instanceof Int16Array);
  assert.deepEqual([...img.data], [4, 5]);
  assert.equal(img.bscale, 3);
});

test("NAXIS=0 is a header-only HDU: empty shape and data", async () => {
  const { hdu, reader } = imageHdu([card("BITPIX", 8), card("NAXIS", 0)], new Uint8Array(0));
  const img = await readImage(hdu, reader);
  assert.deepEqual(img.shape, []);
  assert.equal(img.data.length, 0);
});

test("rejects a bad BITPIX, a non-image HDU, and truncated data", async () => {
  const bad = imageHdu([card("BITPIX", 99), card("NAXIS", 0)], new Uint8Array(0));
  await assert.rejects(() => readImage(bad.hdu, bad.reader), FitsStructureError);

  const bt = fits(
    [
      "XTENSION= 'BINTABLE'",
      card("BITPIX", 8),
      card("NAXIS", 2),
      card("NAXIS1", 0),
      card("NAXIS2", 0),
      card("PCOUNT", 0),
      card("GCOUNT", 1),
      card("TFIELDS", 0),
    ],
    new Uint8Array(0),
  );
  const prim = fits(["SIMPLE  =                    T", card("BITPIX", 8), card("NAXIS", 0)], bt);
  const { hdus } = readHdus(prim);
  await assert.rejects(() => readImage(hdus[1], new BytesReader(prim)), FitsStructureError);

  const trunc = imageHdu(
    [card("BITPIX", 16), card("NAXIS", 2), card("NAXIS1", 100), card("NAXIS2", 100)],
    be([1, 2, 3], 16), // far short of 100*100*2 bytes
  );
  await assert.rejects(() => readImage(trunc.hdu, trunc.reader), FitsStructureError);
});
