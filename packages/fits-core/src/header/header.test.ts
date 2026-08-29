import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsHeaderError } from "../errors.js";
import { isFitsComplex, type HeaderCard } from "./card.js";
import { FitsHeader } from "./header.js";
import { parseHeader } from "./parse-header.js";

/** Build header bytes from card images, padding to 2880 with spaces. */
function hdr(cards: string[]): Uint8Array {
  let s = cards.map((c) => c.padEnd(80).slice(0, 80)).join("");
  const blocks = Math.max(1, Math.ceil(s.length / 2880));
  s = s.padEnd(blocks * 2880, " ");
  return new TextEncoder().encode(s);
}

const END = "END";

test("typed scalar values", () => {
  const { header } = parseHeader(
    hdr([
      "SIMPLE  =                    T / conforms",
      "BITPIX  =                  -32",
      "NAXIS   =                    2",
      "PI      =     3.14159265358979",
      "EXP     =          1.0E10",
      "DEXP    =          2.5D3 / fortran double",
      "NEG     =                 -7",
      END,
    ]),
  );
  assert.equal(header.get("SIMPLE"), true);
  assert.equal(header.getNumber("BITPIX"), -32);
  assert.equal(header.getNumber("NAXIS"), 2);
  assert.equal(header.getNumber("PI"), 3.14159265358979);
  assert.equal(header.getNumber("EXP"), 1e10);
  assert.equal(header.getNumber("DEXP"), 2500);
  assert.equal(header.getNumber("NEG"), -7);
});

test("string value: trailing-space trim and doubled-quote escape", () => {
  const { header } = parseHeader(hdr(["OBJECT  = 'M51     '", "NOTE    = 'O''Brien field'", END]));
  assert.equal(header.getString("OBJECT"), "M51");
  assert.equal(header.getString("NOTE"), "O'Brien field");
});

test("big integer becomes bigint, safe integer stays number", () => {
  const { header } = parseHeader(
    hdr(["SMALL   = 42", "BIG     = 123456789012345678901234567890", END]),
  );
  assert.equal(header.get("SMALL"), 42);
  assert.equal(typeof header.get("SMALL"), "number");
  assert.equal(header.get("BIG"), 123456789012345678901234567890n);
});

test("complex value", () => {
  const { header } = parseHeader(hdr(["Z       = (1.5, -2.0)", END]));
  const z = header.get("Z");
  assert.ok(isFitsComplex(z));
  assert.deepEqual(z, { real: 1.5, imag: -2 });
});

test("COMMENT / HISTORY / blank are commentary, accumulate in order", () => {
  const { header } = parseHeader(
    hdr([
      "COMMENT first line",
      "HISTORY processed by pipeline v2",
      "COMMENT second line",
      "        a blank-keyword note",
      END,
    ]),
  );
  assert.deepEqual(header.comments, ["first line", "second line"]);
  assert.deepEqual(header.history, ["processed by pipeline v2"]);
  assert.equal(header.has("COMMENT"), false); // commentary is not value lookup
});

test("HIERARCH and ESO HIERARCH keyword extraction", () => {
  const { header } = parseHeader(
    hdr(["HIERARCH ESO DET CHIP1 NAME = 'CCD-44' / detector", "HIERARCH long key name = 7", END]),
  );
  assert.equal(header.getString("ESO DET CHIP1 NAME"), "CCD-44");
  assert.equal(header.getNumber("long key name"), 7);
});

test("CONTINUE long-string convention stitches value and comment", () => {
  const { header } = parseHeader(
    hdr([
      "LONG    = 'this value is too long to fit on a sin&' / part one &",
      "CONTINUE  'gle card so it spans several&'           / part two &",
      "CONTINUE  ' cards'                                  / done",
      END,
    ]),
  );
  assert.equal(
    header.getString("LONG"),
    "this value is too long to fit on a single card so it spans several cards",
  );
});

