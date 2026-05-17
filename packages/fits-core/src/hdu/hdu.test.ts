import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsHeader } from "../header/header.js";
import { findHdu, type Hdu } from "./hdu.js";

// findHdu only reads `name`/`version`; an empty header is enough to keep the
// Hdu shape honest without parsing one.
function hdu(over: Partial<Hdu>): Hdu {
  return {
    index: 0,
    type: "image",
    header: new FitsHeader([]),
    dataOffset: 0,
    dataByteLength: 0,
    dataSizeKnown: true,
    ...over,
  };
}

test("findHdu matches EXTNAME case-insensitively", () => {
  const hdus = [hdu({ index: 1, name: "SCI" })];
  assert.equal(findHdu(hdus, "sci")?.index, 1);
  assert.equal(findHdu(hdus, "SCI")?.index, 1);
  assert.equal(findHdu(hdus, "BKG"), undefined);
});

test("findHdu treats an absent EXTVER as version 1 (astropy parity)", () => {
  const hdus = [hdu({ index: 2, name: "SCI" })]; // no version
  assert.equal(findHdu(hdus, "SCI", 1)?.index, 2);
  assert.equal(findHdu(hdus, "SCI"), hdus[0]);
  assert.equal(findHdu(hdus, "SCI", 2), undefined);
});

test("findHdu honours an explicit EXTVER", () => {
  const hdus = [hdu({ index: 3, name: "SCI", version: 2 })];
  assert.equal(findHdu(hdus, "SCI", 2)?.index, 3);
  assert.equal(findHdu(hdus, "SCI", 1), undefined);
  assert.equal(findHdu(hdus, "SCI")?.index, 3); // version undefined ignores it
});

test("findHdu returns the first match and tolerates an empty list", () => {
  const hdus = [hdu({ index: 1, name: "SCI" }), hdu({ index: 4, name: "SCI" })];
  assert.equal(findHdu(hdus, "SCI")?.index, 1);
  assert.equal(findHdu([], "SCI"), undefined);
});
