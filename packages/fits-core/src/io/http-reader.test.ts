import { test } from "node:test";
import assert from "node:assert/strict";
import { FitsIoError } from "../errors.js";
import { HttpRangeReader } from "./http-reader.js";

const data = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);

/** Deterministic in-memory HTTP server honoring (or ignoring) Range. */
function server(mode: "ranged" | "norange" = "ranged") {
  const ranges: string[] = [];
  const fetch = (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const range = (init?.headers as Record<string, string>).Range;
    ranges.push(range ?? "(none)");
    if (mode === "norange") {
      return Promise.resolve(new Response(data, { status: 200 }));
    }
    if (!range) return Promise.resolve(new Response(data, { status: 200 }));
    const dash = range.indexOf("-");
    const a = Number(range.slice("bytes=".length, dash));
    const b = Number(range.slice(dash + 1));
    if (a >= data.length) return Promise.resolve(new Response(null, { status: 416 }));
    const end = Math.min(b + 1, data.length);
    return Promise.resolve(
      new Response(data.slice(a, end), {
        status: 206,
        headers: { "Content-Range": `bytes ${a}-${end - 1}/${data.length}` },
      }),
    );
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, ranges };
}

test("HttpRangeReader: lazy size discovery and correct ranged reads", async () => {
  const s = server();
  const r = new HttpRangeReader("https://x/f.fits", { fetch: s.fetch, pageSize: 512 });
  const head = await r.read(0, 2880);
  assert.deepEqual(head, data.subarray(0, 2880));
  assert.equal(r.size, 4096);
  assert.deepEqual(await r.read(4000, 999), data.subarray(4000, 4096));
});

test("HttpRangeReader: cache hit issues no further request", async () => {
  const s = server();
  const r = new HttpRangeReader("https://x/f.fits", { fetch: s.fetch, pageSize: 512 });
  await r.read(0, 100);
  const n = s.ranges.length;
  const again = await r.read(0, 100);
  assert.deepEqual(again, data.subarray(0, 100));
  assert.equal(s.ranges.length, n);
});

test("HttpRangeReader: missing pages around a cached page coalesce into one request", async () => {
  const s = server();
  const r = new HttpRangeReader("https://x/f.fits", { fetch: s.fetch, pageSize: 512 });
  await r.read(512, 10); // pre-cache page 1 only
  const before = s.ranges.length;
  // pages 0..3 needed; 1 is cached; 0 and 2,3 missing -> one coalesced fetch
  const span = await r.read(0, 4 * 512);
  assert.deepEqual(span, data.subarray(0, 2048));
  assert.equal(s.ranges.length - before, 1);
});

test("HttpRangeReader: read past EOF returns empty", async () => {
  const s = server();
  const r = new HttpRangeReader("https://x/f.fits", { fetch: s.fetch, pageSize: 512 });
  await r.read(0, 10);
  assert.equal((await r.read(4096, 100)).length, 0);
});

test("HttpRangeReader: server that ignores Range falls back to the whole body", async () => {
  const s = server("norange");
  const r = new HttpRangeReader("https://x/f.fits", { fetch: s.fetch, pageSize: 512 });
  assert.deepEqual(await r.read(100, 50), data.subarray(100, 150));
  const n = s.ranges.length;
  await r.read(200, 50); // served from the cached full body
  assert.equal(s.ranges.length, n);
});

test("HttpRangeReader without a usable fetch throws FitsIoError", () => {
  // A non-nullish non-function bypasses the `?? globalThis.fetch` default
  // and trips the guard.
  assert.throws(
    () => new HttpRangeReader("https://x/f.fits", { fetch: 0 as unknown as typeof fetch }),
    FitsIoError,
  );
});

/** 206 server that never returns more than `cap` bytes per response. */
function cappedServer(cap: number): typeof globalThis.fetch {
  const fetch = (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const range = (init?.headers as Record<string, string>).Range;
    if (!range) return Promise.resolve(new Response(data, { status: 200 }));
    const dash = range.indexOf("-");
    const a = Number(range.slice("bytes=".length, dash));
    const b = Number(range.slice(dash + 1));
    if (a >= data.length) return Promise.resolve(new Response(null, { status: 416 }));
    const end = Math.min(b + 1, data.length, a + cap);
    return Promise.resolve(
      new Response(data.slice(a, end), {
        status: 206,
        headers: { "Content-Range": `bytes ${a}-${end - 1}/${data.length}` },
      }),
    );
  };
  return fetch as unknown as typeof globalThis.fetch;
}

test("B1: a read larger than the cache budget still returns every byte", async () => {
  const s = server();
  const r = new HttpRangeReader("https://x/f.fits", {
    fetch: s.fetch,
    pageSize: 512,
    maxCacheBytes: 1024, // far smaller than the 4096-byte read
  });
  const all = await r.read(0, 4096);
  assert.equal(all.length, 4096);
  assert.deepEqual(all, data);
});

test("B2: a short 206 is followed up until the range is satisfied", async () => {
  const r = new HttpRangeReader("https://x/f.fits", {
    fetch: cappedServer(700),
    pageSize: 512,
  });
  const all = await r.read(0, 4096);
  assert.equal(all.length, 4096);
  assert.deepEqual(all, data);
});

test("HttpRangeReader: If-Range is sent once an ETag is known", async () => {
  const ifRange: (string | undefined)[] = [];
  const fetch = ((_u: string | URL, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>;
    ifRange.push(h["If-Range"]);
    const range = h.Range;
    const dash = range.indexOf("-");
    const a = Number(range.slice("bytes=".length, dash));
    const b = Number(range.slice(dash + 1));
    const end = Math.min(b + 1, data.length);
    return Promise.resolve(
      new Response(data.slice(a, end), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${a}-${end - 1}/${data.length}`,
          ETag: '"abc"',
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const r = new HttpRangeReader("https://x/f.fits", { fetch, pageSize: 512 });
  await r.read(0, 10);
  await r.read(2000, 10);
  assert.equal(ifRange[0], undefined); // probe: no ETag yet
  assert.ok(ifRange.slice(1).every((v) => v === '"abc"'));
});

test("HttpRangeReader: a network failure is wrapped as FitsIoError", async () => {
  const fetch = (() =>
    Promise.reject(new TypeError("ECONNREFUSED"))) as unknown as typeof globalThis.fetch;
  const r = new HttpRangeReader("https://x/f.fits", { fetch });
  await assert.rejects(
    () => r.read(0, 10),
    (e: unknown) => e instanceof FitsIoError && e.url === "https://x/f.fits",
  );
});

test("HttpRangeReader: an HTTP error carries the status", async () => {
  const fetch = (() =>
    Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof globalThis.fetch;
  const r = new HttpRangeReader("https://x/f.fits", { fetch });
  await assert.rejects(
    () => r.read(0, 10),
    (e: unknown) => e instanceof FitsIoError && e.status === 500,
  );
});