test("duplicate keywords: get first, getAll in order", () => {
  const { header } = parseHeader(hdr(["KEY     = 1", "KEY     = 2", "KEY     = 3", END]));
  assert.equal(header.get("KEY"), 1);
  assert.deepEqual(header.getAll("KEY"), [1, 2, 3]);
});

test("END terminates; byteLength is a 2880 multiple", () => {
  const { byteLength, header } = parseHeader(hdr(["SIMPLE  =                    T", END]));
  assert.equal(byteLength, 2880);
  assert.equal(header.get("SIMPLE"), true);
});

test("lenient recovers a non-standard value with a warning", () => {
  const { header, warnings } = parseHeader(hdr(["WEIRD   = not_quoted", END]));
  assert.equal(header.getString("WEIRD"), "not_quoted");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /non-standard value for WEIRD/);
});

test("strict throws FitsHeaderError with context on a bad value", () => {
  try {
    parseHeader(hdr(["WEIRD   = not_quoted", END]), { strict: true });
    assert.fail("expected throw");
  } catch (e) {
    if (!(e instanceof FitsHeaderError)) throw e;
    assert.equal(e.keyword, "WEIRD");
    assert.equal(e.cardIndex, 0);
  }
});

test("input validation", () => {
  assert.throws(() => parseHeader("not bytes" as unknown as Uint8Array), FitsHeaderError);
  // missing END: lenient warns, strict throws
  const noEnd = new TextEncoder().encode("SIMPLE  =                    T".padEnd(2880, " "));
  assert.equal(parseHeader(noEnd).warnings.length, 1);
  assert.throws(() => parseHeader(noEnd, { strict: true }), FitsHeaderError);
});

test("typed getters filter by type", () => {
  const { header } = parseHeader(hdr(["NUM     = 5", "STR     = 'hi'", "FLAG    = T", END]));
  assert.equal(header.getString("NUM"), undefined);
  assert.equal(header.getNumber("STR"), undefined);
  assert.equal(header.getBoolean("FLAG"), true);
  assert.equal(header.getBoolean("NUM"), undefined);
});

test("free-format string: spaces before quote, slash and doubled quote inside", () => {
  const { header } = parseHeader(
    hdr([
      "DATEOBS =   '01/02/24'",
      "PATH    = 'a/b/c' / has slashes",
      "NOTE    =  'O''Brien'",
      END,
    ]),
  );
  assert.equal(header.getString("DATEOBS"), "01/02/24");
  assert.equal(header.getString("PATH"), "a/b/c");
  assert.equal(header.getString("NOTE"), "O'Brien");
});

test("trailing & is literal when no CONTINUE follows", () => {
  const { header } = parseHeader(hdr(["TITLE   = 'R&D&'", "NEXT    = 1", END]));
  assert.equal(header.getString("TITLE"), "R&D&");
  assert.equal(header.getNumber("NEXT"), 1);
});

test("non-fixed-format value indicator is parsed, with a warning", () => {
  const { header, warnings } = parseHeader(hdr(["NAXIS   =2", END]));
  assert.equal(header.getNumber("NAXIS"), 2);
  assert.equal(header.has("NAXIS"), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /non-standard value indicator for NAXIS/);
  assert.throws(() => parseHeader(hdr(["NAXIS   =2", END]), { strict: true }), FitsHeaderError);
});

test("CONTINUE concatenates the comment too", () => {
  const { header } = parseHeader(
    hdr(["LONG    = 'part one&' / comment a&", "CONTINUE  ' part two' / comment b", END]),
  );
  const card = header.cards.find((c) => c.keyword === "LONG");
  assert.equal(header.getString("LONG"), "part one part two");
  assert.equal(card?.comment, "comment a& comment b");
});

test("multi-block header: byteLength spans both blocks", () => {
  const filler = Array.from({ length: 40 }, (_, i) => `KEY${i}`.padEnd(8) + "= " + i);
  const { header, byteLength } = parseHeader(hdr([...filler, END]));
  assert.equal(byteLength, 5760);
  assert.equal(header.getNumber("KEY39"), 39);
});

