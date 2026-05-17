import { FitsIoError } from "../errors.js";

/**
 * A seekable byte source. Every fits-js entry point that reads a file
 * works through this interface, so the same parser runs over an in-memory
 * buffer, a browser `Blob`, a Node file, or an HTTP endpoint with Range
 * support.
 *
 * `read` returns the bytes for `[offset, offset + length)`, or fewer at the
 * end of the source. The returned array may be a view into an internal
 * buffer; treat it as read-only and copy if you need to retain it.
 */
export interface RandomAccessReader {
  /** Total length in bytes, or `undefined` if the source size is unknown. */
  readonly size: number | undefined;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Release any held resource (file handle, cache). Optional. */
  close?(): Promise<void>;
}

/** @internal Reject ranges that are not finite non-negative integers. */
export function checkRange(offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new FitsIoError(`read offset ${offset} is not a non-negative integer`);
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new FitsIoError(`read length ${length} is not a non-negative integer`);
  }
}

/**
 * A {@link RandomAccessReader} over bytes already in memory.
 *
 * @example
 * ```ts
 * const reader = new BytesReader(new Uint8Array(buffer));
 * const firstBlock = await reader.read(0, 2880);
 * ```
 */
export class BytesReader implements RandomAccessReader {
  private readonly _bytes: Uint8Array;
  readonly size: number;

  /** Does not copy `data`; do not mutate it after constructing. */
  constructor(data: Uint8Array | ArrayBuffer) {
    this._bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.size = this._bytes.length;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(offset, length);
    if (offset >= this._bytes.length) {
      return Promise.resolve(new Uint8Array(0));
    }

    return Promise.resolve(
      this._bytes.subarray(offset, Math.min(offset + length, this._bytes.length)),
    );
  }
}

/**
 * A {@link RandomAccessReader} over a browser `Blob` or `File`. Reads use
 * `Blob.slice`, so bytes are only pulled from disk on demand.
 *
 * @example
 * ```ts
 * input.addEventListener("change", async () => {
 *   const reader = new BlobReader(input.files[0]);
 *   const header = await reader.read(0, 2880);
 * });
 * ```
 */
export class BlobReader implements RandomAccessReader {
  readonly size: number;

  constructor(private readonly _blob: Blob) {
    this.size = _blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(offset, length);
    if (offset >= this._blob.size) {
      return new Uint8Array(0);
    }

    const end = Math.min(offset + length, this._blob.size);

    try {
      return new Uint8Array(await this._blob.slice(offset, end).arrayBuffer());
    } catch (cause) {
      throw new FitsIoError("Blob read failed", { offset, cause });
    }
  }
}
