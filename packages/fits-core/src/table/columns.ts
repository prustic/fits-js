import { FitsStructureError } from "../errors.js";
import type { FitsHeader } from "../header/header.js";

/**
 * A `BINTABLE` `TFORMn` data type code
 * ([FITS Standard v4.0 §7.3.1](https://fits.gsfc.nasa.gov/fits_standard.html)).
 *
 * `L` logical, `X` bit, `B` unsigned byte, `I` int16, `J` int32, `K` int64,
 * `A` character, `E` float32, `D` float64, `C` complex64, `M` complex128,
 * and the variable-length array descriptors `P` (32-bit) and `Q` (64-bit).
 */
export type ColumnTypeCode =
  | "L"
  | "X"
  | "B"
  | "I"
  | "J"
  | "K"
  | "A"
  | "E"
  | "D"
  | "C"
  | "M"
  | "P"
  | "Q";

/**
 * An ASCII table `TFORMn` data type code
 * ([FITS Standard v4.0 §7.2.5](https://fits.gsfc.nasa.gov/fits_standard.html)).
 *
 * `A` character, `I` decimal integer, `F` fixed-point, `E` and `D`
 * exponential. The standard defines no difference between `F`, `E` and `D`:
 * the field text alone determines the value, so all three decode to
 * `Float64Array`.
 */
export type AsciiTypeCode = "A" | "I" | "F" | "E" | "D";

/**
 * A parsed `BINTABLE` `TFORMn`: `rT` for a fixed-width column, `rPt(emax)`
 * or `rQt(emax)` for a variable-length array column.
 */
export interface BinaryTform {
  readonly kind: "binary";
  readonly code: ColumnTypeCode;
  /** Repeat count `r`; 1 when absent. 0 or 1 for `P`/`Q`. */
  readonly repeat: number;
  /** Element type `t` of a `P`/`Q` descriptor; absent otherwise. */
  readonly elementCode?: Exclude<ColumnTypeCode, "P" | "Q">;
  /** The optional `(emax)` of a `P`/`Q` descriptor. */
  readonly maxCount?: number;
  /** `TFORMn` exactly as written, including any trailing characters. */
  readonly raw: string;
}

/** A parsed ASCII table `TFORMn`: `Aw`, `Iw`, `Fw.d`, `Ew.d` or `Dw.d`. */
export interface AsciiTform {
  readonly kind: "ascii";
  readonly code: AsciiTypeCode;
  /** Field width `w` in characters; always equals {@link TableColumn.byteWidth}. */
  readonly width: number;
  /**
   * Digits `d` to the right of the decimal point, for `F`, `E` and `D`.
   * Used only when the field text carries no explicit point, in which case
   * the point sits before the rightmost `d` digits. That convention is
   * deprecated by the standard but still legal. Absent for `A` and `I`.
   */
  readonly decimals?: number;
  /** `TFORMn` exactly as written, including any trailing characters. */
  readonly raw: string;
}

/**
 * A parsed `TFORMn`, discriminated by the kind of table it came from. The
 * code letters overlap but do not mean the same thing: a `BINTABLE` `E` is
 * float32 on disk, while an ASCII `E` is text of arbitrary precision.
 */
export type ParsedTform = BinaryTform | AsciiTform;

/**
 * One column of a `BINTABLE`, assembled from its indexed header keywords.
 * Produced by {@link readTable} in the order the columns appear on disk.
 */
