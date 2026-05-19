import { FitsStructureError } from "../errors.js";
import type { FitsHeader } from "../header/header.js";
import type { Hdu } from "../hdu/hdu.js";
import type { RandomAccessReader } from "../io/reader.js";

/** Every typed-array kind {@link readImage} can return. */
export type ImageArray =
  | Uint8Array
  | Int8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/**
 * A decoded image array plus the metadata needed to interpret it.
 *
 * `shape` is in FITS axis order (`NAXIS1` first, and `NAXIS1` is the
 * fastest-varying axis on disk). `data` is row-major in that order, so the
 * element at FITS index `(i1, i2, …)` is at
 * `i1 + NAXIS1 * (i2 + NAXIS2 * (…))`.
 *
 * Unless `{ raw: true }` was passed, `BZERO`/`BSCALE` have been applied
 * following astropy: a scaled array is `Float64Array` with `BLANK` pixels
 * set to `NaN`; the unsigned-integer convention
 * (`BSCALE=1`, `BZERO=2^(n-1)`) yields the matching unsigned typed array
 * instead. With no scaling the on-disk integer array is returned as-is and
 * `blank` (if present) lets the caller mask undefined pixels.
 */
export interface FitsImage {
  /** Axis lengths in FITS order; `[]` for a header-only (`NAXIS=0`) HDU. */
  readonly shape: readonly number[];
  readonly data: ImageArray;
  /** `BITPIX` as written in the header (8, 16, 32, 64, -32, -64). */
  readonly bitpix: number;
  readonly bscale: number;
  readonly bzero: number;
  /** `BLANK` (integer images only), when the header declares it. */
  readonly blank?: number;
}

/** Options for {@link readImage}. */
export interface ReadImageOptions {
  /**
   * Return the on-disk array without applying `BZERO`/`BSCALE` or the
   * unsigned-integer convention. The native typed array for `BITPIX` is
   * returned (`Int16Array` for 16, `Float32Array` for -32, …).
   */
  raw?: boolean;
}

const VALID_BITPIX = new Set([8, 16, 32, 64, -32, -64]);

interface Layout {
  bitpix: number;
  axes: number[]; // FITS order, NAXIS1 first
  count: number; // product of axes (0 when NAXIS=0)
  bytes: number; // count * bytesPerElement
  bscale: number;
  bzero: number; // numeric BZERO; the uint64 case is detected from bzeroBig
  bzeroBig?: bigint; // BZERO when the header carried it as a bigint
  blank?: number;
}

/** @internal Derive and validate the image layout from the header. */
function imageLayout(header: FitsHeader, hduIndex: number): Layout {
  const fail = (msg: string): never => {
    throw new FitsStructureError(`HDU ${hduIndex}: ${msg}`, { hduIndex });
  };

  const bitpix = header.getNumber("BITPIX");
  if (bitpix === undefined || !VALID_BITPIX.has(bitpix)) {
    fail(`BITPIX ${String(bitpix)} is not 8, 16, 32, 64, -32 or -64`);
  }

  const naxis = header.getNumber("NAXIS");
  if (naxis === undefined || !Number.isInteger(naxis) || naxis < 0 || naxis > 999) {
    fail(`NAXIS ${String(naxis)} is not an integer in 0..999`);
  }

  const axes: number[] = [];
  let count = naxis === 0 ? 0 : 1;
  for (let a = 1; a <= naxis!; a++) {
    const n = header.getNumber(`NAXIS${a}`);
    if (n === undefined || !Number.isInteger(n) || n < 0) {
      fail(`NAXIS${a} ${String(n)} is not a non-negative integer`);
    }
    axes.push(n!);
    count *= n!;
  }

  const bscale = header.getNumber("BSCALE") ?? 1;
  const bzeroRaw = header.get("BZERO");
  const bzero = typeof bzeroRaw === "number" ? bzeroRaw : 0;
  const bzeroBig = typeof bzeroRaw === "bigint" ? bzeroRaw : undefined;
  const blank = bitpix! > 0 ? header.getNumber("BLANK") : undefined;

  return {
    bitpix: bitpix!,
    axes,
    count,
    bytes: count * (Math.abs(bitpix!) / 8),
    bscale,
    bzero,
    bzeroBig,
    blank,
  };
}

/** @internal Read `count` big-endian elements of `bitpix` from `raw`. */
function readNative(raw: Uint8Array, bitpix: number, count: number): ImageArray {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  switch (bitpix) {
    case 8:
      return raw.slice(0, count); // copy: never alias the reader's buffer
    case 16: {
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, false);
      return out;
    }
    case 32: {
      const out = new Int32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getInt32(i * 4, false);
      return out;
    }
    case 64: {
      const out = new BigInt64Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getBigInt64(i * 8, false);
      return out;
    }
    case -32: {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, false);
      return out;
    }
    default: {
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat64(i * 8, false);
      return out;
    }
  }
}

