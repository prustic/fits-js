import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsStructureError, FitsUnsupportedError } from "../errors.js";
import { findHdu } from "./hdu.js";
import { readHdus } from "./read-hdus.js";

const enc = new TextEncoder();

/** One HDU: a header from card strings (END appended) + padded data. */
function hdu(cards: string[], dataLen = 0): Uint8Array {
  let h = cards
    .concat("END")
    .map((c) => c.padEnd(80).slice(0, 80))
    .join("");
  h = h.padEnd(Math.max(1, Math.ceil(h.length / 2880)) * 2880, " ");
  const dataPadded = Math.ceil(dataLen / 2880) * 2880;
  const out = new Uint8Array(h.length + dataPadded);
  out.set(enc.encode(h), 0);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test("empty primary HDU, no data", () => {
  const { hdus } = readHdus(
    hdu([
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
    ]),
  );
  assert.equal(hdus.length, 1);
  assert.equal(hdus[0].type, "primary");
  assert.equal(hdus[0].dataByteLength, 0);
  assert.equal(hdus[0].dataOffset, 2880);
});

test("primary image: data size and offset from BITPIX/NAXIS", () => {
  // 16-bit, 10x10 = 200 bytes -> one 2880 block.
  const { hdus } = readHdus(
    hdu(
      [
        "SIMPLE  =                    T",
        "BITPIX  =                   16",
        "NAXIS   =                    2",
        "NAXIS1  =                   10",
        "NAXIS2  =                   10",
      ],
      200,
    ),
  );
  assert.equal(hdus[0].dataOffset, 2880);
  assert.equal(hdus[0].dataByteLength, 2880);
});

test("multi-extension: primary + IMAGE + BINTABLE + TABLE + unknown", () => {
  const primary = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
  ]);
  const image = hdu(
    [
      "XTENSION= 'IMAGE   '",
      "BITPIX  =                    8",
      "NAXIS   =                    1",
      "NAXIS1  =                  100",
      "EXTNAME = 'SCI     '",
      "EXTVER  =                    1",
    ],
    100,
  );
  const bintable = hdu(
    [
      "XTENSION= 'BINTABLE'",
      "BITPIX  =                    8",
      "NAXIS   =                    2",
      "NAXIS1  =                   12",
      "NAXIS2  =                    3",
      "PCOUNT  =                   40",
      "GCOUNT  =                    1",
      "EXTNAME = 'EVENTS  '",
    ],
    12 * 3 + 40,
  );
  const table = hdu(
    [
      "XTENSION= 'TABLE   '",
      "BITPIX  =                    8",
      "NAXIS   =                    2",
      "NAXIS1  =                    8",
      "NAXIS2  =                    2",
    ],
    16,
  );
  const weird = hdu(
    [
      "XTENSION= 'FOOBAR  '",
      "BITPIX  =                    8",
      "NAXIS   =                    1",
      "NAXIS1  =                   50",
    ],
    50,
  );
  const { hdus } = readHdus(concat(primary, image, bintable, table, weird));
  assert.deepEqual(
    hdus.map((h) => h.type),
    ["primary", "image", "bintable", "table", "unknown"],
  );
  // Offsets chain correctly through every data unit.
  for (let i = 1; i < hdus.length; i++) {
    assert.equal(hdus[i].header.getString("XTENSION") !== undefined, true, `HDU ${i} has XTENSION`);
  }
  const sci = findHdu(hdus, "sci", 1);
  assert.equal(sci?.index, 1);
  assert.equal(findHdu(hdus, "EVENTS")?.type, "bintable");
  assert.equal(findHdu(hdus, "SCI", 99), undefined);
});

test("unknown XTENSION is skipped so later HDUs stay reachable", () => {
  const out = concat(
    hdu([
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
    ]),
    hdu(
      [
        "XTENSION= 'WHATEVER'",
        "BITPIX  =                    8",
        "NAXIS   =                    1",
        "NAXIS1  =                  300",
      ],
      300,
    ),
    hdu([
      "XTENSION= 'IMAGE   '",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
      "EXTNAME = 'LAST    '",
    ]),
  );
  const { hdus } = readHdus(out);
  assert.equal(hdus.length, 3);
  assert.equal(hdus[1].type, "unknown");
  assert.equal(hdus[2].name, "LAST");
});

test("random-groups format is rejected", () => {
  const rg = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    2",
    "NAXIS1  =                    0",
    "NAXIS2  =                   10",
    "GROUPS  =                    T",
    "PCOUNT  =                    3",
    "GCOUNT  =                    5",
  ]);
  assert.throws(() => readHdus(rg), FitsUnsupportedError);
});

test("missing SIMPLE: lenient warns, strict throws", () => {
  const noSimple = hdu(["BITPIX  =                    8", "NAXIS   =                    0"]);
  const { warnings } = readHdus(noSimple);
  assert.ok(warnings.some((w) => w.includes("SIMPLE")));
  assert.throws(() => readHdus(noSimple, { strict: true }), FitsStructureError);
});

