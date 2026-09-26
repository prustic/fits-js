import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsStructureError } from "../errors.js";
import { parseHeader } from "../header/parse-header.js";
import {
  matchesTnull,
  parseAsciiTform,
  readAsciiColumns,
  readAsciiText,
  scanAsciiBigInt,
  scanAsciiFloat,
  scanAsciiInt,
} from "./ascii.js";

/** Build header bytes from card images, padding to 2880 with spaces. */
function hdr(cards: string[]): Uint8Array {
  let s = cards
    .concat("END")
    .map((c) => c.padEnd(80).slice(0, 80))
    .join("");
  s = s.padEnd(Math.max(1, Math.ceil(s.length / 2880)) * 2880, " ");
  return new TextEncoder().encode(s);
}

/** Parse cards and assemble the ASCII column model over a `naxis1`-wide row. */
function columns(cards: string[], naxis1 = 80) {
  const { header } = parseHeader(hdr(cards));
  return readAsciiColumns(header, 1, naxis1);
}

const noWarn = () => {};
const bytes = (s: string) => new TextEncoder().encode(s);

test("parseAsciiTform reads every code with its width", () => {
  assert.deepEqual(parseAsciiTform("A8", noWarn), {
    kind: "ascii",
    code: "A",
    width: 8,
    decimals: undefined,
    raw: "A8",
  });
  assert.deepEqual(parseAsciiTform("I11", noWarn), {
    kind: "ascii",
    code: "I",
    width: 11,
    decimals: undefined,
    raw: "I11",
  });
  assert.equal(parseAsciiTform("F6.2", noWarn)?.decimals, 2);
  assert.equal(parseAsciiTform("E15.7", noWarn)?.decimals, 7);
  assert.equal(parseAsciiTform("D25.16", noWarn)?.width, 25);
});

test("parseAsciiTform keeps trailing characters in raw", () => {
  const t = parseAsciiTform("E15.7   ", noWarn);
  assert.equal(t?.code, "E");
  assert.equal(t?.width, 15);
  assert.equal(t?.raw, "E15.7   ");
});

test("parseAsciiTform warns on a lower-case code and on a missing fraction", () => {
  const seen: string[] = [];
  const lower = parseAsciiTform("f6.2", (m) => seen.push(m));
  assert.equal(lower?.code, "F");
  assert.match(seen[0], /lower case/);

  seen.length = 0;
  const bare = parseAsciiTform("E15", (m) => seen.push(m));
  assert.equal(bare?.decimals, 0);
  assert.match(seen[0], /no fraction width/);
});

test("parseAsciiTform ignores a fraction width on A and I", () => {
  const seen: string[] = [];
  const t = parseAsciiTform("I11.2", (m) => seen.push(m));
  assert.equal(t?.decimals, undefined);
  assert.match(seen[0], /fraction width for a I field/);
});

test("parseAsciiTform rejects a leading repeat count", () => {
  // `8A` would be indistinguishable from `A8` if a repeat were guessed.
  assert.equal(parseAsciiTform("8A", noWarn), undefined);
});

test("parseAsciiTform rejects malformed values", () => {
  for (const bad of ["", "A", "B8", "L4", "X4", "A0", "A-3", "F6.", "F.2", "P8", "A1234567"]) {
    assert.equal(parseAsciiTform(bad, noWarn), undefined, `'${bad}'`);
  }
});

test("column offsets come from TBCOL, not from a running sum", () => {
  const { columns: cols, warnings } = columns(
    [
      "TFIELDS =                    3",
      "TFORM1  = 'A5'",
      "TBCOL1  =                    1",
      "TFORM2  = 'I11'",
      "TBCOL2  =                   20",
      "TFORM3  = 'F6.2'",
      "TBCOL3  =                   40",
      "PCOUNT  =                    0",
    ],
    50,
  );
  assert.deepEqual(
    cols.map((c) => [c.byteOffset, c.byteWidth]),
    [
      [0, 5],
      [19, 11],
      [39, 6],
    ],
  );
  assert.deepEqual(warnings, [], "gaps between fields are normal and silent");
});