/**
 * @internal The unsigned-integer convention (`BSCALE=1`, `BZERO=2^(n-1)`):
 * returns the matching unsigned array, or `undefined` if it does not apply.
 */
function unsignedView(native: ImageArray, bitpix: number, layout: Layout): ImageArray | undefined {
  if (layout.bscale !== 1) return undefined;

  if (bitpix === 8 && layout.bzero === -(2 ** 7)) {
    const u = native as Uint8Array;
    const out = new Int8Array(u.length);
    for (let i = 0; i < u.length; i++) out[i] = u[i] - 2 ** 7;
    return out;
  }
  if (bitpix === 16 && layout.bzero === 2 ** 15) {
    const s = native as Int16Array;
    const out = new Uint16Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] + 2 ** 15;
    return out;
  }
  if (bitpix === 32 && layout.bzero === 2 ** 31) {
    const s = native as Int32Array;
    const out = new Uint32Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] + 2 ** 31;
    return out;
  }
  if (bitpix === 64 && layout.bzeroBig === 1n << 63n) {
    const s = native as BigInt64Array;
    const out = new BigUint64Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = BigInt.asUintN(64, s[i] + (1n << 63n));
    return out;
  }

  return undefined;
}

/** @internal Apply the astropy scaling policy to a freshly read array. */
function scale(native: ImageArray, layout: Layout): ImageArray {
  const { bitpix, bscale, bzero, blank } = layout;

  const unsigned = unsignedView(native, bitpix, layout);
  if (unsigned) return unsigned;

  if (bscale === 1 && bzero === 0 && layout.bzeroBig === undefined) {
    return native; // nothing to apply; expose `blank` for the caller
  }

  const out = new Float64Array(native.length);
  for (let i = 0; i < native.length; i++) {
    const v = typeof native[i] === "bigint" ? Number(native[i]) : (native[i] as number);
    out[i] = blank !== undefined && v === blank ? NaN : bzero + bscale * v;
  }

  return out;
}

/**
 * Read and decode the image in an `IMAGE` extension or the primary HDU.
 *
 * The pixels are fetched through `reader` (so a multi-gigabyte file is not
 * materialized just to open it) and decoded from FITS big-endian into the
 * typed array for `BITPIX`. `BZERO`/`BSCALE` are applied by default; pass
 * `{ raw: true }` for the unscaled on-disk array. See {@link FitsImage} for
 * the scaling rules and array layout.
 *
 * @throws {@link FitsStructureError} if the HDU is not an image, the
 * structural keywords are invalid, or the data unit is truncated.
 *
 * @example
 * ```ts
 * const { hdus } = readHdus(await reader.read(0, 2880 * 4));
 * const img = await readImage(hdus[0], reader);
 * console.log(img.shape, img.data.length);
 * ```
 */
export async function readImage(
  hdu: Hdu,
  reader: RandomAccessReader,
  opts: ReadImageOptions = {},
): Promise<FitsImage> {
  if (hdu.type !== "primary" && hdu.type !== "image") {
    throw new FitsStructureError(`HDU ${hdu.index} is not an image (type ${hdu.type})`, {
      hduIndex: hdu.index,
    });
  }

  const layout = imageLayout(hdu.header, hdu.index);
  const meta = {
    bitpix: layout.bitpix,
    bscale: layout.bscale,
    bzero: layout.bzeroBig !== undefined ? Number(layout.bzeroBig) : layout.bzero,
    blank: layout.blank,
  };

  if (layout.count === 0) {
    return { shape: [], data: readNative(new Uint8Array(0), layout.bitpix, 0), ...meta };
  }

  if (!hdu.dataSizeKnown || hdu.dataByteLength < layout.bytes) {
    throw new FitsStructureError(`HDU ${hdu.index} image data is truncated`, {
      hduIndex: hdu.index,
    });
  }

  const raw = await reader.read(hdu.dataOffset, layout.bytes);
  if (raw.length < layout.bytes) {
    throw new FitsStructureError(`HDU ${hdu.index} image data is truncated`, {
      hduIndex: hdu.index,
    });
  }

  const native = readNative(raw, layout.bitpix, layout.count);
  return {
    shape: layout.axes.slice(),
    data: opts.raw === true ? native : scale(native, layout),
    ...meta,
  };
}