test("truncated data unit: lenient clamps and warns, strict throws", () => {
  // declares 5000 data bytes but the buffer only holds the header
  const truncated = hdu(
    [
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    1",
      "NAXIS1  =                 5000",
    ],
    0,
  );
  const { hdus, warnings } = readHdus(truncated);
  assert.ok(warnings.some((w) => w.includes("truncated")));
  assert.equal(hdus[0].dataByteLength, 0);
  assert.equal(hdus[0].dataSizeKnown, false);
  assert.throws(() => readHdus(truncated, { strict: true }), FitsStructureError);
});

test("trailing all-zero padding does not produce a spurious HDU", () => {
  const primary = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
  ]);
  const { hdus } = readHdus(concat(primary, new Uint8Array(2880)));
  assert.equal(hdus.length, 1);
});

test("XTENSION resolving through Object.prototype is not treated as a type", () => {
  for (const evil of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
    const out = concat(
      hdu([
        "SIMPLE  =                    T",
        "BITPIX  =                    8",
        "NAXIS   =                    0",
      ]),
      hdu([
        `XTENSION= '${evil.padEnd(8)}'`,
        "BITPIX  =                    8",
        "NAXIS   =                    0",
      ]),
    );
    const { hdus } = readHdus(out);
    assert.equal(hdus[1].type, "unknown", `${evil} -> unknown`);
  }
});

test("A3DTABLE is the legacy BINTABLE alias", () => {
  const out = concat(
    hdu([
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
    ]),
    hdu(
      [
        "XTENSION= 'A3DTABLE'",
        "BITPIX  =                    8",
        "NAXIS   =                    2",
        "NAXIS1  =                    4",
        "NAXIS2  =                    1",
      ],
      4,
    ),
  );
  const { hdus } = readHdus(out);
  assert.equal(hdus[1].type, "bintable");
});

test("missing structural keyword stops enumeration instead of desyncing", () => {
  const primary = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
  ]);
  // NAXIS=2 but NAXIS2 absent: data size is unknowable.
  const broken = hdu([
    "XTENSION= 'IMAGE   '",
    "BITPIX  =                   16",
    "NAXIS   =                    2",
    "NAXIS1  =                   10",
  ]);
  const after = hdu([
    "XTENSION= 'IMAGE   '",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
    "EXTNAME = 'AFTER   '",
  ]);
  const buf = concat(primary, broken, after);

  const { hdus, warnings } = readHdus(buf);
  assert.equal(hdus.length, 2); // primary + broken; AFTER not guessed at
  assert.equal(hdus[1].dataByteLength, 0);
  assert.ok(warnings.some((w) => w.includes("NAXIS2")));
  assert.ok(warnings.some((w) => w.includes("enumeration stopped")));
  assert.equal(findHdu(hdus, "AFTER"), undefined);

  assert.throws(() => readHdus(buf, { strict: true }), FitsStructureError);
});

test("missing BITPIX is reported, not silently zero-sized", () => {
  const broken = hdu([
    "SIMPLE  =                    T",
    "NAXIS   =                    1",
    "NAXIS1  =                  100",
  ]);
  const { warnings } = readHdus(broken);
  assert.ok(warnings.some((w) => w.includes("BITPIX")));
  assert.throws(() => readHdus(broken, { strict: true }), FitsStructureError);
});

test("illegal BITPIX is rejected, not used to compute a fractional span", () => {
  const bad = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                   24",
    "NAXIS   =                    1",
    "NAXIS1  =                  100",
  ]);
  const { hdus, warnings } = readHdus(bad);
  assert.ok(warnings.some((w) => w.includes("BITPIX 24")));
  assert.equal(hdus[0].dataSizeKnown, false);
  assert.equal(hdus[0].dataByteLength, 0);
  assert.throws(() => readHdus(bad, { strict: true }), FitsStructureError);
});

test("negative NAXISn never yields a negative dataByteLength", () => {
  const buf = concat(
    hdu([
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
    ]),
    hdu([
      "XTENSION= 'IMAGE   '",
      "BITPIX  =                    8",
      "NAXIS   =                    1",
      "NAXIS1  =                  -10",
    ]),
  );
  const { hdus, warnings } = readHdus(buf);
  assert.ok(warnings.some((w) => w.includes("NAXIS1")));
  for (const h of hdus) assert.ok(h.dataByteLength >= 0);
  assert.equal(hdus[1].dataSizeKnown, false);
  assert.throws(() => readHdus(buf, { strict: true }), FitsStructureError);
});

test("negative PCOUNT is rejected", () => {
  const bad = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    1",
    "NAXIS1  =                   10",
    "PCOUNT  =                   -5",
  ]);
  const { warnings } = readHdus(bad);
  assert.ok(warnings.some((w) => w.includes("PCOUNT")));
  assert.throws(() => readHdus(bad, { strict: true }), FitsStructureError);
});

test("dimension overflow past 2^53 is rejected, not silently imprecise", () => {
  const bad = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    3",
    "NAXIS1  =           1000000000",
    "NAXIS2  =           1000000000",
    "NAXIS3  =           1000000000",
  ]);
  const { warnings } = readHdus(bad);
  assert.ok(warnings.some((w) => w.includes("overflow")));
  assert.throws(() => readHdus(bad, { strict: true }), FitsStructureError);
});

