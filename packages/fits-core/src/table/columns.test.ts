import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsStructureError } from "../errors.js";
import { parseHeader } from "../header/parse-header.js";
import { parseTdim, parseTform, readTableColumns } from "./columns.js";

/** Build header bytes from card images, padding to 2880 with spaces. */
function hdr(cards: string[]): Uint8Array {
  let s = cards.map((c) => c.padEnd(80).slice(0, 80)).join("");
  const blocks = Math.max(1, Math.ceil(s.length / 2880));
  s = s.padEnd(blocks * 2880, " ");
  return new TextEncoder().encode(s);
}

/** Parse cards into a header and assemble its column model. */
function columns(cards: string[]) {
  const { header } = parseHeader(hdr([...cards, "END"]));
  return readTableColumns(header, 1);
}

test("parseTform: implicit repeat is 1", () => {
  assert.deepEqual(parseTform("E"), { code: "E", repeat: 1, raw: "E" });
  assert.deepEqual(parseTform("J"), { code: "J", repeat: 1, raw: "J" });
});

test("parseTform: explicit and zero repeat counts", () => {
  assert.deepEqual(parseTform("640E"), { code: "E", repeat: 640, raw: "640E" });
  assert.deepEqual(parseTform("0J"), { code: "J", repeat: 0, raw: "0J" });
  assert.deepEqual(parseTform("  5A"), { code: "A", repeat: 5, raw: "  5A" });
});

test("parseTform: every fixed-width code is recognized", () => {
  for (const code of ["L", "X", "B", "I", "J", "K", "A", "E", "D", "C", "M"]) {
    const t = parseTform(`3${code}`);
    assert.ok(t, `code ${code}`);
    assert.equal(t.code, code);
    assert.equal(t.repeat, 3);
  }
});

test("parseTform: P and Q descriptors", () => {
  assert.deepEqual(parseTform("1PE(200)"), {
    code: "P",
    repeat: 1,
    elementCode: "E",
    maxCount: 200,
    raw: "1PE(200)",
  });
  assert.deepEqual(parseTform("QD"), {
    code: "Q",
    repeat: 1,
    elementCode: "D",
    maxCount: undefined,
    raw: "QD",
  });
  assert.equal(parseTform("0PJ")?.repeat, 0);
});

test("parseTform: characters after the recognized portion stay in raw", () => {
  const t = parseTform("E15.7");
  assert.ok(t);
  assert.equal(t.code, "E");
  assert.equal(t.repeat, 1);
  assert.equal(t.raw, "E15.7");

  const p = parseTform("1PB(64) extra");
  assert.ok(p);
  assert.equal(p.maxCount, 64);
});

test("parseTform: malformed values are rejected", () => {
  for (const bad of [
    "",
    "12",
    "e",
    "3Z",
    "3PE",
    "P",
    "PP",
    "1PZ",
    "1PE(",
    "1PE(x)",
    "1PE(5",
    "9".repeat(16) + "J",
  ]) {
    assert.equal(parseTform(bad), undefined, `'${bad}'`);
  }
});

test("parseTdim: dimension lists", () => {
  assert.deepEqual(parseTdim("(3,2)"), [3, 2]);
  assert.deepEqual(parseTdim("(640)"), [640]);
  assert.deepEqual(parseTdim(" ( 4 , 5 , 6 ) "), [4, 5, 6]);
});

test("parseTdim: bad syntax is rejected", () => {
  for (const bad of ["", "3,2", "(3,2", "(3,,2)", "(0,2)", "()", "(3)(2)", "(3,2) x"]) {
    assert.equal(parseTdim(bad), undefined, `'${bad}'`);
  }
});

test("column offsets and widths across a mixed row", () => {
  const {
    columns: cols,
    rowWidth,
    warnings,
  } = columns([
    "TFIELDS =                    7",
    "TFORM1  = '5A'",
    "TFORM2  = '12X'",
    "TFORM3  = '1I'",
    "TFORM4  = '2K'",
    "TFORM5  = '3C'",
    "TFORM6  = '1PJ(9)'",
    "TFORM7  = '1QD'",
  ]);
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    cols.map((c) => [c.byteOffset, c.byteWidth]),
    [
      [0, 5], // 5A
      [5, 2], // 12X packs into ceil(12/8) bytes
      [7, 2], // 1I
      [9, 16], // 2K
      [25, 24], // 3C, 8 bytes per complex64
      [49, 8], // P descriptor
      [57, 16], // Q descriptor
    ],
  );
  assert.equal(rowWidth, 73);
});

test("TTYPE, TUNIT and TDISP are picked up", () => {
  const { columns: cols } = columns([
    "TFIELDS =                    2",
    "TFORM1  = '1E'",
    "TTYPE1  = 'FLUX'",
    "TUNIT1  = 'Jy'",
    "TDISP1  = 'E12.4'",
    "TFORM2  = '1J'",
  ]);
  assert.equal(cols[0].name, "FLUX");
  assert.equal(cols[0].unit, "Jy");
  assert.equal(cols[0].tdisp, "E12.4");
  assert.equal(cols[1].name, undefined);
});

