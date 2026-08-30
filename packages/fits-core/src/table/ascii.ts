import { FitsStructureError } from "../errors.js";
import type { FitsHeader } from "../header/header.js";
import {
  readScaling,
  readTfields,
  type AsciiTform,
  type AsciiTypeCode,
  type TableColumn,
} from "./columns.js";
import { setMask, type BaseState, type TableColumnArray } from "./values.js";

/** @internal A column of an ASCII table, with its `TFORMn` arm narrowed. */
export interface AsciiTableColumn extends TableColumn {
  readonly tform: AsciiTform;
}

const ASCII_CODES = new Set<string>(["A", "I", "F", "E", "D"]);

/** @internal Codes whose `TFORMn` carries a `.d` fraction width. */
const REAL_CODES = new Set<string>(["F", "E", "D"]);

const MAX_WIDTH_DIGITS = 6; // a field cannot outgrow a 2880-block row anyway

/** @internal Scan a decimal run at `i`; undefined when absent or too long. */
function scanDigits(s: string, i: number): { value: number; next: number } | undefined {
  let end = i;
  while (end < s.length && s.charCodeAt(end) >= 0x30 && s.charCodeAt(end) <= 0x39) {
    end++;
  }

  if (end === i || end - i > MAX_WIDTH_DIGITS) return undefined;

  return { value: Number(s.slice(i, end)), next: end };
}

/**
 * @internal Parse an ASCII table `TFORMn` (7.2.5). Returns `undefined` on
 * malformed input; the caller owns the error message.
 */
export function parseAsciiTform(raw: string, warn: (msg: string) => void): AsciiTform | undefined {
  let i = 0;
  while (i < raw.length && raw[i] === " ") {
    i++;
  }

  const letter = raw[i];
  if (letter === undefined) return undefined;

  // No repeat count in this grammar, so a leading digit is ambiguous.
  if (letter >= "0" && letter <= "9") return undefined;

  const upper = letter.toUpperCase();
  if (!ASCII_CODES.has(upper)) return undefined;
  if (upper !== letter) {
    warn(`TFORM code '${letter}' is lower case; the standard requires upper case`);
  }
  i++;

  const width = scanDigits(raw, i);
  if (width === undefined || width.value < 1) return undefined;
  i = width.next;

  const code = upper as AsciiTypeCode;
  const real = REAL_CODES.has(code);

  let decimals: number | undefined;
  if (raw[i] === ".") {
    const frac = scanDigits(raw, i + 1);
    if (frac === undefined) return undefined;

    if (real) {
      decimals = frac.value;
    } else {
      warn(`TFORM '${raw.trim()}' gives a fraction width for a ${code} field; ignored`);
    }
  } else if (real) {
    warn(`TFORM '${raw.trim()}' has no fraction width; assuming .0`);
    decimals = 0;
  }

  return { kind: "ascii", code, width: width.value, decimals, raw };
}

const SPACE = 0x20;
const ZERO = 0x30;
const NINE = 0x39;

/** @internal Exact powers of ten, so the common case rounds only once. */
const POW10: number[] = [];
for (let i = 0; i <= 22; i++) POW10.push(Number(`1e${i}`));

const latin1 = new TextDecoder("latin1");

/** @internal Narrow `[at, at + width)` to its non-blank span. */
function trimField(bytes: Uint8Array, at: number, width: number): { from: number; to: number } {
  let from = at;
  let to = at + width;
  while (from < to && bytes[from] === SPACE) {
    from++;
  }
  while (to > from && bytes[to - 1] === SPACE) {
    to--;
  }

  return { from, to };
}

const isDigit = (b: number) => b >= ZERO && b <= NINE;

/** @internal `Iw` within int32. Blank is 0; `NaN` marks a malformed field. */
export function scanAsciiInt(bytes: Uint8Array, at: number, width: number): number {
  const { from, to } = trimField(bytes, at, width);
  if (from === to) return 0;

  let i = from;
  let negative = false;
  if (bytes[i] === 0x2b || bytes[i] === 0x2d) {
    negative = bytes[i] === 0x2d;
    i++;
  }

  let value = 0;
  let digits = 0;
  while (i < to && isDigit(bytes[i])) {
    value = value * 10 + (bytes[i] - ZERO);
    digits++;
    i++;
  }

  if (digits === 0 || i !== to) return Number.NaN;

  return negative ? -value : value;
}

