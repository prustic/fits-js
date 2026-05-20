import { FitsIoError, FitsStructureError, FitsUnsupportedError } from "../errors.js";
import type { FitsHeader } from "../header/header.js";
import {
  parseHeader,
  type ParseHeaderOptions,
  type ParseHeaderResult,
} from "../header/parse-header.js";
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

interface HduStep {
  readonly hdu: Hdu;
  readonly nextOffset: number;
  readonly stop: boolean;
}

/**
 * @internal The per-HDU body shared by {@link readHdus} (over a buffer) and
 * {@link openFits} (over a reader): the structural checks, classification,
 * sizing, and the truncation / strict-lenient contract. The two callers
 * differ only in how header bytes are obtained; everything from the parsed
 * header to the pushed {@link Hdu} lives here so they cannot drift.
 *
 * `total` is the source length (a buffer's length, a reader's `size`, or
 * `undefined` when the source length is unknown). `headerComplete` is false
 * when the header ran past the bytes that were available.
 */
function buildHdu(
  parsed: ParseHeaderResult,
  offset: number,
  index: number,
  total: number | undefined,
  headerComplete: boolean,
  strict: boolean,
  warnings: string[],
): HduStep {
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
  const base = {
    index,
    type,
    header,
    name: header.getString("EXTNAME"),
    version: header.getNumber("EXTVER"),
  };

  if (!headerComplete) {
    const msg = `HDU ${index} header is truncated (runs past end of input)`;
    if (strict) throw new FitsStructureError(msg, { hduIndex: index });
    warnings.push(msg);
    return {
      hdu: {
        ...base,
        dataOffset: total !== undefined ? Math.min(dataOffset, total) : dataOffset,
        dataByteLength: 0,
        dataSizeKnown: false,
      },
      nextOffset: offset,
      stop: true,
    };
  }

  // No END card: the warning and the HDU flag must agree, sizing keywords
  // from a header that did not terminate are not trusted. readImage refuses
  // to read its declared data unit. (Strict already threw via parseHeader.)
  if (!parsed.endFound) {
    warnings.push(`HDU enumeration stopped at HDU ${index}`);
    return {
      hdu: { ...base, dataOffset, dataByteLength: 0, dataSizeKnown: false },
      nextOffset: offset,
      stop: true,
    };
  }

  const size = dataBytes(header, { strict, hduIndex: index, warn: (m) => warnings.push(m) });
  if (size === undefined) {
    warnings.push(`HDU enumeration stopped at HDU ${index}`);
    return {
      hdu: { ...base, dataOffset, dataByteLength: 0, dataSizeKnown: false },
      nextOffset: offset,
      stop: true,
    };
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

  const nextOffset = dataOffset + dataByteLength;
  return {
    hdu: { ...base, dataOffset, dataByteLength, dataSizeKnown },
    nextOffset,
    stop: nextOffset <= offset,
  };
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
    throw new FitsIoError("readHdus requires a Uint8Array");
  }
  const strict = options.strict ?? false;
  const warnings: string[] = [];
  const hdus: Hdu[] = [];

  let offset = 0;
  let index = 0;
  while (offset + BLOCK <= bytes.length) {
    if (isAllZero(bytes.subarray(offset, offset + BLOCK))) break;

    const parsed = parseHeader(bytes.subarray(offset), options);
    warnings.push(...parsed.warnings);
    const headerComplete = offset + parsed.byteLength <= bytes.length;

    const step = buildHdu(parsed, offset, index, bytes.length, headerComplete, strict, warnings);
    hdus.push(step.hdu);
    if (step.stop) break;
    offset = step.nextOffset;
    index++;
  }

  return { hdus, warnings };
}

function concatBlocks(blocks: Uint8Array[]): Uint8Array {
  if (blocks.length === 1) return blocks[0];
  const out = new Uint8Array(blocks.length * BLOCK);
  blocks.forEach((b, i) => out.set(b, i * BLOCK));
  return out;
}

/** Options for {@link openFits}. */
export interface OpenFitsOptions extends ParseHeaderOptions {
  /**
   * Cap on how many 2880-byte blocks a single header may span before
   * enumeration stops, used to bound the cost of a malformed source that
   * never emits `END`. Default 1000 (~36 000 cards), far beyond any
   * conforming header.
   */
  maxHeaderBlocks?: number;
  /**
   * Cancels the walk. Checked before each block read, so an abort takes
   * effect promptly and rejects with the signal's reason.
   */
  signal?: AbortSignal;
}

