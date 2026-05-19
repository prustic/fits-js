import { FitsStructureError, FitsUnsupportedError } from "../errors.js";
import type { FitsHeader } from "../header/header.js";
import { parseHeader, type ParseHeaderOptions } from "../header/parse-header.js";
import type { RandomAccessReader } from "../io/reader.js";
import type { Hdu, HduType } from "./hdu.js";

const BLOCK = 2880;
const VALID_BITPIX = new Set([8, 16, 32, 64, -32, -64]);

/** Result of {@link readHdus}. */
export interface ReadHdusResult {
  readonly hdus: readonly Hdu[];
  readonly warnings: readonly string[];
}

// A3DTABLE is the precursor name from the original binary-table convention.
const XTENSION_TYPES = new Map<string, HduType>([
  ["IMAGE", "image"],
  ["BINTABLE", "bintable"],
  ["A3DTABLE", "bintable"],
  ["TABLE", "table"],
]);

interface SizeContext {
  readonly strict: boolean;
  readonly hduIndex: number;
  readonly warn: (message: string) => void;
}

const isNonNegInt = (n: number) => Number.isInteger(n) && n >= 0;

/**
 * Data unit length in bytes (unpadded) per FITS Standard §4.4.1, or
 * `undefined` when a structural keyword is missing or out of its valid
 * domain, in which case the layout of this and every following HDU is
 * unknowable and enumeration must stop rather than desync.
 */
function dataBytes(header: FitsHeader, ctx: SizeContext): number | undefined {
  const reject = (detail: string): undefined => {
    const msg = `HDU ${ctx.hduIndex} cannot be sized: ${detail}`;
    if (ctx.strict) throw new FitsStructureError(msg, { hduIndex: ctx.hduIndex });
    ctx.warn(msg);
    return undefined;
  };
  const softReject = (detail: string): void => {
    const msg = `HDU ${ctx.hduIndex}: ${detail}`;
    if (ctx.strict) throw new FitsStructureError(msg, { hduIndex: ctx.hduIndex });
    ctx.warn(msg);
  };

  const bitpix = header.getNumber("BITPIX");
  if (bitpix === undefined) return reject("BITPIX missing or unreadable");
  if (!VALID_BITPIX.has(bitpix)) {
    return reject(`BITPIX ${bitpix} is not 8, 16, 32, 64, -32 or -64`);
  }

  const naxis = header.getNumber("NAXIS");
  if (naxis === undefined) return reject("NAXIS missing or unreadable");
  if (!isNonNegInt(naxis) || naxis > 999) {
    return reject(`NAXIS ${naxis} is not an integer in 0..999`);
  }
  if (naxis === 0) return 0;

  let nelem = 1;
  for (let a = 1; a <= naxis; a++) {
    const na = header.getNumber(`NAXIS${a}`);
    if (na === undefined) return reject(`NAXIS${a} missing or unreadable`);
    if (!isNonNegInt(na)) return reject(`NAXIS${a} ${na} is not a non-negative integer`);
    nelem *= na;
    if (!Number.isSafeInteger(nelem)) return reject("data dimensions overflow");
  }

  const isExtension = ctx.hduIndex > 0;
  let pcount = header.getNumber("PCOUNT");
  if (pcount === undefined) {
    if (isExtension) softReject("PCOUNT missing in extension (defaulting to 0)");
    pcount = 0;
  } else if (!isNonNegInt(pcount)) {
    return reject(`PCOUNT ${pcount} is not a non-negative integer`);
  }

  let gcount = header.getNumber("GCOUNT");
  if (gcount === undefined) {
    if (isExtension) softReject("GCOUNT missing in extension (defaulting to 1)");
    gcount = 1;
  } else if (!Number.isInteger(gcount) || gcount < 1) {
    return reject(`GCOUNT ${gcount} is not a positive integer`);
  }

  const size = (Math.abs(bitpix) / 8) * gcount * (pcount + nelem);
  if (!Number.isSafeInteger(size)) {
    return reject("declared data size overflows");
  }
  return size;
}

function classify(header: FitsHeader, index: number): HduType {
  if (index === 0) return "primary";
  return XTENSION_TYPES.get(header.getString("XTENSION") ?? "") ?? "unknown";
}