/** @internal `Iw` past int32. Blank is 0; `undefined` marks a malformed field. */
export function scanAsciiBigInt(bytes: Uint8Array, at: number, width: number): bigint | undefined {
  const { from, to } = trimField(bytes, at, width);
  if (from === to) return 0n;

  let i = from;
  if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++;

  let digits = 0;
  while (i < to && isDigit(bytes[i])) {
    digits++;
    i++;
  }
  if (digits === 0 || i !== to) return undefined;

  // BigInt rejects a leading '+', so hand it the sign-stripped text.
  const text = latin1.decode(bytes.subarray(bytes[from] === 0x2b ? from + 1 : from, to));

  return BigInt(text);
}

/**
 * @internal `Fw.d`, `Ew.d` and `Dw.d` share one grammar (§7.2.5), including
 * the deprecated implicit decimal point taken from `decimals`. Blank is 0;
 * `NaN` marks a malformed field, which a conforming field cannot produce.
 */
export function scanAsciiFloat(
  bytes: Uint8Array,
  at: number,
  width: number,
  decimals: number,
): number {
  const { from, to } = trimField(bytes, at, width);
  if (from === to) return 0;

  let i = from;
  if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++;

  const mantissaFrom = i;
  let digits = 0;
  let fracDigits = -1;
  while (i < to) {
    const b = bytes[i];
    if (isDigit(b)) {
      digits++;
      if (fracDigits >= 0) fracDigits++;
      i++;
      continue;
    }
    if (b === 0x2e && fracDigits < 0) {
      fracDigits = 0;
      i++;
      continue;
    }

    break;
  }
  if (digits === 0) return Number.NaN;

  const mantissaTo = i;
  let exponent = fracDigits < 0 ? -decimals : -fracDigits;

  if (i < to) {
    const b = bytes[i];
    const letter = b === 0x45 || b === 0x65 || b === 0x44 || b === 0x64;
    if (letter) {
      i++;
    } else if (b !== 0x2b && b !== 0x2d) {
      return Number.NaN;
    }

    let expNegative = false;
    if (i < to && (bytes[i] === 0x2b || bytes[i] === 0x2d)) {
      expNegative = bytes[i] === 0x2d;
      i++;
    }

    let expValue = 0;
    let expDigits = 0;
    while (i < to && isDigit(bytes[i])) {
      expValue = expValue * 10 + (bytes[i] - ZERO);
      expDigits++;
      i++;
    }
    if (expDigits === 0 || i !== to) return Number.NaN;

    exponent += expNegative ? -expValue : expValue;
  }

  const negative = bytes[from] === 0x2d;

  // Exact while mantissa and power both stay exact in float64.
  if (digits <= 15 && Math.abs(exponent) <= 22) {
    let mantissa = 0;
    for (let k = mantissaFrom; k < mantissaTo; k++) {
      if (isDigit(bytes[k])) mantissa = mantissa * 10 + (bytes[k] - ZERO);
    }

    const scaled = exponent >= 0 ? mantissa * POW10[exponent] : mantissa / POW10[-exponent];

    return negative ? -scaled : scaled;
  }

  // Long or extreme: let the platform round the validated pieces.
  let text = "";
  for (let k = mantissaFrom; k < mantissaTo; k++) {
    if (isDigit(bytes[k])) text += String.fromCharCode(bytes[k]);
  }
  const value = Number(`${text}e${exponent}`);

  return negative ? -value : value;
}

/** @internal Blank-trimmed on both sides, so justification does not matter. */
export function matchesTnull(bytes: Uint8Array, at: number, width: number, tnull: string): boolean {
  const { from, to } = trimField(bytes, at, width);

  return latin1.decode(bytes.subarray(from, to)) === tnull.trim();
}

/** @internal Read one `Aw` field: trailing blanks go, leading blanks stay. */
export function readAsciiText(bytes: Uint8Array, at: number, width: number): string {
  let to = at + width;
  while (to > at && bytes[to - 1] === SPACE) {
    to--;
  }

  return latin1.decode(bytes.subarray(at, to));
}