test("TSCAL/TZERO defaults, values, and bigint TZERO on K", () => {
  const { columns: cols, warnings } = columns([
    "TFIELDS =                    3",
    "TFORM1  = '1I'",
    "TFORM2  = '1J'",
    "TSCAL2  = 0.01",
    "TZERO2  = 100.5",
    "TFORM3  = '1K'",
    "TZERO3  = 9223372036854775808",
  ]);
  assert.equal(warnings.length, 0);
  assert.equal(cols[0].tscal, 1);
  assert.equal(cols[0].tzero, 0);
  assert.equal(cols[1].tscal, 0.01);
  assert.equal(cols[1].tzero, 100.5);
  assert.equal(cols[2].tzeroBig, 9223372036854775808n);
  assert.equal(cols[2].tzero, 2 ** 63);
});

test("TSCAL/TZERO on L, X or A columns are ignored with a warning", () => {
  const { columns: cols, warnings } = columns([
    "TFIELDS =                    2",
    "TFORM1  = '4A'",
    "TSCAL1  = 2.0",
    "TFORM2  = '1L'",
    "TZERO2  = 5",
  ]);
  assert.equal(cols[0].tscal, 1);
  assert.equal(cols[1].tzero, 0);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /TSCAL1 does not apply to a A column/);
  assert.match(warnings[1], /TZERO2 does not apply to a L column/);
});

test("TNULL applies to integer columns, including varlen integer elements", () => {
  const { columns: cols, warnings } = columns([
    "TFIELDS =                    4",
    "TFORM1  = '1J'",
    "TNULL1  = -999",
    "TFORM2  = '1E'",
    "TNULL2  = -999",
    "TFORM3  = '1PJ'",
    "TNULL3  = -1",
    "TFORM4  = '1K'",
    "TNULL4  = -9223372036854775808",
  ]);
  assert.equal(cols[0].tnull, -999);
  assert.equal(cols[1].tnull, undefined);
  assert.equal(cols[2].tnull, -1);
  assert.equal(cols[3].tnullBig, -9223372036854775808n);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /column 2: TNULL2 does not apply to a E column/);
});

test("a zero TSCAL is applied but flagged", () => {
  const { columns: cols, warnings } = columns([
    "TFIELDS =                    1",
    "TFORM1  = '1I'",
    "TSCAL1  = 0",
  ]);
  assert.equal(cols[0].tscal, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TSCAL1 is 0; every scaled value collapses to TZERO/);
});

test("non-integer TNULL is ignored with a warning", () => {
  const { columns: cols, warnings } = columns([
    "TFIELDS =                    1",
    "TFORM1  = '1I'",
    "TNULL1  = 3.5",
  ]);
  assert.equal(cols[0].tnull, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TNULL1 3.5 is not an integer/);
});

test("TDIM is kept when consistent, dropped with a warning otherwise", () => {
  const { columns: cols, warnings } = columns([
    "TFIELDS =                    3",
    "TFORM1  = '6E'",
    "TDIM1   = '(3,2)'",
    "TFORM2  = '6E'",
    "TDIM2   = '(4,2)'",
    "TFORM3  = '6E'",
    "TDIM3   = 'x'",
  ]);
  assert.deepEqual(cols[0].tdim, [3, 2]);
  assert.equal(cols[1].tdim, undefined);
  assert.equal(cols[2].tdim, undefined);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /TDIM2 '\(4,2\)' implies 8 elements but the repeat is 6/);
  assert.match(warnings[1], /TDIM3 'x' is not a valid dimension list/);
});

test("duplicate TTYPE names warn", () => {
  const { warnings } = columns([
    "TFIELDS =                    2",
    "TFORM1  = '1E'",
    "TTYPE1  = 'flux'",
    "TFORM2  = '1E'",
    "TTYPE2  = 'FLUX'",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate TTYPE 'FLUX'/);
});

test("missing TFIELDS or TFORMn, or a malformed TFORMn, throws", () => {
  assert.throws(() => columns(["TFORM1  = '1E'"]), FitsStructureError);
  assert.throws(
    () => columns(["TFIELDS =                    2", "TFORM1  = '1E'"]),
    /TFORM2 is missing/,
  );
  assert.throws(
    () => columns(["TFIELDS =                    1", "TFORM1  = '3Z'"]),
    /TFORM1 '3Z' is not a valid BINTABLE format/,
  );
  assert.throws(
    () => columns(["TFIELDS =                 1000", "TFORM1  = '1E'"]),
    /TFIELDS 1000 is not an integer in 0..999/,
  );
});

test("TFIELDS of zero yields an empty model", () => {
  const { columns: cols, rowWidth, warnings } = columns(["TFIELDS =                    0"]);
  assert.equal(cols.length, 0);
  assert.equal(rowWidth, 0);
  assert.equal(warnings.length, 0);
});
