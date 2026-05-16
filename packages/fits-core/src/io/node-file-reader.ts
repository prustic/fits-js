import { FitsIoError } from "../errors.js";
import { checkRange, type RandomAccessReader } from "./reader.js";

type FileHandle = Awaited<ReturnType<typeof import("node:fs/promises").open>>;

/**
 * A {@link RandomAccessReader} over a file on the Node/Bun/Deno filesystem.
 *
 * Construction is via the async {@link NodeFileReader.open} factory rather
 * than `new`: opening the file is asynchronous, and `node:fs/promises` is
 * imported dynamically so importing `@fits-js/core` stays free of any
 * static platform dependency and works unchanged in the browser.
 *
 * @example
 * ```ts
 * const reader = await NodeFileReader.open("/data/image.fits");
 * try {
 *   const header = await reader.read(0, 2880);
 * } finally {
 *   await reader.close();
 * }
 * ```
 */
export class NodeFileReader implements RandomAccessReader {
  private constructor(
    private readonly _handle: FileHandle,
    readonly size: number,
  ) {}

  static async open(path: string | URL): Promise<NodeFileReader> {
    const where = String(path);
    let fs: typeof import("node:fs/promises");
    try {
      fs = await import("node:fs/promises");
    } catch (cause) {
      throw new FitsIoError("node:fs/promises is unavailable in this runtime", {
        url: where,
        cause,
      });
    }
    try {
      const handle = await fs.open(path, "r");
      const { size } = await handle.stat();
      return new NodeFileReader(handle, size);
    } catch (cause) {
      throw new FitsIoError(`cannot open ${where}`, { url: where, cause });
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(offset, length);
    if (offset >= this.size) return new Uint8Array(0);
    const want = Math.min(length, this.size - offset);
    const buf = new Uint8Array(want);
    try {
      const { bytesRead } = await this._handle.read(buf, 0, want, offset);
      return bytesRead === want ? buf : buf.subarray(0, bytesRead);
    } catch (cause) {
      throw new FitsIoError("file read failed", { offset, cause });
    }
  }

  async close(): Promise<void> {
    await this._handle.close();
  }
}