/** @internal Decode state for one ASCII table column. */
export interface AsciiState extends BaseState {
  kind: "ascii";
  column: AsciiTableColumn;
  /** First row whose field violated its `TFORMn`, and its text. */
  badRow?: number;
  badText?: string;
  /** First byte an `A` field held outside the printable range (§7.2.5). */
  badCharByte?: number;
  /** First row whose integer did not fit int64, and its text. */
  overflowRow?: number;
  overflowText?: string;
}

/** @internal Allocate the decode state for an ASCII column over `rowCount` rows. */
export function makeAsciiState(column: AsciiTableColumn, rowCount: number): AsciiState {
  const { code, width } = column.tform;

  let values: TableColumnArray;
  if (code === "A") {
    values = new Array<string>(rowCount).fill("");
  } else if (code === "I") {
    values = width <= INT32_DIGITS ? new Int32Array(rowCount) : new BigInt64Array(rowCount);
  } else {
    values = new Float64Array(rowCount);
  }

  return { kind: "ascii", column, values, elemCount: values.length };
}

/** @internal Nine digits is the widest `Iw` that always fits int32. */
const INT32_DIGITS = 9;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * @internal Decode one column's fields from a slab of `slabRows` whole rows
 * into the state's output at row `outRow0`. Row-strided twin of
 * {@link decodeColumnSlab}; one element per row, so there is no inner loop.
 */
export function decodeAsciiSlab(
  state: AsciiState,
  bytes: Uint8Array,
  slabRows: number,
  rowStride: number,
  outRow0: number,
): void {
  const { column } = state;
  const { code, width, decimals } = column.tform;
  const off = column.byteOffset;
  const tnull = column.tnullText;

  for (let row = 0; row < slabRows; row++) {
    const at = row * rowStride + off;
    const out = outRow0 + row;

    // The sentinel is matched first, but the field is still parsed, so a
    // numeric TNULL stays readable in `values`.
    const isNull = tnull !== undefined && matchesTnull(bytes, at, width, tnull);
    if (isNull) setMask(state, out);

    if (code === "A") {
      (state.values as string[])[out] = readAsciiText(bytes, at, width);
      if (state.badCharByte === undefined) {
        for (let k = at; k < at + width; k++) {
          const b = bytes[k];
          if (b < 0x20 || b > 0x7e) {
            state.badCharByte = b;
            break;
          }
        }
      }
      continue;
    }

    if (code === "I" && width <= INT32_DIGITS) {
      const v = scanAsciiInt(bytes, at, width);
      if (Number.isNaN(v)) {
        flagBad(state, bytes, out, at, width, isNull);
        continue;
      }
      (state.values as Int32Array)[out] = v;
      continue;
    }

    if (code === "I") {
      const v = scanAsciiBigInt(bytes, at, width);
      if (v === undefined) {
        flagBad(state, bytes, out, at, width, isNull);
        continue;
      }
      // The standard caps neither digits nor range, so a wide field can
      // hold a value int64 cannot; wrapping it silently is not an option.
      if (v < INT64_MIN || v > INT64_MAX) {
        setMask(state, out);
        if (state.overflowRow === undefined) {
          state.overflowRow = out;
          state.overflowText = readAsciiText(bytes, at, width).trim();
        }
        continue;
      }
      (state.values as BigInt64Array)[out] = v;
      continue;
    }

    const v = scanAsciiFloat(bytes, at, width, decimals ?? 0);
    if (Number.isNaN(v)) {
      flagBad(state, bytes, out, at, width, isNull);
      (state.values as Float64Array)[out] = Number.NaN;
      continue;
    }
    (state.values as Float64Array)[out] = v;
  }
}

/** @internal Mask a field that violates its format, unless already null. */
function flagBad(
  state: AsciiState,
  bytes: Uint8Array,
  out: number,
  at: number,
  width: number,
  isNull: boolean,
): void {
  setMask(state, out);
  // A declared-undefined field is not also a format violation.
  if (isNull || state.badRow !== undefined) return;

  state.badRow = out;
  state.badText = readAsciiText(bytes, at, width);
}