test("orphan CONTINUE does not crash and is not a value", () => {
  const { header } = parseHeader(hdr(["CONTINUE  'stray fragment'", "REAL    = 9", END]));
  assert.equal(header.has("CONTINUE"), false);
  assert.equal(header.getNumber("REAL"), 9);
});

test("unclosed quote does not throw in lenient mode", () => {
  const { header } = parseHeader(hdr(["BAD     = 'unterminated", "OK      = 1", END]));
  assert.equal(typeof header.getString("BAD"), "string");
  assert.equal(header.getNumber("OK"), 1);
});

test("keyword record without a value indicator is commentary, no warning", () => {
  const bytes = hdr(["FOOBAR   notes about the run", "X       = 1", END]);
  const { header, warnings } = parseHeader(bytes);
  assert.equal(warnings.length, 0);
  assert.equal(header.has("FOOBAR"), false);
  const card = header.cards.find((c) => c.keyword === "FOOBAR");
  assert.equal(card?.commentary, true);
  assert.equal(card?.raw, "FOOBAR   notes about the run");
  assert.doesNotThrow(() => parseHeader(bytes, { strict: true }));
});

test("HIERARCH without = falls through to commentary without crashing", () => {
  const { header } = parseHeader(hdr(["HIERARCH no equals sign here", "X       = 1", END]));
  assert.equal(header.getNumber("X"), 1);
});

test("isFitsComplex rejects non-complex values", () => {
  assert.equal(isFitsComplex(5), false);
  assert.equal(isFitsComplex("str"), false);
  assert.equal(isFitsComplex(undefined), false);
  assert.equal(isFitsComplex({ real: 1, imag: 2 }), true);
});

test("getNumber returns undefined for a bigint too large to represent", () => {
  const { header } = parseHeader(hdr(["BIG     = 123456789012345678901234567890", END]));
  assert.equal(header.getNumber("BIG"), undefined);
  assert.equal(header.get("BIG"), 123456789012345678901234567890n);
});

test("FitsHeader copies the cards array defensively", () => {
  const cards: HeaderCard[] = [{ keyword: "A", value: 1, commentary: false, raw: "A = 1" }];
  const header = new FitsHeader(cards);
  cards.push({ keyword: "B", value: 2, commentary: false, raw: "B = 2" });
  assert.equal(header.cards.length, 1);
  assert.equal(header.getNumber("B"), undefined);
});

test("& is the last non-blank char: trailing blanks before the quote still continue", () => {
  const { header } = parseHeader(
    hdr(["LONG    = 'first part&   '", "CONTINUE  'second part'", END]),
  );
  assert.equal(header.getString("LONG"), "first partsecond part");
});

test("HIERARCH collapses runs of internal spaces", () => {
  const { header } = parseHeader(hdr(["HIERARCH ESO  DET   GAIN = 2.3", END]));
  assert.equal(header.getNumber("ESO DET GAIN"), 2.3);
});

test("strict rejects an unterminated string", () => {
  assert.throws(
    () => parseHeader(hdr(["BAD     = 'oops", END]), { strict: true }),
    FitsHeaderError,
  );
  assert.doesNotThrow(() => parseHeader(hdr(["BAD     = 'oops", END])));
});

test("strict rejects a malformed CONTINUE body", () => {
  const cards = ["LONG    = 'starts&'", "CONTINUE  not a quoted string", END];
  assert.throws(() => parseHeader(hdr(cards), { strict: true }), FitsHeaderError);
  assert.doesNotThrow(() => parseHeader(hdr(cards)));
});

test("strict rejects non-standard keyword characters", () => {
  assert.throws(() => parseHeader(hdr(["lower   = 1", END]), { strict: true }), FitsHeaderError);
  const { header, warnings } = parseHeader(hdr(["lower   = 1", END]));
  assert.equal(header.getNumber("LOWER"), 1);
  assert.ok(warnings.some((w) => w.includes("non-standard keyword")));
});