/**
 * Walk every Header-Data Unit through a {@link RandomAccessReader}, reading
 * only header blocks: each data unit is located and measured from its
 * keywords then seeked past, never fetched, so a remote file is enumerated
 * without materializing it and a later {@link readImage} cutout fetches only
 * its region.
 *
 * Sizing, classification, random-groups rejection, and the strict/lenient
 * contract are the *same code* as {@link readHdus} (the per-HDU body and the
 * `parseHeader` END detection are shared, not reimplemented), so for
 * well-formed FITS the enumerated HDUs are identical. On malformed or
 * truncated input both fail safe (`dataSizeKnown: false`, nothing unsafe
 * read), but the reported `dataOffset` and warnings can differ: with a
 * missing `END`, `openFits` caps the scan at `maxHeaderBlocks` blocks, while
 * the in-memory `readHdus` is bounded only by the buffer length. The sync
 * {@link readHdus} is unchanged for in-memory inputs.
 *
 * With `reader.size` known, `dataSizeKnown` reflects whether the declared
 * data unit fits within it. With `reader.size` `undefined` (a source of
 * unknown length) the header-declared length is trusted, `dataSizeKnown` is
 * `true` on that basis alone, and an actually short source is caught by
 * {@link readImage}'s own truncation check, not here.
 *
 * @example
 * ```ts
 * const reader = new HttpRangeReader(url);
 * const { hdus } = await openFits(reader);
 * const tile = await readImage(hdus[0], reader, {
 *   region: { start: [4096, 4096], shape: [256, 256] },
 * });
 * ```
 *
 * @see [FITS Standard v4.0 §3.3-3.4: primary HDU and extensions](https://fits.gsfc.nasa.gov/fits_standard.html) (random groups: §6)
 */
export async function openFits(
  reader: RandomAccessReader,
  options: OpenFitsOptions = {},
): Promise<ReadHdusResult> {
  if (reader == null || typeof reader.read !== "function") {
    throw new FitsIoError("openFits requires a RandomAccessReader");
  }
  const strict = options.strict ?? false;
  const warnings: string[] = [];
  const hdus: Hdu[] = [];
  const total = reader.size;

  const readBlock = async (at: number): Promise<Uint8Array | null> => {
    options.signal?.throwIfAborted();
    const b = await reader.read(at, BLOCK);
    // Short read is EOF; an over-delivering reader is trimmed, not treated as EOF.
    return b.length < BLOCK ? null : b.subarray(0, BLOCK);
  };

  let offset = 0;
  let index = 0;
  for (;;) {
    const first = await readBlock(offset);
    if (first === null || isAllZero(first)) break;

    // Grow lenient: parseHeader's strict mode throws on the partial first
    // block before the loop can fetch block two. Authoritative strict re-parse
    // runs below once the full header is in hand.
    const maxBlocks = options.maxHeaderBlocks ?? 1000;
    const lenient = { ...options, strict: false };

    const blocks = [first];
    let parsed = parseHeader(first, lenient);
    // O(N^2) in card count, bounded by maxBlocks. Raising the cap without an
    // incremental parseHeader lets a no-END source dominate.
    while (!parsed.endFound) {
      if (blocks.length >= maxBlocks) {
        const msg = `HDU ${index} header exceeds ${maxBlocks} blocks without END`;
        if (strict) throw new FitsStructureError(msg, { hduIndex: index });
        warnings.push(msg);
        break;
      }
      const nb = await readBlock(offset + blocks.length * BLOCK);
      if (nb === null) break;
      blocks.push(nb);
      parsed = parseHeader(concatBlocks(blocks), lenient);
    }

    // Strict needs a re-parse to surface throws the lenient loop suppressed.
    if (strict) {
      parsed = parseHeader(concatBlocks(blocks), options);
    }
    warnings.push(...parsed.warnings);

    // Positional, matching readHdus. Unknown size is trusted; readImage
    // backstops a short source.
    const headerComplete = total === undefined || offset + parsed.byteLength <= total;

    const step = buildHdu(parsed, offset, index, total, headerComplete, strict, warnings);
    hdus.push(step.hdu);
    if (step.stop) break;
    offset = step.nextOffset;
    index++;
  }

  return { hdus, warnings };
}
