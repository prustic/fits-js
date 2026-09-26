import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeUtf8 } from "./utf8.js";

test("ASCII strings are packed back to back behind their offsets", () => {
  const { offsets, bytes } = encodeUtf8(["ab", "", "cde"]);
  assert.deepEqual([...offsets], [0, 2, 2, 5]);
  assert.equal(new TextDecoder().decode(bytes), "abcde");
});

test("latin1 characters above 0x7f take two bytes", () => {
  // Core decodes character fields as latin1, so 0xE9 arrives as "é".
  const { offsets, bytes } = encodeUtf8(["été", "°"]);
  assert.deepEqual([...offsets], [0, 5, 7]);
  assert.deepEqual([...bytes], [0xc3, 0xa9, 0x74, 0xc3, 0xa9, 0xc2, 0xb0]);
});

test("astral characters take four bytes, others and lone surrogates three", () => {
  const { offsets, bytes } = encodeUtf8(["\u{1f52d}", "\ud800x", "\u20ac", "\ud800"]);
  assert.deepEqual([...offsets], [0, 4, 8, 11, 14]);
  assert.deepEqual(
    [...bytes.subarray(4)],
    [0xef, 0xbf, 0xbd, 0x78, 0xe2, 0x82, 0xac, 0xef, 0xbf, 0xbd],
  );
});

test("no strings encode to a single zero offset", () => {
  const { offsets, bytes } = encodeUtf8([]);
  assert.deepEqual([...offsets], [0]);
  assert.equal(bytes.length, 0);
});