test("overlapping fields warn once and both survive", () => {
  const { columns: cols, warnings } = columns(
    [
      "TFIELDS =                    2",
      "TFORM1  = 'I11'",
      "TBCOL1  =                    1",
      "TFORM2  = 'I11'",
      "TBCOL2  =                    5",
      "PCOUNT  =                    0",
    ],
    40,
  );
  assert.equal(cols.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /column 1 and column 2 overlap/);
});

test("a missing or out-of-range TBCOL is a structural error", () => {
  const base = [
    "TFIELDS =                    1",
    "TFORM1  = 'I11'",
    "PCOUNT  =                    0",
  ];
  assert.throws(() => columns(base), /TBCOL1 undefined is not an integer of 1 or more/);
  assert.throws(
    () => columns([...base, "TBCOL1  =                    0"]),
    /TBCOL1 0 is not an integer of 1 or more/,
  );
  assert.throws(
    () => columns([...base, "TBCOL1  =                   35"], 40),
    /spans columns 35\.\.45 but NAXIS1 is 40/,
  );
  assert.throws(() => columns([...base, "TBCOL1  =                  1.5"]), FitsStructureError);
});

test("a malformed or missing TFORM is a structural error", () => {
  assert.throws(
    () => columns(["TFIELDS =                    1", "TBCOL1  =                    1"]),
    /TFORM1 is missing/,
  );
  assert.throws(
    () =>
      columns([
        "TFIELDS =                    1",
        "TFORM1  = 'Z8'",
        "TBCOL1  =                    1",
      ]),
    /TFORM1 'Z8' is not a valid ASCII table format/,
  );
});

test("PCOUNT other than zero warns without failing", () => {
  const { warnings } = columns([
    "TFIELDS =                    0",
    "PCOUNT  =                   16",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PCOUNT 16 is not 0/);
});

test("TSCAL and TZERO are refused on an A field, kept elsewhere", () => {
  const { columns: cols, warnings } = columns(
    [
      "TFIELDS =                    2",
      "TFORM1  = 'A5'",
      "TBCOL1  =                    1",
      "TSCAL1  =                  2.0",
      "TFORM2  = 'F6.2'",
      "TBCOL2  =                   10",
      "TSCAL2  =                  0.5",
      "TZERO2  =                   10",
      "PCOUNT  =                    0",
    ],
    40,
  );
  assert.equal(cols[0].tscal, 1);
  assert.equal(cols[1].tscal, 0.5);
  assert.equal(cols[1].tzero, 10);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TSCAL1 does not apply to a A column/);
});

test("TNULL is kept as text, and a numeric one is stringified with a warning", () => {
  const { columns: cols, warnings } = columns(
    [
      "TFIELDS =                    2",
      "TFORM1  = 'I11'",
      "TBCOL1  =                    1",
      "TNULL1  = '***'",
      "TFORM2  = 'I11'",
      "TBCOL2  =                   15",
      "TNULL2  =                 -999",
      "PCOUNT  =                    0",
    ],
    40,
  );
  assert.equal(cols[0].tnullText, "***");
  assert.equal(cols[1].tnullText, "-999");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TNULL2 -999 is not a string/);
});