test("zero-row table with a heap (NAXIS2=0, PCOUNT>0) keeps its heap data", () => {
  const buf = concat(
    hdu([
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
    ]),
    hdu(
      [
        "XTENSION= 'BINTABLE'",
        "BITPIX  =                    8",
        "NAXIS   =                    2",
        "NAXIS1  =                   20",
        "NAXIS2  =                    0",
        "PCOUNT  =                  500",
        "GCOUNT  =                    1",
      ],
      500,
    ),
  );
  const { hdus } = readHdus(buf);
  assert.equal(hdus[1].dataSizeKnown, true);
  assert.equal(hdus[1].dataByteLength, 2880); // ceil(0+500 /2880)
});

test("findHdu treats an absent EXTVER as version 1 (astropy parity)", () => {
  const buf = concat(
    hdu([
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
    ]),
    hdu([
      "XTENSION= 'IMAGE   '",
      "BITPIX  =                    8",
      "NAXIS   =                    0",
      "EXTNAME = 'SCI     '",
    ]),
  );
  const { hdus } = readHdus(buf);
  assert.equal(findHdu(hdus, "SCI", 1)?.index, 1);
  assert.equal(findHdu(hdus, "SCI")?.index, 1);
  assert.equal(findHdu(hdus, "SCI", 2), undefined);
});

test("a well-formed HDU reports dataSizeKnown true", () => {
  const { hdus } = readHdus(
    hdu(
      [
        "SIMPLE  =                    T",
        "BITPIX  =                   16",
        "NAXIS   =                    1",
        "NAXIS1  =                   10",
      ],
      20,
    ),
  );
  assert.equal(hdus[0].dataSizeKnown, true);
});

test("a no-END header that overshoots the buffer never yields a negative span", () => {
  const primary = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
  ]);
  // Second header: real cards, NO END, padded to a non-block size so
  // parseHeader rounds its length up past what the buffer holds.
  let raw = [
    "XTENSION= 'IMAGE   '",
    "BITPIX  =                    8",
    "NAXIS   =                    1",
    "NAXIS1  =                  100",
  ]
    .map((c) => c.padEnd(80))
    .join("");
  raw = raw.padEnd(4000, " ");
  const buf = concat(primary, enc.encode(raw));

  const { hdus, warnings } = readHdus(buf);
  for (const h of hdus) {
    assert.ok(h.dataByteLength >= 0, "no negative span");
    assert.ok(h.dataOffset + h.dataByteLength <= buf.length, "in bounds");
  }
  const last = hdus[hdus.length - 1];
  assert.equal(last.dataByteLength, 0);
  assert.equal(last.dataSizeKnown, false);
  assert.ok(warnings.some((w) => w.includes("header is truncated")));
  // strict: parseHeader rejects the missing END first (fatal, astropy-like).
  assert.throws(() => readHdus(buf, { strict: true }));
});

test("an absurd declared size is reported as overflow, not as truncation", () => {
  const bad = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                   64",
    "NAXIS   =                    1",
    "NAXIS1  =                    1",
    "PCOUNT  =     9000000000000000",
  ]);
  const { warnings } = readHdus(bad);
  assert.ok(warnings.some((w) => w.includes("overflow")));
  assert.ok(!warnings.some((w) => w.includes("truncated")));
  assert.throws(() => readHdus(bad, { strict: true }), FitsStructureError);
});

test("empty input warns rather than returning silently", () => {
  const { hdus, warnings } = readHdus(new Uint8Array(0));
  assert.equal(hdus.length, 0);
  assert.ok(warnings.some((w) => w.includes("shorter than one 2880-byte block")));
});

test("an all-zero first block warns rather than returning silently", () => {
  const { hdus, warnings } = readHdus(new Uint8Array(2880));
  assert.equal(hdus.length, 0);
  assert.ok(warnings.some((w) => w.includes("first header block is all zeros")));
});

test("strict mode rejects empty and all-zero input", () => {
  assert.throws(() => readHdus(new Uint8Array(0), { strict: true }), FitsStructureError);
  assert.throws(() => readHdus(new Uint8Array(2880), { strict: true }), FitsStructureError);
});

test("trailing zero fill after a valid HDU stays silent", () => {
  const primary = hdu([
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
  ]);
  const { hdus, warnings } = readHdus(concat(primary, new Uint8Array(2880)));
  assert.equal(hdus.length, 1);
  assert.deepEqual(warnings, []);
});

test("SIMPLE = F warns in both modes and never throws", () => {
  const bytes = hdu([
    "SIMPLE  =                    F",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
  ]);
  const lenient = readHdus(bytes);
  assert.equal(lenient.hdus.length, 1);
  assert.ok(lenient.warnings.some((w) => w.includes("SIMPLE = F")));
  const strictRes = readHdus(bytes, { strict: true });
  assert.equal(strictRes.hdus.length, 1);
  assert.ok(strictRes.warnings.some((w) => w.includes("SIMPLE = F")));
});
