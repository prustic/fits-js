import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FitsIoError } from "../errors.js";
import { BytesReader } from "./reader.js";
import { NodeFileReader } from "./node-file-reader.js";

const sample = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);

test("NodeFileReader: size, ranged read, EOF clamp, close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fitsio-"));
  const path = join(dir, "s.bin");
  try {
    await writeFile(path, sample);
    const r = await NodeFileReader.open(path);
    assert.equal(r.size, 5000);
    assert.deepEqual(await r.read(0, 2880), sample.subarray(0, 2880));
    assert.deepEqual(await r.read(4990, 100), sample.subarray(4990, 5000));
    assert.equal((await r.read(5000, 10)).length, 0); // past EOF
    await r.close?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NodeFileReader rejects an invalid range", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fitsio-"));
  const path = join(dir, "s.bin");
  try {
    await writeFile(path, sample);
    const r = await NodeFileReader.open(path);
    try {
      await assert.rejects(() => r.read(-1, 10), FitsIoError);
      await assert.rejects(() => r.read(0, 2.5), FitsIoError);
    } finally {
      await r.close?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NodeFileReader agrees byte-for-byte with the in-memory reader on a real archive file", async () => {
  const path = new URL("../../test-fixtures/fos-mef.fits", import.meta.url);
  const whole = new Uint8Array(readFileSync(path));
  const node = await NodeFileReader.open(path);
  const mem = new BytesReader(whole);
  try {
    assert.equal(node.size, whole.length);
    for (const [off, len] of [
      [0, 2880],
      [14400, 5000],
      [whole.length - 100, 500], // clamps at EOF
    ] as const) {
      const a = await node.read(off, len);
      assert.deepEqual(a, await mem.read(off, len));
      assert.deepEqual(a, whole.subarray(off, Math.min(off + len, whole.length)));
    }
  } finally {
    await node.close?.();
  }
});

test("NodeFileReader.open wraps a filesystem failure as FitsIoError", async () => {
  await assert.rejects(
    () => NodeFileReader.open("/no/such/fits-js/file.fits"),
    (e: unknown) => e instanceof FitsIoError && e.url?.includes("file.fits") === true,
  );
});