test("TDIM does not apply to an ASCII table", () => {
  const { warnings } = columns([
    "TFIELDS =                    1",
    "TFORM1  = 'I11'",
    "TBCOL1  =                    1",
    "TDIM1   = '(2,2)'",
    "PCOUNT  =                    0",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TDIM1 does not apply to an ASCII table/);
});

test("scanAsciiInt handles signs, blanks and an empty field", () => {
  assert.equal(scanAsciiInt(bytes("      42"), 0, 8), 42);
  assert.equal(scanAsciiInt(bytes("-17     "), 0, 8), -17);
  assert.equal(scanAsciiInt(bytes("   +8   "), 0, 8), 8);
  assert.equal(scanAsciiInt(bytes("        "), 0, 8), 0, "a blank field is 0");
});

test("scanAsciiInt refuses an embedded blank or stray character", () => {
  assert.ok(Number.isNaN(scanAsciiInt(bytes("1 2     "), 0, 8)));
  assert.ok(Number.isNaN(scanAsciiInt(bytes("12a     "), 0, 8)));
  assert.ok(Number.isNaN(scanAsciiInt(bytes("-       "), 0, 8)));
});

test("scanAsciiBigInt keeps a value past int32 exact", () => {
  assert.equal(scanAsciiBigInt(bytes("99999999999"), 0, 11), 99999999999n);
  assert.equal(scanAsciiBigInt(bytes("+          "), 0, 11), undefined);
  assert.equal(scanAsciiBigInt(bytes("           "), 0, 11), 0n);
});

test("scanAsciiFloat reads plain and signed values", () => {
  assert.equal(scanAsciiFloat(bytes(" -3.12"), 0, 6, 2), -3.12);
  assert.equal(scanAsciiFloat(bytes("  0.00"), 0, 6, 2), 0);
  assert.equal(scanAsciiFloat(bytes("      "), 0, 6, 2), 0, "a blank field is 0");
});

test("scanAsciiFloat takes the decimal point from d when the text has none", () => {
  // The deprecated implicit form (§7.2.5): 12345 under F8.3 is 12.345.
  // astropy reads it as 12345.0 instead; the standard is followed here.
  assert.equal(scanAsciiFloat(bytes("   12345"), 0, 8, 3), 12.345);
  assert.equal(scanAsciiFloat(bytes("  12.345"), 0, 8, 3), 12.345, "an explicit point wins");
});

// §7.2.5 allows a bare sign to introduce the exponent. astropy raises
// ValueError on that form, so this is asserted against the standard alone.
test("scanAsciiFloat accepts E, D and bare-sign exponents alike", () => {
  const want = 1.234e5;
  assert.equal(scanAsciiFloat(bytes("1.234E+05"), 0, 9, 3), want);
  assert.equal(scanAsciiFloat(bytes("1.234D+05"), 0, 9, 3), want);
  assert.equal(scanAsciiFloat(bytes("1.234+05 "), 0, 9, 3), want);
  assert.equal(scanAsciiFloat(bytes("1.234e5  "), 0, 9, 3), want);
  assert.equal(scanAsciiFloat(bytes("1.234E-05"), 0, 9, 3), 1.234e-5);
});

test("scanAsciiFloat refuses embedded blanks and broken exponents", () => {
  for (const bad of ["1. 34   ", "1.2.3   ", "1.2E    ", "1.2E+   ", "-       ", "1.2Q5   "]) {
    assert.ok(Number.isNaN(scanAsciiFloat(bytes(bad), 0, 8, 2)), `'${bad}'`);
  }
});

test("scanAsciiFloat matches the platform on long and extreme values", () => {
  const long = "1.8263573015259999E+02";
  assert.equal(scanAsciiFloat(bytes(long), 0, long.length, 16), Number("1.8263573015259999e2"));
  assert.equal(scanAsciiFloat(bytes("1E+400  "), 0, 8, 0), Number.POSITIVE_INFINITY);
  assert.equal(scanAsciiFloat(bytes("1E-400  "), 0, 8, 0), 0);
});

test("matchesTnull compares blank-trimmed on both sides", () => {
  assert.equal(matchesTnull(bytes("   ***  "), 0, 8, "***"), true);
  assert.equal(matchesTnull(bytes("***     "), 0, 8, "  ***"), true);
  assert.equal(matchesTnull(bytes("   42   "), 0, 8, "***"), false);
  assert.equal(matchesTnull(bytes("        "), 0, 8, "   "), true, "an all-blank TNULL");
});

test("readAsciiText drops trailing blanks and keeps leading ones", () => {
  assert.equal(readAsciiText(bytes("PIXEL   "), 0, 8), "PIXEL");
  assert.equal(readAsciiText(bytes("  MID   "), 0, 8), "  MID");
  assert.equal(readAsciiText(bytes("        "), 0, 8), "");
});
