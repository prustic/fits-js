import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsIoError } from "../errors.js";
import { BytesReader, BlobReader } from "./reader.js";

const sample = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);

test("BytesReader: size, ranged read, EOF clamp", async () => {
  const r = new BytesReader(sample);
  assert.equal(r.size, 5000);
  const a = await r.read(0, 2880);
  assert.deepEqual(a, sample.subarray(0, 2880));
  const tail = await r.read(4900, 1000); // clamps at EOF
  assert.equal(tail.length, 100);
  assert.deepEqual(tail, sample.subarray(4900, 5000));
  assert.equal((await r.read(5000, 10)).length, 0);
});

test("BytesReader accepts an ArrayBuffer", async () => {
  const r = new BytesReader(sample.slice().buffer);
  assert.equal(r.size, 5000);
  assert.deepEqual(await r.read(10, 5), sample.subarray(10, 15));
});

test("checkRange throws on non-integer / negative ranges", () => {
  const r = new BytesReader(sample);
  assert.throws(() => r.read(-1, 10), FitsIoError);
  assert.throws(() => r.read(0, -10), FitsIoError);
  assert.throws(() => r.read(1.5, 10), FitsIoError);
});

test("BlobReader reads on demand", async () => {
  const r = new BlobReader(new Blob([sample]));
  assert.equal(r.size, 5000);
  assert.deepEqual(await r.read(100, 50), sample.subarray(100, 150));
  assert.equal((await r.read(9999, 1)).length, 0);
});
