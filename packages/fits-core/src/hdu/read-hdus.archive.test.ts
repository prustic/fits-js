import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BytesReader } from "../io/reader.js";
import type { Hdu } from "./hdu.js";
import { readHdus, openFits } from "./read-hdus.js";

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

function assertLayout(label: string, hdus: readonly Hdu[], exp: ExpectedHdu[]) {
  assert.equal(hdus.length, exp.length, `${label} HDU count`);
  for (const e of exp) {
    const h = hdus[e.index];
    assert.equal(h.type, e.type, `${label}[${e.index}] type`);
    assert.equal(h.name ?? null, e.name, `${label}[${e.index}] EXTNAME`);
    assert.equal(h.version ?? null, e.version, `${label}[${e.index}] EXTVER`);
    assert.equal(h.dataOffset, e.dataOffset, `${label}[${e.index}] dataOffset`);
    assert.equal(h.dataByteLength, e.dataByteLength, `${label}[${e.index}] dataByteLength`);
  }
}

// Both the buffer path and the reader-backed lazy path are pinned to astropy
// independently, not just to each other.
async function checkAgainstAstropy(name: string) {
  const bytes = fixture(name);
  const exp = expected(name).hdus;
  assertLayout(`${name} readHdus`, readHdus(bytes).hdus, exp);
  assertLayout(`${name} openFits`, (await openFits(new BytesReader(bytes))).hdus, exp);
}

test("real primary + ASCII TABLE matches astropy fileinfo (FOS)", async () => {
  await checkAgainstAstropy("fos-mef");
});

test("real primary + BINTABLE matches astropy fileinfo (IUE)", async () => {
  await checkAgainstAstropy("iue-mef");
});