// A conforming header block always holds SIMPLE/XTENSION + END, never all
// zeros; an all-zero block is therefore trailing fill, so stop. (astropy
// instead probes for a valid next header.)
function isAllZero(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * Walk every Header-Data Unit in a FITS source. Headers are parsed; data
 * units are located and measured but not decoded, so the whole structure of
 * a multi-gigabyte file is enumerable from a buffer cheaply.
 *
 * The deprecated random-groups format is rejected with
 * {@link FitsUnsupportedError}. A conforming extension of an unrecognized
 * type is returned with `type: "unknown"` and its bytes skipped so later
 * HDUs stay reachable. If a structural keyword needed to size a data unit
 * is missing or out of domain, enumeration stops there (lenient, with the
 * HDU's `dataSizeKnown` set to `false`) or throws {@link FitsStructureError}
 * (strict) rather than desync every later offset.
 *
 * @example
 * ```ts
 * import { readHdus, findHdu } from "@fits-js/core";
 *
 * const { hdus } = readHdus(bytes);
 * const sci = findHdu(hdus, "SCI", 1);
 * ```
 *
 * @see [FITS Standard v4.0 §3.3-3.4: primary HDU and extensions](https://fits.gsfc.nasa.gov/fits_standard.html) (random groups: §6)
 */
export function readHdus(bytes: Uint8Array, options: ParseHeaderOptions = {}): ReadHdusResult {
  if (!(bytes instanceof Uint8Array)) {
    throw new FitsStructureError("readHdus requires a Uint8Array");
  }
  const strict = options.strict ?? false;
  const warnings: string[] = [];
  const hdus: Hdu[] = [];

  let offset = 0;
  let index = 0;
  while (offset + BLOCK <= bytes.length) {
    if (isAllZero(bytes.subarray(offset, offset + BLOCK))) break;

    const sub = bytes.subarray(offset);
    const parsed = parseHeader(sub, options);
    warnings.push(...parsed.warnings);
    const header = parsed.header;

    if (index === 0 && !header.has("SIMPLE")) {
      const msg = "primary header has no SIMPLE keyword";
      if (strict) throw new FitsStructureError(msg, { hduIndex: 0 });
      warnings.push(msg);
    }

    if (
      index === 0 &&
      (header.getNumber("NAXIS") ?? 0) >= 1 &&
      header.getNumber("NAXIS1") === 0 &&
      header.getBoolean("GROUPS") === true
    ) {
      throw new FitsUnsupportedError("random-groups format is not supported", { hduIndex: 0 });
    }

    if (index > 0 && !header.has("XTENSION")) {
      const msg = `extension HDU ${index} has no XTENSION keyword`;
      if (strict) throw new FitsStructureError(msg, { hduIndex: index });
      warnings.push(msg);
    }

    const type = classify(header, index);
    const dataOffset = offset + parsed.byteLength;
    const name = header.getString("EXTNAME");
    const version = header.getNumber("EXTVER");

    if (dataOffset > bytes.length) {
      // The header itself ran past the buffer (no END, partial download):
      // it was never fully parsed, so do not report a sized HDU.
      const msg = `HDU ${index} header is truncated (runs past end of input)`;
      if (strict) throw new FitsStructureError(msg, { hduIndex: index });
      warnings.push(msg);
      hdus.push({
        index,
        type,
        header,
        name,
        version,
        dataOffset: bytes.length,
        dataByteLength: 0,
        dataSizeKnown: false,
      });
      break;
    }

    const size = dataBytes(header, {
      strict,
      hduIndex: index,
      warn: (m) => warnings.push(m),
    });

    if (size === undefined) {
      // Layout unknowable: record this HDU, do not guess past it.
      hdus.push({
        index,
        type,
        header,
        name,
        version,
        dataOffset,
        dataByteLength: 0,
        dataSizeKnown: false,
      });
      warnings.push(`HDU enumeration stopped at HDU ${index}`);
      break;
    }

    const padded = Math.ceil(size / BLOCK) * BLOCK;
    let dataByteLength = padded;
    let dataSizeKnown = true;
    if (dataOffset + padded > bytes.length) {
      const msg = `HDU ${index} data unit is truncated`;
      if (strict) throw new FitsStructureError(msg, { hduIndex: index });
      warnings.push(msg);
      dataByteLength = Math.max(0, bytes.length - dataOffset);
      dataSizeKnown = false;
    }

    hdus.push({
      index,
      type,
      header,
      name,
      version,
      dataOffset,
      dataByteLength,
      dataSizeKnown,
    });

    const next = dataOffset + dataByteLength;
    if (next <= offset) break; // no forward progress: stop rather than loop
    offset = next;
    index++;
  }

  return { hdus, warnings };
}

/** @internal A conforming header ends with an `END` card (`END` + spaces). */
function endInBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i += 80) {
    if (block[i] === 69 && block[i + 1] === 78 && block[i + 2] === 68 && block[i + 3] === 32) {
      return true;
    }
  }
  return false;
}

function concatBlocks(blocks: Uint8Array[]): Uint8Array {
  if (blocks.length === 1) return blocks[0];
  const out = new Uint8Array(blocks.length * BLOCK);
  blocks.forEach((b, i) => out.set(b, i * BLOCK));
  return out;
}

/**
 * Walk every Header-Data Unit through a {@link RandomAccessReader}, reading
 * only header blocks: each data unit is located and measured from its
 * keywords and then seeked past, never fetched. This is the lazy entry
 * point, a multi-gigabyte remote file is enumerated from a few kilobytes,
 * and the resulting {@link Hdu}s carry `dataSizeKnown: true` (derived from
 * `reader.size`) so {@link readImage} can take a rectangular cutout without
 * materializing the file.
 *
 * Sizing, classification, random-groups rejection, and the strict/lenient
 * contract are identical to {@link readHdus}; this differs only in the byte
 * source. When `reader.size` is `undefined` (a source of unknown length) the
 * header-declared data length is trusted and a short read is caught later by
 * the consumer rather than here.
 *
 * @example
 * ```ts
 * const reader = new HttpRangeReader(url);
 * const { hdus } = await openFits(reader);
 * const tile = await readImage(hdus[0], reader, {
 *   region: { start: [4096, 4096], shape: [256, 256] },
 * });
 * ```
 */
export async function openFits(
  reader: RandomAccessReader,
  options: ParseHeaderOptions = {},
): Promise<ReadHdusResult> {
  const strict = options.strict ?? false;
  const warnings: string[] = [];
  const hdus: Hdu[] = [];
  const total = reader.size;

  const readBlock = async (at: number): Promise<Uint8Array | null> => {
    const b = await reader.read(at, BLOCK);
    return b.length === BLOCK ? b : null; // a short read is EOF
  };

  let offset = 0;
  let index = 0;
  for (;;) {
    const first = await readBlock(offset);
    if (first === null || isAllZero(first)) break;

    const blocks = [first];
    let hasEnd = endInBlock(first);
    while (!hasEnd) {
      const nb = await readBlock(offset + blocks.length * BLOCK);
      if (nb === null) break; // header ran past EOF
      blocks.push(nb);
      hasEnd = endInBlock(nb);
    }

    const parsed = parseHeader(concatBlocks(blocks), options);
    warnings.push(...parsed.warnings);
    const header = parsed.header;

    if (index === 0 && !header.has("SIMPLE")) {
      const msg = "primary header has no SIMPLE keyword";
      if (strict) throw new FitsStructureError(msg, { hduIndex: 0 });
      warnings.push(msg);
    }

    if (
      index === 0 &&
      (header.getNumber("NAXIS") ?? 0) >= 1 &&
      header.getNumber("NAXIS1") === 0 &&
      header.getBoolean("GROUPS") === true
    ) {
      throw new FitsUnsupportedError("random-groups format is not supported", { hduIndex: 0 });
    }

    if (index > 0 && !header.has("XTENSION")) {
      const msg = `extension HDU ${index} has no XTENSION keyword`;
      if (strict) throw new FitsStructureError(msg, { hduIndex: index });
      warnings.push(msg);
    }

    const type = classify(header, index);
    const dataOffset = offset + parsed.byteLength;
    const name = header.getString("EXTNAME");
    const version = header.getNumber("EXTVER");

    if (!hasEnd) {
      const msg = `HDU ${index} header is truncated (runs past end of input)`;
      if (strict) throw new FitsStructureError(msg, { hduIndex: index });
      warnings.push(msg);
      hdus.push({
        index,
        type,
        header,
        name,
        version,
        dataOffset: total !== undefined ? Math.min(dataOffset, total) : dataOffset,
        dataByteLength: 0,
        dataSizeKnown: false,
      });
      break;
    }

    const size = dataBytes(header, { strict, hduIndex: index, warn: (m) => warnings.push(m) });
    if (size === undefined) {
      hdus.push({
        index,
        type,
        header,
        name,
        version,
        dataOffset,
        dataByteLength: 0,
        dataSizeKnown: false,
      });
      warnings.push(`HDU enumeration stopped at HDU ${index}`);
      break;
    }

    const padded = Math.ceil(size / BLOCK) * BLOCK;
    let dataByteLength = padded;
    let dataSizeKnown = true;
    if (total !== undefined && dataOffset + padded > total) {
      const msg = `HDU ${index} data unit is truncated`;
      if (strict) throw new FitsStructureError(msg, { hduIndex: index });
      warnings.push(msg);
      dataByteLength = Math.max(0, total - dataOffset);
      dataSizeKnown = false;
    }

    hdus.push({ index, type, header, name, version, dataOffset, dataByteLength, dataSizeKnown });

    const next = dataOffset + dataByteLength;
    if (next <= offset) break;
    offset = next;
    index++;
  }

  return { hdus, warnings };
}
