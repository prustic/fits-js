import type { ColumnTypeCode, TableColumn } from "./columns.js";

/**
 * Every array kind a decoded column can hold. Numeric columns come back as
 * the typed array matching their {@link ColumnTypeCode}; `A` columns come
 * back as one `string` per row. `L` and `X` columns decode to a
 * `Uint8Array` of `0`/`1` values, one element per logical or per bit. A
 * variable-length column holds every row's array concatenated, split by
 * {@link TableColumnData.offsets}.
 */
export type TableColumnArray =
  | Uint8Array
  | Int8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array
  | string[];

/** @internal Fields shared by every column decode state. */
export interface BaseState {
  column: TableColumn;
  values: TableColumnArray;
  mask?: Uint8Array;
  /** Total slots, for lazy mask allocation. */
  elemCount: number;
  /**
   * First byte an `L` column saw outside `T`/`F`/0x00. Named in the
   * warning because writers do produce them: astropy stores 0x01/0x00 in a
   * variable-length logical heap, which the standard does not allow.
   */
  badLogicalByte?: number;
}

/** @internal Allocate `slots` values of `code`; `A` holds one string per row. */
export function allocValues(
  code: Exclude<ColumnTypeCode, "P" | "Q">,
  slots: number,
  rows: number,
): TableColumnArray {
  switch (code) {
    case "L":
    case "X":
    case "B":
      return new Uint8Array(slots);
    case "I":
      return new Int16Array(slots);
    case "J":
      return new Int32Array(slots);
    case "K":
      return new BigInt64Array(slots);
    case "A":
      return new Array<string>(rows).fill("");
    case "E":
      return new Float32Array(slots);
    case "D":
      return new Float64Array(slots);
    case "C":
      return new Float32Array(slots);
    default: // M
      return new Float64Array(slots);
  }
}

/** @internal Set one mask bit, allocating the mask on first use. */
export function setMask(state: BaseState, elem: number): void {
  if (state.mask === undefined) {
    state.mask = new Uint8Array(state.elemCount);
  }
  state.mask[elem] = 1;
}
