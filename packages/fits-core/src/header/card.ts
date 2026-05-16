/** A complex value as written in a FITS card: `(real, imaginary)`. */
export interface FitsComplex {
  readonly real: number;
  readonly imag: number;
}

/**
 * The parsed value of a header card. `undefined` is a commentary card or an
 * empty value field. Integers past `Number.MAX_SAFE_INTEGER` come back as
 * `bigint` rather than lose precision.
 */
export type HeaderValue = string | number | bigint | boolean | FitsComplex | undefined;

/** A single 80-character header card, parsed. */
export interface HeaderCard {
  /**
   * Uppercased for normal keywords; for HIERARCH the full hierarchical name
   * (e.g. `ESO DET CHIP1 NAME`) with internal spacing preserved.
   */
  readonly keyword: string;
  readonly value: HeaderValue;
  readonly comment?: string;
  /** COMMENT, HISTORY, or blank-keyword card. */
  readonly commentary: boolean;
  /** Original card image, right padding trimmed. */
  readonly raw: string;
}

/** Narrow a {@link HeaderValue} to a {@link FitsComplex} pair. */
export function isFitsComplex(v: HeaderValue): v is FitsComplex {
  return typeof v === "object" && v !== null && "real" in v && "imag" in v;
}
