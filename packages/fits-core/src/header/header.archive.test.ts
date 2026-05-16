import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FitsHeaderError } from "../errors.js";
import { parseHeader } from "./parse-header.js";

// Fixtures are real archive primary headers; the expected values were
// produced by astropy.io.fits on the same bytes (see test-fixtures/).
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../test-fixtures/${name}.hdr`, import.meta.url)));
}
interface Expected {
  cards: { keyword: string; type: string; value: unknown }[];
  continue?: Record<string, string>;
  hierarch?: Record<string, { value: number; comment: string }>;
}
function expected(name: string): Expected {
  return JSON.parse(
    readFileSync(new URL(`../../test-fixtures/${name}.expected.json`, import.meta.url), "utf8"),
  ) as Expected;
}

function assertMatchesAstropy(name: string) {
  const { header, warnings } = parseHeader(fixture(name));
  for (const c of expected(name).cards) {
    const got = header.get(c.keyword);
    if (c.type === "float") {
      assert.ok(
        typeof got === "number" &&
          Math.abs(got - (c.value as number)) <= 1e-9 * Math.max(1, Math.abs(c.value as number)),
        `${name}:${c.keyword} float ${JSON.stringify(got)} != ${JSON.stringify(c.value)}`,
      );
    } else {
      assert.deepEqual(got, c.value, `${name}:${c.keyword}`);
    }
  }
  return { header, warnings };
}

test("real HST WFPC2 primary header matches astropy", () => {
  assertMatchesAstropy("wfpc2-primary");
});

test("NASA testkeys primary header matches astropy", () => {
  const { warnings } = assertMatchesAstropy("testkeys-primary");
  // testkeys deliberately contains non-standard cards; lenient recovers.
  assert.ok(warnings.length > 0);
});

test("CONTINUE long string joins exactly as astropy does", () => {
  const { header } = parseHeader(fixture("testkeys-primary"));
  const exp = expected("testkeys-primary").continue!;
  assert.equal(header.getString("SVALUE"), exp.SVALUE);
});

test("ESO HIERARCH keyword, value and comment match astropy", () => {
  const { header } = parseHeader(fixture("testkeys-primary"));
  const exp = expected("testkeys-primary").hierarch!["ESO TEL AIRM START"];
  assert.equal(header.getNumber("ESO TEL AIRM START"), exp.value);
  const card = header.cards.find((c) => c.keyword === "ESO TEL AIRM START");
  assert.equal(card?.comment, exp.comment);
});

test("strict mode rejects the non-standard cards real files contain", () => {
  assert.throws(() => parseHeader(fixture("testkeys-primary"), { strict: true }), FitsHeaderError);
});