/** @internal Warnings the decode pass accumulated for one column. */
export function asciiWarnings(state: AsciiState, label: string): string[] {
  const out: string[] = [];
  if (state.badRow !== undefined) {
    out.push(
      `${label}: row ${state.badRow} does not match TFORM ${state.column.tform.raw.trim()} (${JSON.stringify(state.badText)}); decoded as undefined`,
    );
  }
  if (state.overflowRow !== undefined) {
    out.push(
      `${label}: row ${state.overflowRow} holds ${state.overflowText}, which does not fit a 64-bit integer; decoded as undefined`,
    );
  }
  if (state.badCharByte !== undefined) {
    const seen = `0x${state.badCharByte.toString(16).padStart(2, "0")}`;
    out.push(`${label}: character field holds bytes outside 0x20..0x7e (first saw ${seen})`);
  }

  return out;
}

/** @internal The result of assembling an ASCII table's column model. */
export interface AsciiColumnsResult {
  columns: AsciiTableColumn[];
  warnings: string[];
}

/**
 * @internal Assemble an ASCII table's column model. Positions come from
 * `TBCOLn`, never a running sum: fields may be gapped or overlap (§7.2.4).
 */
export function readAsciiColumns(
  header: FitsHeader,
  hduIndex: number,
  naxis1: number,
): AsciiColumnsResult {
  const fail = (msg: string): never => {
    throw new FitsStructureError(`HDU ${hduIndex}: ${msg}`, { hduIndex });
  };

  const tfields = readTfields(header, fail);

  const columns: AsciiTableColumn[] = [];
  const warnings: string[] = [];
  const seenNames = new Set<string>();

  const pcount = header.getNumber("PCOUNT");
  if (pcount === undefined) {
    warnings.push("PCOUNT is missing; an ASCII table has no heap");
  } else if (pcount !== 0) {
    warnings.push(`PCOUNT ${pcount} is not 0; an ASCII table has no heap, so it is ignored`);
  }

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
    const parsed = parseAsciiTform(tformRaw!, warn);
    if (parsed === undefined) {
      fail(`TFORM${n} '${tformRaw}' is not a valid ASCII table format`);
    }
    const tform = parsed!;

    const tbcol = header.getNumber(`TBCOL${n}`);
    if (tbcol === undefined || !Number.isInteger(tbcol) || tbcol < 1) {
      fail(`TBCOL${n} ${String(tbcol)} is not an integer of 1 or more`);
    }
    if (tbcol! + tform.width - 1 > naxis1) {
      fail(
        `TBCOL${n} ${tbcol} spans columns ${tbcol}..${tbcol! + tform.width - 1} but NAXIS1 is ${naxis1}`,
      );
    }

    if (name !== undefined) {
      const key = name.toUpperCase();
      if (seenNames.has(key)) {
        warn(`duplicate TTYPE '${name}'; selection by name resolves to the first`);
      }
      seenNames.add(key);
    }

    // §7.2.2 forbids TSCAL/TZERO on A fields only; there is no L or X here.
    const { tscal, tzero } = readScaling(header, n, tform.code !== "A", tform.code, warn);

    // TNULL is a character string here, not an integer sentinel (§7.2.2).
    let tnullText: string | undefined;
    const tnullRaw = header.get(`TNULL${n}`);
    if (typeof tnullRaw === "string") {
      tnullText = tnullRaw;
    } else if (tnullRaw !== undefined) {
      warn(`TNULL${n} ${JSON.stringify(tnullRaw)} is not a string; compared as text`);
      tnullText = JSON.stringify(tnullRaw);
    }

    if (header.getString(`TDIM${n}`) !== undefined) {
      warn(`TDIM${n} does not apply to an ASCII table; ignored`);
    }

    columns.push({
      index: n - 1,
      name,
      tform,
      unit: header.getString(`TUNIT${n}`),
      tscal,
      tzero,
      tnullText,
      tdisp: header.getString(`TDISP${n}`),
      byteWidth: tform.width,
      byteOffset: tbcol! - 1,
    });
  }

  // Overlap is legal but "not recommended"; gaps are normal and stay silent.
  const ordered = [...columns].sort((a, b) => a.byteOffset - b.byteOffset);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    if (prev.byteOffset + prev.byteWidth > ordered[i].byteOffset) {
      warnings.push(
        `column ${prev.index + 1} and column ${ordered[i].index + 1} overlap; both are decoded`,
      );
      break;
    }
  }

  return { columns, warnings };
}
