import { test } from "node:test";
import assert from "node:assert/strict";
import { isFitsComplex, type HeaderValue } from "./card.js";

test("isFitsComplex narrows a (real, imag) pair", () => {
  const v: HeaderValue = { real: 1.5, imag: -2 };
  assert.equal(isFitsComplex(v), true);
  if (isFitsComplex(v)) {
    assert.equal(v.real + v.imag, -0.5); // compiles only if narrowed
  }
});

test("isFitsComplex tolerates extra properties on the pair", () => {
  assert.equal(isFitsComplex({ real: 0, imag: 0, note: "x" } as HeaderValue), true);
});

test("isFitsComplex rejects scalars, undefined, and partial pairs", () => {
  for (const v of [42, "1+2j", true, 9007199254740993n, undefined] as HeaderValue[]) {
    assert.equal(isFitsComplex(v), false);
  }
  assert.equal(isFitsComplex({ real: 1 } as unknown as HeaderValue), false);
  assert.equal(isFitsComplex({ imag: 1 } as unknown as HeaderValue), false);
  assert.equal(isFitsComplex(null as unknown as HeaderValue), false);
});
