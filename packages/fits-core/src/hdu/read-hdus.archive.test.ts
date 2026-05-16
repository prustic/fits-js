import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readHdus } from "./read-hdus.js";

// Real multi-extension archive files; expected HDU layout (type, name,
// version, data offset/span) is astropy.io.fits fileinfo() on the same file.
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../test-fixtures/${name}.fits`, import.meta.url)));
}
interface ExpectedHdu {
  index: number;
  type: string;
  name: string | null;
  version: number | null;
  dataOffset: number;
  dataByteLength: number;
}
function expected(name: string): { hdus: ExpectedHdu[] } {
  return JSON.parse(
    readFileSync(new URL(`../../test-fixtures/${name}.expected.json`, import.meta.url), "utf8"),
  ) as { hdus: ExpectedHdu[] };
}

function checkAgainstAstropy(name: string) {
  const { hdus } = readHdus(fixture(name));
  const exp = expected(name).hdus;
  assert.equal(hdus.length, exp.length, `${name} HDU count`);
  for (const e of exp) {
    const h = hdus[e.index];
    assert.equal(h.type, e.type, `${name}[${e.index}] type`);
    assert.equal(h.name ?? null, e.name, `${name}[${e.index}] EXTNAME`);
    assert.equal(h.version ?? null, e.version, `${name}[${e.index}] EXTVER`);
    assert.equal(h.dataOffset, e.dataOffset, `${name}[${e.index}] dataOffset`);
    assert.equal(h.dataByteLength, e.dataByteLength, `${name}[${e.index}] dataByteLength`);
  }
}

test("real primary + ASCII TABLE matches astropy fileinfo (FOS)", () => {
  checkAgainstAstropy("fos-mef");
});

test("real primary + BINTABLE matches astropy fileinfo (IUE)", () => {
  checkAgainstAstropy("iue-mef");
});