export interface TableColumn {
  /** Zero-based column position; the keyword index is `index + 1`. */
  readonly index: number;
  /** `TTYPEn`, when present. */
  readonly name?: string;
  readonly tform: ParsedTform;
  /** `TUNITn`, when present. */
  readonly unit?: string;
  /** `TSCALn`; 1 when absent. */
  readonly tscal: number;
  /**
   * `TZEROn`; 0 when absent. A bigint `TZERO` is reported as the nearest
   * `number` here; the canonical `2^63` uint64 offset is exact.
   */
  readonly tzero: number;
  /** `TZEROn` when the header carried it as a bigint. */
  readonly tzeroBig?: bigint;
  /** `TNULLn` (integer columns only), when the header declares it. */
  readonly tnull?: number;
  /** `TNULLn` when it exceeds safe-integer range (`K` columns). */
  readonly tnullBig?: bigint;
  /**
   * `TNULLn` of an ASCII table column: the character string that marks an
   * undefined field (§7.2.2). Unlike the `BINTABLE` integer sentinel it
   * applies to every field type, `A` included. Compared against the field
   * text with both sides blank-trimmed, so a sentinel matches whichever way
   * its writer justified it, and an all-blank `TNULLn` marks blank fields
   * undefined.
   */
  readonly tnullText?: string;
  /**
   * Parsed `TDIMn` axes in FITS order (`d1` fastest-varying), when declared
   * and consistent. Metadata only: {@link TableColumnData.values} stays a
   * flat array regardless.
   */
  readonly tdim?: readonly number[];
  /** `TDISPn`, when present. Metadata only; fits-js does not format values. */
  readonly tdisp?: string;
  /** Bytes this field occupies within one row. */
  readonly byteWidth: number;
  /** Byte offset of this field from the start of its row. */
  readonly byteOffset: number;
}

/** @internal A column of a `BINTABLE`, with its `TFORMn` arm narrowed. */
export interface BinaryTableColumn extends TableColumn {
  readonly tform: BinaryTform;
}

/** @internal Bytes per single element, keyed by fixed-width type code. */
const ELEMENT_BYTES: Record<Exclude<ColumnTypeCode, "P" | "Q">, number> = {
  L: 1,
  X: 1, // per bit; width is ceil(repeat / 8)
  B: 1,
  I: 2,
  J: 4,
  K: 8,
  A: 1,
  E: 4,
  D: 8,
  C: 8,
  M: 16,
};

/** @internal Codes whose stored values are integers, so TNULL applies. */
const INTEGER_CODES = new Set<ColumnTypeCode>(["B", "I", "J", "K"]);

const MAX_COUNT_DIGITS = 15; // stays within Number.MAX_SAFE_INTEGER

/** @internal Scan a decimal run at `i`; undefined when absent or too long. */
function scanDigits(s: string, i: number): { value: number; next: number } | undefined {
  let end = i;
  while (end < s.length && s.charCodeAt(end) >= 0x30 && s.charCodeAt(end) <= 0x39) {
    end++;
  }

  if (end === i || end - i > MAX_COUNT_DIGITS) return undefined;

  return { value: Number(s.slice(i, end)), next: end };
}

/**
 * @internal Parse a `TFORMn` value by bounded scanning. Characters after the
 * recognized portion are legal per the standard and stay only in `raw`.
 * Returns `undefined` on malformed input; the caller owns the error message.
 */
export function parseTform(raw: string): BinaryTform | undefined {
  let i = 0;
  while (i < raw.length && raw[i] === " ") {
    i++;
  }

  let repeat = 1;
  const digits = scanDigits(raw, i);
  if (digits) {
    repeat = digits.value;
    i = digits.next;
  }

  const code = raw[i];
  if (code === undefined) return undefined;
  i++;

  if (code === "P" || code === "Q") {
    // A descriptor holds (count, offset): two int32 for P, two int64 for Q.
    if (repeat > 1) return undefined;

    const element = raw[i];
    if (element === undefined || element === "P" || element === "Q") return undefined;
    if (!(element in ELEMENT_BYTES)) return undefined;
    i++;

    let maxCount: number | undefined;
    if (raw[i] === "(") {
      const max = scanDigits(raw, i + 1);
      if (max === undefined || raw[max.next] !== ")") return undefined;
      maxCount = max.value;
    }

    return {
      kind: "binary",
      code,
      repeat,
      elementCode: element as Exclude<ColumnTypeCode, "P" | "Q">,
      maxCount,
      raw,
    };
  }

  if (!(code in ELEMENT_BYTES)) return undefined;

  return { kind: "binary", code: code as ColumnTypeCode, repeat, raw };
}

/**
 * @internal Parse a `TDIMn` value, `'(d1,d2,...)'` with positive integers.
 * Returns `undefined` on bad syntax; the caller warns and ignores it.
 */
