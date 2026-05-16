import { FitsIoError } from "../errors.js";
import { checkRange, type RandomAccessReader } from "./reader.js";

/** Options for {@link HttpRangeReader}. */
export interface HttpRangeReaderOptions {
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Page size cached and fetched at a time. Default 65536. */
  pageSize?: number;
  /** Merge missing-page runs separated by at most this many bytes into one request. Default 16384. */
  coalesceGap?: number;
  /** Approximate LRU page-cache budget in bytes. Default 8 MiB. */
  maxCacheBytes?: number;
  /** Extra request headers (for example authorization). */
  headers?: Record<string, string>;
  /** Aborts in-flight requests. */
  signal?: AbortSignal;
}

/** Parse a `Content-Range: bytes a-b/total` total, regex-free. */
function parseContentRangeTotal(value: string | null): number | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash < 0) return undefined;
  const total = value.slice(slash + 1).trim();
  if (total === "*") return undefined;
  const n = Number(total);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;

  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }

  return out;
}

type RunResult = { kind: "bytes"; bytes: Uint8Array } | { kind: "full" } | { kind: "eof" };

/**
 * A {@link RandomAccessReader} over an HTTP(S) URL using Range requests.
 *
 * The result of a read is assembled from the bytes actually fetched, so it
 * is correct regardless of cache eviction; the LRU page cache is purely an
 * optimization for overlapping reads. A short `206` is followed up until
 * the requested range is satisfied. End of file is concluded only from the
 * known size or a `416`, never from a cache miss. A server that ignores
 * `Range` (responds `200`) falls back to the whole body once; `If-Range`
 * guards against the resource changing mid-read.
 *
 * @example
 * ```ts
 * const reader = new HttpRangeReader("https://example.org/image.fits");
 * const header = await reader.read(0, 2880);
 * ```
 */
export class HttpRangeReader implements RandomAccessReader {
  private readonly _fetch: typeof fetch;
  private readonly _pageSize: number;
  private readonly _coalesceGap: number;
  private readonly _maxCacheBytes: number;
  private readonly _headers: Record<string, string>;
  private readonly _signal?: AbortSignal;
  private readonly _urlStr: string;

  private _size: number | undefined;
  private _metaPromise: Promise<void> | undefined;
  private _full: Uint8Array | undefined; // set if the server ignores Range
  private _etag: string | undefined;
  private readonly _pages = new Map<number, Uint8Array>(); // LRU by Map order
  private _cachedBytes = 0;

  constructor(
    private readonly _url: string | URL,
    options: HttpRangeReaderOptions = {},
  ) {
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new FitsIoError("no fetch available; pass options.fetch", {
        url: String(_url),
      });
    }

