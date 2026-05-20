import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BytesReader, type RandomAccessReader } from "../io/reader.js";
import { NodeFileReader } from "../io/node-file-reader.js";
import { readImage } from "../image/image.js";
import { FitsHeaderError, FitsIoError, FitsStructureError } from "../errors.js";
import type { Hdu } from "./hdu.js";
import { readHdus, openFits } from "./read-hdus.js";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../test-fixtures/${name}`, import.meta.url)));
}

/** The structural fields openFits must reproduce identically to readHdus. */
const shape = (hdus: readonly Hdu[]) =>
  hdus.map((h) => ({
    index: h.index,
    type: h.type,
    name: h.name,
    version: h.version,
    dataOffset: h.dataOffset,
    dataByteLength: h.dataByteLength,
    dataSizeKnown: h.dataSizeKnown,
    cards: h.header.cards.length,
  }));

function countingReader(bytes: Uint8Array): {
  reader: RandomAccessReader;
  total: () => number;
  reads: () => ReadonlyArray<readonly [number, number]>;
} {
  const inner = new BytesReader(bytes);
  let total = 0;
  const reads: Array<readonly [number, number]> = [];
  return {
    reader: {
      size: inner.size,
      read: (o, l) => {
        reads.push([o, l]);
        total += l;
        return inner.read(o, l);
      },
    },
    total: () => total,
    reads: () => reads,
  };
}

/** Did any logged read overlap any HDU's data unit? */
function readsTouchData(
  reads: ReadonlyArray<readonly [number, number]>,
  hdus: readonly Hdu[],
): boolean {
  return reads.some(([o, l]) =>
    hdus.some((h) => o < h.dataOffset + h.dataByteLength && o + l > h.dataOffset),
  );
}

for (const name of ["fos-mef.fits", "dss-poss2.fits"]) {
  test(`openFits matches readHdus structurally on ${name}`, async () => {
    const bytes = fixture(name);
    const sync = readHdus(bytes);
    const async_ = await openFits(new BytesReader(bytes));
    assert.deepEqual(shape(async_.hdus), shape(sync.hdus));
    assert.deepEqual(async_.warnings, sync.warnings);
  });
}

test("openFits enumerates without materializing the data units", async () => {
  const bytes = fixture("fos-mef.fits");
  const { reader, reads } = countingReader(bytes);
  const { hdus } = await openFits(reader);

  assert.ok(hdus.length >= 1);
  assert.equal(hdus[0].dataSizeKnown, true);
  // The tight invariant: no read overlapped any HDU's data unit.
  assert.equal(readsTouchData(reads(), hdus), false, "enumeration must not read any data unit");
});

test("an openFits HDU drives a lazy readImage cutout end to end", async () => {
  const bytes = fixture("fos-mef.fits");
  const { reader, total, reads } = countingReader(bytes);
  const { hdus } = await openFits(reader);

  // Enumeration touched no data; recorded for the post-cutout comparison.
  assert.equal(readsTouchData(reads(), hdus), false);
  const enumBytes = total();

  const img = await readImage(hdus[0], reader, { region: { start: [100, 0], shape: [16, 2] } });
  assert.deepEqual([...img.shape], [16, 2]);

  assert.ok(total() < bytes.length, `total ${total()} of ${bytes.length}`);
  assert.ok(total() > enumBytes); // the cutout did fetch its region
});

test("size-undefined source: header-declared length is trusted (dataSizeKnown true)", async () => {
  const bytes = fixture("dss-poss2.fits");
  const unsized: RandomAccessReader = {
    size: undefined,
    read: (o, l) => Promise.resolve(bytes.subarray(o, Math.min(o + l, bytes.length))),
  };
  const { hdus } = await openFits(unsized);
  assert.equal(hdus[0].dataSizeKnown, true);
  assert.equal(hdus[0].type, "primary");
});

test("openFits over a real NodeFileReader matches readHdus", async () => {
  const path = new URL("../../test-fixtures/fos-mef.fits", import.meta.url);
  const reader = await NodeFileReader.open(path);
  try {
    const async_ = await openFits(reader);
    const sync = readHdus(new Uint8Array(readFileSync(path)));
    assert.deepEqual(shape(async_.hdus), shape(sync.hdus));
  } finally {
    await reader.close();
  }
});

// Synthetic-corner coverage of the reader-backed walk itself, not just the
// shared body: hand-built blocks, asserted equal to readHdus on the same
// bytes (the metamorphic oracle), per differential-testing.md.
const enc = new TextEncoder();
function blocks(cards: string[], trailing?: Uint8Array): Uint8Array {
  const s = cards.map((c) => c.padEnd(80).slice(0, 80)).join("");
  const head = enc.encode(s.padEnd(Math.ceil(s.length / 2880) * 2880, " "));
  if (!trailing) return head;
  const out = new Uint8Array(head.length + trailing.length);
  out.set(head, 0);
  out.set(trailing, head.length);
  return out;
}
const PRIMARY = [
  "SIMPLE  =                    T",
  "BITPIX  =                    8",
  "NAXIS   =                    0",
];

for (const end of ["END", "end", "  END"]) {
  test(`openFits matches readHdus with a "${end}" END card (parseHeader owns END)`, async () => {
    const buf = blocks([...PRIMARY, end]);
    const a = await openFits(new BytesReader(buf));
    assert.deepEqual(shape(a.hdus), shape(readHdus(buf).hdus));
    assert.equal(a.hdus.length, 1);
    assert.equal(a.hdus[0].dataSizeKnown, true);
  });
}

test("openFits handles a multi-block header (the grow loop)", async () => {
  const comments = Array.from({ length: 50 }, (_, i) => `COMMENT card ${i}`);
  const buf = blocks([...PRIMARY, ...comments, "END"]);
  const a = await openFits(new BytesReader(buf));
  assert.deepEqual(shape(a.hdus), shape(readHdus(buf).hdus));
  assert.equal(a.hdus[0].dataOffset, 5760); // header spans two 2880 blocks
});

test("openFits stops at an interior all-zero fill block, like readHdus", async () => {
  const buf = blocks([...PRIMARY, "END"], new Uint8Array(2880));
  const a = await openFits(new BytesReader(buf));
  assert.deepEqual(shape(a.hdus), shape(readHdus(buf).hdus));
  assert.equal(a.hdus.length, 1);
});

test("a truncated trailing header fails safe (sized and unsized reader)", async () => {
  // Valid primary, then a second header block with no END and no sizing
  // keywords: unusable. The contract is fail-safe, not byte-identical.
  const buf = blocks([...PRIMARY, "END"], blocks(["XTENSION= 'IMAGE   '"]));
  const last = (hs: readonly Hdu[]) => hs[hs.length - 1];

  const sized = await openFits(new BytesReader(buf));
  assert.equal(last(sized.hdus).dataSizeKnown, false);
  assert.deepEqual(shape(sized.hdus), shape(readHdus(buf).hdus));

  const unsized: RandomAccessReader = {
    size: undefined,
    read: (o, l) => Promise.resolve(buf.subarray(o, Math.min(o + l, buf.length))),
  };
  const u = await openFits(unsized);
  assert.equal(last(u.hdus).dataSizeKnown, false);
});

test("openFits rejects a missing or invalid reader with FitsIoError", async () => {
  await assert.rejects(() => openFits(null as unknown as RandomAccessReader), FitsIoError);
  await assert.rejects(() => openFits({ size: 0 } as unknown as RandomAccessReader), FitsIoError);
});

test("openFits handles a multi-block header in strict mode (no premature throw)", async () => {
  // Without lenient grow, parseHeader would throw on the partial first block
  // before the loop could fetch block two. This pins the strict-mode multi
  // -block case at the openFits boundary.
  const comments = Array.from({ length: 50 }, (_, i) => `COMMENT card ${i}`);
  const buf = blocks([...PRIMARY, ...comments, "END"]);
  const a = await openFits(new BytesReader(buf), { strict: true });
  assert.deepEqual(shape(a.hdus), shape(readHdus(buf, { strict: true }).hdus));
  assert.equal(a.hdus[0].dataOffset, 5760);
});

/** A reader that pretends to be huge and never serves an END card. */
function endlessNoEnd(): RandomAccessReader {
  const block = new Uint8Array(2880).fill(0x20); // ASCII spaces, no END
  return {
    size: 1 << 30,
    read: (_o, l) => Promise.resolve(block.subarray(0, l)),
  };
}

test("maxHeaderBlocks bounds the grow loop (lenient warns, strict throws)", async () => {
  const lenient = await openFits(endlessNoEnd(), { maxHeaderBlocks: 4 });
  assert.equal(lenient.hdus.length, 1);
  assert.equal(lenient.hdus[0].dataSizeKnown, false);
  assert.ok(
    lenient.warnings.some((w) => w.includes("exceeds 4 blocks without END")),
    `expected the bound warning, got ${JSON.stringify(lenient.warnings)}`,
  );

  await assert.rejects(
    () => openFits(endlessNoEnd(), { maxHeaderBlocks: 4, strict: true }),
    FitsStructureError,
  );
});

test("strict + no END at EOF throws FitsHeaderError, matching readHdus", async () => {
  // First block has all sizing keywords but no END card. parseHeader's
  // authoritative re-parse with strict throws; both paths agree.
  const noEnd = blocks([...PRIMARY, "COMMENT no END follows"]);
  assert.throws(() => readHdus(noEnd, { strict: true }), FitsHeaderError);
  await assert.rejects(() => openFits(new BytesReader(noEnd), { strict: true }), FitsHeaderError);
});

test("lenient + no END with valid sizing keywords still yields dataSizeKnown false", async () => {
  // Pre-tightening this would have set dataSizeKnown=true because the
  // declared data unit happens to fit the buffer. Now the warning ("no END
  // ...") and the HDU flag agree: a header that did not terminate is not
  // trusted to size its data unit.
  const buf = blocks(
    [
      "SIMPLE  =                    T",
      "BITPIX  =                    8",
      "NAXIS   =                    1",
      "NAXIS1  =                   10",
    ],
    new Uint8Array(2880).fill(1),
  );
  for (const result of [readHdus(buf), await openFits(new BytesReader(buf))]) {
    assert.equal(result.hdus.length, 1);
    assert.equal(result.hdus[0].dataSizeKnown, false);
    assert.ok(result.warnings.some((w) => w.includes("no END card")));
    assert.ok(result.warnings.some((w) => w.includes("enumeration stopped")));
  }
});

test("openFits respects an AbortSignal", async () => {
  const ac = new AbortController();
  ac.abort();
  const bytes = fixture("fos-mef.fits");
  await assert.rejects(
    () => openFits(new BytesReader(bytes), { signal: ac.signal }),
    (e: unknown) => e instanceof Error && !(e instanceof FitsIoError) && e.name === "AbortError",
  );
});