export function parseTdim(raw: string): number[] | undefined {
  let i = 0;
  while (i < raw.length && raw[i] === " ") {
    i++;
  }
  if (raw[i] !== "(") return undefined;
  i++;

  const axes: number[] = [];
  for (;;) {
    while (i < raw.length && raw[i] === " ") {
      i++;
    }

    const d = scanDigits(raw, i);
    if (d === undefined || d.value < 1) return undefined;
    axes.push(d.value);
    i = d.next;

    while (i < raw.length && raw[i] === " ") {
      i++;
    }
    if (raw[i] === ",") {
      i++;
      continue;
    }
    if (raw[i] === ")") {
      i++;
      break;
    }

    return undefined;
  }

  while (i < raw.length && raw[i] === " ") {
    i++;
  }
  if (i !== raw.length) return undefined;

  return axes;
}

/** @internal The field width in bytes of a parsed TFORM. */
function tformWidth(tform: BinaryTform): number {
  if (tform.code === "P") return 8 * tform.repeat;
  if (tform.code === "Q") return 16 * tform.repeat;
  if (tform.code === "X") return Math.ceil(tform.repeat / 8);

  return ELEMENT_BYTES[tform.code] * tform.repeat;
}

/**
 * @internal Heap bytes a variable-length array of `count` elements occupies.
 * An `X` descriptor counts bits, and a bit array is stored as whole bytes
 * with the trailing bits zeroed (FITS v4.0 §7.3.3).
 */
export function heapArrayBytes(
  elementCode: Exclude<ColumnTypeCode, "P" | "Q">,
  count: number,
): number {
  if (elementCode === "X") return Math.ceil(count / 8);

  return ELEMENT_BYTES[elementCode] * count;
}

/** @internal The result of assembling a BINTABLE's column keyword model. */
export interface TableColumnsResult {
  columns: BinaryTableColumn[];
  /** Sum of the column widths; the caller checks it against `NAXIS1`. */
  rowWidth: number;
  warnings: string[];
}

/**
 * @internal Read and validate `TFIELDS`. Shared by both table kinds; the
 * 0..999 limit is the same in §7.2.1 and §7.3.1.
 */
export function readTfields(header: FitsHeader, fail: (msg: string) => never): number {
  const tfields = header.getNumber("TFIELDS");
  if (tfields === undefined || !Number.isInteger(tfields) || tfields < 0 || tfields > 999) {
    fail(`TFIELDS ${String(tfields)} is not an integer in 0..999`);
  }

  return tfields;
}

/** @internal `TSCALn`/`TZEROn` as both table kinds resolve them. */
export interface ColumnScaling {
  tscal: number;
  tzero: number;
  tzeroBig?: bigint;
}

/**
 * @internal Read `TSCALn`/`TZEROn` for column `n`. `scalable` is false for
 * the types the standard forbids them on, which differ per table kind, so
 * the caller decides; the warning wording is shared.
 */
export function readScaling(
  header: FitsHeader,
  n: number,
  scalable: boolean,
  elementType: string,
  warn: (msg: string) => void,
): ColumnScaling {
  let tscal = 1;
  const tscalRaw = header.get(`TSCAL${n}`);
  if (typeof tscalRaw === "number" || typeof tscalRaw === "bigint") {
    if (scalable) {
      tscal = Number(tscalRaw);
      if (tscal === 0) {
        warn(`TSCAL${n} is 0; every scaled value collapses to TZERO`);
      }
    } else if (Number(tscalRaw) !== 1) {
      warn(`TSCAL${n} does not apply to a ${elementType} column; ignored`);
    }
  } else if (tscalRaw !== undefined) {
    warn(`TSCAL${n} ${JSON.stringify(tscalRaw)} is not a number; ignored`);
  }

  let tzero = 0;
  let tzeroBig: bigint | undefined;
  const tzeroRaw = header.get(`TZERO${n}`);
  if (typeof tzeroRaw === "number" || typeof tzeroRaw === "bigint") {
    if (scalable) {
      tzero = Number(tzeroRaw);
      if (typeof tzeroRaw === "bigint") tzeroBig = tzeroRaw;
    } else if (Number(tzeroRaw) !== 0) {
      warn(`TZERO${n} does not apply to a ${elementType} column; ignored`);
    }
  } else if (tzeroRaw !== undefined) {
    warn(`TZERO${n} ${JSON.stringify(tzeroRaw)} is not a number; ignored`);
  }

  return { tscal, tzero, tzeroBig };
}

