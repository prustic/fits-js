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
 * A rectangular sub-region to read, in FITS axis order (`NAXIS1` first).
 * `start` is the zero-based origin and `shape` the extent on each axis;
 * both must have one entry per axis. Only the bytes the region spans are
 * fetched, so a small cutout of a multi-gigabyte cube stays cheap.
 */
export interface ImageRegion {
  readonly start: readonly number[];
  readonly shape: readonly number[];
}

/**
 * A decoded image array plus the metadata needed to interpret it.
 *
 * `shape` is in FITS axis order (`NAXIS1` first, and `NAXIS1` is the
 * fastest-varying axis on disk), and is the region's shape when a cutout
 * was requested. `data` is row-major in that order, so the element at FITS
 * index `(i1, i2, …)` is at `i1 + s1 * (i2 + s2 * (…))`.
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
  /** A rectangular cutout; the whole image is read when omitted. */
  region?: ImageRegion;
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

  return { bitpix: bitpix!, axes, count, bscale, bzero, bzeroBig, blank };
}

/** @internal An empty native typed array of `len` elements for `bitpix`. */
function makeNative(bitpix: number, len: number): ImageArray {
  switch (bitpix) {
    case 8:
      return new Uint8Array(len);
    case 16:
      return new Int16Array(len);
    case 32:
      return new Int32Array(len);
    case 64:
      return new BigInt64Array(len);
    case -32:
      return new Float32Array(len);
    default:
      return new Float64Array(len);
  }
}

/** @internal Decode `count` big-endian elements of `runBytes` into `out` at `outOff`. */
function decodeInto(
  runBytes: Uint8Array,
  count: number,
  bitpix: number,
  out: ImageArray,
  outOff: number,
): void {
  if (bitpix === 8) {
    // Copy into the freshly allocated output; never alias the reader buffer.
    (out as Uint8Array).set(runBytes.subarray(0, count), outOff);
    return;
  }

  const view = new DataView(runBytes.buffer, runBytes.byteOffset, runBytes.byteLength);
  switch (bitpix) {
    case 16: {
      const o = out as Int16Array;
      for (let i = 0; i < count; i++) o[outOff + i] = view.getInt16(i * 2, false);
      break;
    }
    case 32: {
      const o = out as Int32Array;
      for (let i = 0; i < count; i++) o[outOff + i] = view.getInt32(i * 4, false);
      break;
    }
    case 64: {
      const o = out as BigInt64Array;
      for (let i = 0; i < count; i++) o[outOff + i] = view.getBigInt64(i * 8, false);
      break;
    }
    case -32: {
      const o = out as Float32Array;
      for (let i = 0; i < count; i++) o[outOff + i] = view.getFloat32(i * 4, false);
      break;
    }
    default: {
      const o = out as Float64Array;
      for (let i = 0; i < count; i++) o[outOff + i] = view.getFloat64(i * 8, false);
      break;
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

/** @internal Validate a region against the axes, or throw. */
function checkRegion(region: ImageRegion, axes: number[], hduIndex: number): void {
  const fail = (msg: string): never => {
    throw new FitsStructureError(`HDU ${hduIndex}: region ${msg}`, { hduIndex });
  };

  if (axes.length === 0) fail("given for a header-only HDU");
  if (region.start.length !== axes.length || region.shape.length !== axes.length) {
    fail(`rank ${region.start.length}/${region.shape.length} does not match NAXIS ${axes.length}`);
  }

  for (let k = 0; k < axes.length; k++) {
    const s = region.start[k];
    const n = region.shape[k];
    if (!Number.isInteger(s) || s < 0 || !Number.isInteger(n) || n < 1 || s + n > axes[k]) {
      fail(`[${s}, ${s + n}) on axis ${k + 1} is out of 0..${axes[k]}`);
    }
  }
}

/**
 * Read and decode the image in an `IMAGE` extension or the primary HDU,
 * optionally just a rectangular cutout.
 *
 * Pixels are fetched through `reader`, so a multi-gigabyte file is never
 * materialized just to open it, and a `region` reads only the bytes that
 * region spans (one contiguous run per fastest-axis line; a backing
 * `HttpRangeReader` coalesces adjacent runs). Bytes are decoded from FITS
 * big-endian into the typed array for `BITPIX`; `BZERO`/`BSCALE` are
 * applied by default. See {@link FitsImage} for scaling and layout.
 *
 * @throws {@link FitsStructureError} if the HDU is not an image, the
 * structural keywords or `region` are invalid, or the data unit is
 * truncated (fewer bytes available than the header declares).
 *
 * @example
 * ```ts
 * const { hdus } = readHdus(await reader.read(0, 2880 * 4));
 * const full = await readImage(hdus[0], reader);
 * const tile = await readImage(hdus[0], reader, {
 *   region: { start: [1024, 1024], shape: [256, 256] },
 * });
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

  if (opts.region) checkRegion(opts.region, layout.axes, hdu.index);

  if (layout.count === 0) {
    return { shape: [], data: makeNative(layout.bitpix, 0), ...meta };
  }

  const { axes } = layout;
  const start = opts.region ? opts.region.start : axes.map(() => 0);
  const shape = opts.region ? opts.region.shape.slice() : axes.slice();
  const bpe = Math.abs(layout.bitpix) / 8;

  // Source element strides, NAXIS1 fastest: stride[k] = product(axes[0..k-1]).
  const stride: number[] = [1];
  for (let k = 1; k < axes.length; k++) stride[k] = stride[k - 1] * axes[k - 1];

  // One contiguous on-disk run spans the inner axes that are fully covered:
  // axes 0..m-1 form a single run; only the outer axes m..n-1 are iterated.
  let m = 1;
  while (m < axes.length && start[m - 1] === 0 && shape[m - 1] === axes[m - 1]) m++;

  let runElems = 1;
  for (let k = 0; k < m; k++) runElems *= shape[k];
  let outerCount = 1;
  for (let k = m; k < axes.length; k++) outerCount *= shape[k];

  // Element offset of the run's origin from the inner (0..m-1) coordinates.
  let innerBase = 0;
  for (let k = 0; k < m; k++) innerBase += start[k] * stride[k];

  const native = makeNative(layout.bitpix, runElems * outerCount);

  for (let t = 0; t < outerCount; t++) {
    let src = innerBase;
    let rem = t;
    for (let k = m; k < axes.length; k++) {
      const l = rem % shape[k];
      rem = Math.floor(rem / shape[k]);
      src += (start[k] + l) * stride[k];
    }

    const want = runElems * bpe;
    const bytes = await reader.read(hdu.dataOffset + src * bpe, want);
    if (bytes.length < want) {
      throw new FitsStructureError(`HDU ${hdu.index} image data is truncated`, {
        hduIndex: hdu.index,
      });
    }

    decodeInto(bytes, runElems, layout.bitpix, native, t * runElems);
  }

  return {
    shape,
    data: opts.raw === true ? native : scale(native, layout),
    ...meta,
  };
}