    this._fetch = f;
    this._urlStr = String(_url);
    this._pageSize = options.pageSize ?? 65536;
    this._coalesceGap = options.coalesceGap ?? 16384;
    this._maxCacheBytes = options.maxCacheBytes ?? 8 * 1024 * 1024;
    this._headers = options.headers ?? {};
    this._signal = options.signal;
  }

  get size(): number | undefined {
    return this._size;
  }

  private async _doFetch(range?: string): Promise<Response> {
    const headers: Record<string, string> = { ...this._headers };
    if (range) {
      headers.Range = range;
      if (this._etag) headers["If-Range"] = this._etag;
    }

    try {
      return await this._fetch(this._url, { headers, signal: this._signal });
    } catch (cause) {
      throw new FitsIoError(`fetch failed for ${this._urlStr}`, {
        url: this._urlStr,
        cause,
      });
    }
  }

  private _ensureMeta(): Promise<void> {
    // Single-flight: concurrent first reads must not double-probe.
    this._metaPromise ??= (async () => {
      const res = await this._doFetch("bytes=0-0");

      if (res.status === 206) {
        this._size = parseContentRangeTotal(res.headers.get("content-range"));
        this._etag = res.headers.get("etag") ?? res.headers.get("last-modified") ?? undefined;
        await res.arrayBuffer();
      } else if (res.ok) {
        this._full = new Uint8Array(await res.arrayBuffer());
        this._size = this._full.length;
      } else {
        throw new FitsIoError(`HTTP ${res.status} fetching ${this._urlStr}`, {
          url: this._urlStr,
          status: res.status,
        });
      }
    })();

    return this._metaPromise;
  }

  private _touch(pageIdx: number, page: Uint8Array): void {
    this._pages.delete(pageIdx);
    this._pages.set(pageIdx, page);
  }

  private _cachePages(runStartByte: number, body: Uint8Array): void {
    const startPage = Math.floor(runStartByte / this._pageSize);

    for (let pg = startPage; ; pg++) {
      const o = pg * this._pageSize - runStartByte;
      if (o >= body.length) break;

      if (!this._pages.has(pg)) {
        const slice = body.subarray(o, o + this._pageSize);
        this._pages.set(pg, slice);
        this._cachedBytes += slice.length;
      }
    }

    for (const [k, v] of this._pages) {
      if (this._cachedBytes <= this._maxCacheBytes) break;
      this._pages.delete(k);
      this._cachedBytes -= v.length;
    }
  }

  /**
   * Fetch `[absStart, absEndExcl)`, following up on short `206` responses
   * until the range is satisfied or the server reports `416` / `200`.
   */
  private async _fetchRange(absStart: number, absEndExcl: number): Promise<RunResult> {
    const end = this._size === undefined ? absEndExcl : Math.min(absEndExcl, this._size);

    const chunks: Uint8Array[] = [];
    let total = 0;
    let cur = absStart;

    while (cur < end) {
      const res = await this._doFetch(`bytes=${cur}-${end - 1}`);

      if (res.status === 416) {
        if (this._size === undefined || cur < this._size) this._size = cur;
        break;
      }

      if (res.status === 200) {
        this._full = new Uint8Array(await res.arrayBuffer());
        this._size = this._full.length;

        return { kind: "full" };
      }

      if (res.status !== 206) {
        throw new FitsIoError(`HTTP ${res.status} fetching ${this._urlStr}`, {
          url: this._urlStr,
          status: res.status,
          offset: cur,
        });
      }

      const body = new Uint8Array(await res.arrayBuffer());
      if (body.length === 0) {
        if (this._size === undefined || cur < this._size) this._size = cur;
        break;
      }

      chunks.push(body);
      total += body.length;
      cur += body.length;
    }

    if (total === 0) {
      return { kind: "eof" };
    }

    const bytes = chunks.length === 1 ? chunks[0] : concat(chunks, total);
    this._cachePages(absStart, bytes);

    return { kind: "bytes", bytes };
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(offset, length);
    await this._ensureMeta();

    if (this._full) {
      if (offset >= this._full.length) {
        return new Uint8Array(0);
      }

      return this._full.subarray(offset, Math.min(offset + length, this._full.length));
    }

    if (this._size !== undefined && offset >= this._size) {
      return new Uint8Array(0);
    }

    const want = this._size === undefined ? length : Math.min(length, this._size - offset);
    if (want <= 0) {
      return new Uint8Array(0);
    }

    const out = new Uint8Array(want);
    const absEnd = offset + want;
    let pos = offset;

    while (pos < absEnd) {
      const pageIdx = Math.floor(pos / this._pageSize);
      const cached = this._pages.get(pageIdx);

      if (cached) {
        const within = pos % this._pageSize;
        if (within >= cached.length) {
          break; // partial last page: EOF
        }

        const n = Math.min(cached.length - within, absEnd - pos);
        out.set(cached.subarray(within, within + n), pos - offset);
        this._touch(pageIdx, cached);
        pos += n;
        continue;
      }

      // Coalesce the run of missing pages up to absEnd, merging cached
      // gaps no larger than coalesceGap.
      const lastPage = Math.floor((absEnd - 1) / this._pageSize);
      let runEnd = pageIdx;

      for (let pg = pageIdx + 1; pg <= lastPage; pg++) {
        if (this._pages.has(pg)) {
          if ((pg - runEnd - 1) * this._pageSize > this._coalesceGap) {
            break;
          }

          continue;
        }

        runEnd = pg;
      }

      const runStartByte = pageIdx * this._pageSize;
      const res = await this._fetchRange(runStartByte, (runEnd + 1) * this._pageSize);

      if (res.kind === "full") {
        return this.read(offset, length);
      }

      if (res.kind === "eof") {
        break;
      }

      const copyEnd = Math.min(absEnd, runStartByte + res.bytes.length);
      if (copyEnd > pos) {
        out.set(res.bytes.subarray(pos - runStartByte, copyEnd - runStartByte), pos - offset);
      }

      const next = runStartByte + res.bytes.length;
      if (next <= pos) {
        break; // no progress (short body at EOF)
      }

      pos = next;
    }

    const produced = Math.min(want, Math.max(0, pos - offset));
    return produced === want ? out : out.subarray(0, produced);
  }
}
