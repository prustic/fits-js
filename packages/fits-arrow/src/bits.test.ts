import { test } from "node:test";
import assert from "node:assert/strict";
import { packBits, validityBitmap } from "./bits.js";

test("bits pack LSB first, across a partial last byte", () => {
  const bytes = Uint8Array.from([1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1]);
  assert.deepEqual([...packBits(bytes)], [0b10001101, 0b00010001]);
});

test("any non-zero byte packs as a set bit", () => {
  assert.deepEqual([...packBits(Uint8Array.from([2, 0, 255]))], [0b101]);
});

test("a null mask inverts into a validity bitmap with padding bits clear", () => {
  const { bitmap, nullCount } = validityBitmap(Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 1]));
  assert.deepEqual([...bitmap], [0b11111101, 0b00000001]);
  assert.equal(nullCount, 2);
});

test("an all-null mask leaves every bit clear", () => {
  const { bitmap, nullCount } = validityBitmap(new Uint8Array(16).fill(1));
  assert.deepEqual([...bitmap], [0, 0]);
  assert.equal(nullCount, 16);
});

test("empty input packs to an empty bitmap", () => {
  assert.equal(packBits(new Uint8Array(0)).length, 0);
  assert.deepEqual(validityBitmap(new Uint8Array(0)), { bitmap: new Uint8Array(0), nullCount: 0 });
});