/**
 * @internal Assemble the column model from a `BINTABLE` header's indexed
 * keywords. Malformed structural keywords throw; recoverable deviations are
 * ignored with a warning, keeping stored values untouched.
 */
export function readTableColumns(header: FitsHeader, hduIndex: number): TableColumnsResult {
  const fail = (msg: string): never => {
    throw new FitsStructureError(`HDU ${hduIndex}: ${msg}`, { hduIndex });
  };

  const tfields = readTfields(header, fail);

  const columns: BinaryTableColumn[] = [];
  const warnings: string[] = [];
  const seenNames = new Set<string>();
  let byteOffset = 0;

  for (let n = 1; n <= tfields; n++) {
    const name = header.getString(`TTYPE${n}`);
    const label = name === undefined ? `column ${n}` : `column ${n} (${name})`;
    const warn = (msg: string): void => {
      warnings.push(`${label}: ${msg}`);
    };

    const tformRaw = header.getString(`TFORM${n}`);
    if (tformRaw === undefined) {
      fail(`TFORM${n} is missing or not a string`);
    }
    const parsed = parseTform(tformRaw!);
    if (parsed === undefined) {
      fail(`TFORM${n} '${tformRaw}' is not a valid BINTABLE format`);
    }
    const tform = parsed!;

    if (name !== undefined) {
      const key = name.toUpperCase();
      if (seenNames.has(key)) {
        warn(`duplicate TTYPE '${name}'; selection by name resolves to the first`);
      }
      seenNames.add(key);
    }

    // P/Q are storage classes, so every per-type rule keys off the element.
    const elementType = tform.elementCode ?? tform.code;

    // TSCAL/TZERO must not be used with L, X, or A columns (§7.3.2).
    const scalable = elementType !== "L" && elementType !== "X" && elementType !== "A";
    const { tscal, tzero, tzeroBig } = readScaling(header, n, scalable, elementType, warn);

    // TNULL applies to integer stored values only (§7.3.2).
    let tnull: number | undefined;
    let tnullBig: bigint | undefined;
    const tnullRaw = header.get(`TNULL${n}`);
    if (tnullRaw !== undefined) {
      if (!INTEGER_CODES.has(elementType)) {
        warn(`TNULL${n} does not apply to a ${elementType} column; ignored`);
      } else if (typeof tnullRaw === "bigint") {
        tnullBig = tnullRaw;
        tnull = Number(tnullRaw);
      } else if (typeof tnullRaw === "number" && Number.isInteger(tnullRaw)) {
        tnull = tnullRaw;
      } else {
        warn(`TNULL${n} ${JSON.stringify(tnullRaw)} is not an integer; ignored`);
      }
    }

    let tdim: number[] | undefined;
    const tdimRaw = header.getString(`TDIM${n}`);
    if (tdimRaw !== undefined) {
      tdim = parseTdim(tdimRaw);
      if (tdim === undefined) {
        warn(`TDIM${n} '${tdimRaw}' is not a valid dimension list; ignored`);
      } else if (tform.code !== "P" && tform.code !== "Q") {
        const count = tdim.reduce((a, b) => a * b, 1);
        if (count !== tform.repeat) {
          warn(
            `TDIM${n} '${tdimRaw}' implies ${count} elements but the repeat is ${tform.repeat}; ignored`,
          );
          tdim = undefined;
        }
      }
    }

    const byteWidth = tformWidth(tform);
    columns.push({
      index: n - 1,
      name,
      tform,
      unit: header.getString(`TUNIT${n}`),
      tscal,
      tzero,
      tzeroBig,
      tnull,
      tnullBig,
      tdim,
      tdisp: header.getString(`TDISP${n}`),
      byteWidth,
      byteOffset,
    });
    byteOffset += byteWidth;
  }

  return { columns, rowWidth: byteOffset, warnings };
}
