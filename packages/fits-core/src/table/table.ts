import { FitsIoError, FitsStructureError, FitsUnsupportedError } from "../errors.js";
import type { Hdu } from "../hdu/hdu.js";
import type { RandomAccessReader } from "../io/reader.js";
import { readTableColumns, type TableColumn } from "./columns.js";

/**
 * Every array kind a decoded column can hold. Numeric columns come back as
 * the typed array matching their {@link ColumnTypeCode}; `A` columns come
 * back as one `string` per row. `L` and `X` columns decode to a
 * `Uint8Array` of `0`/`1` values, one element per logical or per bit.
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

/**
 * One decoded column: its keyword model plus the values, flat and
 * column-major with `repeat` elements per row (`2 * repeat` floats for the
 * complex types, one string per row for `A`). A `TDIMn` cell shape is
 * metadata on {@link TableColumn.tdim}; the data stays flat either way.
 *
 * An `A` string ends at the first NUL byte, like CFITSIO (astropy keeps
 * the bytes after it), and sheds insignificant trailing spaces.
 */
export interface TableColumnData {
  readonly column: TableColumn;
  readonly values: TableColumnArray;
  /**
   * Per-element null mask, aligned with `values` (`1` = undefined), present
   * only when the column actually holds an undefined element. Values are
   * never overwritten to signal null: a `TNULLn` sentinel stays in `values`
   * (scaled like any other value when scaling applies), and an `L` byte
   * outside `T`/`F` decodes as `0` with its mask bit set. Float columns are
   * never masked; their undefined value is `NaN` in `values`.
   */
  readonly mask?: Uint8Array;
}

/**
 * A decoded `BINTABLE`, column-major.
 *
 * Unless `{ raw: true }` was passed, `TSCALn`/`TZEROn` are resolved per
 * column the way {@link readImage} resolves `BSCALE`/`BZERO`:
 *
 * - **Unsigned-integer convention** (`TSCALn=1`, `TZEROn` at the half
 *   range): the matching integer array with no float widening, `Uint16Array`
 *   for `I`, `Uint32Array` for `J`, `BigUint64Array` for `K`, and
 *   `Int8Array` for the signed-byte form (`B` with `TZEROn=-128`), a
 *   deliberate exactness divergence from astropy, which widens it to float.
 * - **Scaled** (any other `TSCALn`/`TZEROn`): `Float64Array`, always. A
 *   complex column scales both components, matching CFITSIO (astropy drops
 *   the imaginary part). A scaled `K` value past `2^53` carries float64
 *   rounding; `raw: true` is exact.
 * - **No scaling**: the on-disk array as decoded.
 */
export interface FitsTable {
  /** Rows decoded: the requested `rows` range, or all of them. */
  readonly rowCount: number;
  /** Total rows in the table (`NAXIS2`). */
  readonly totalRows: number;
  /** The decoded columns, in selection order (on-disk order by default). */
  readonly columns: readonly TableColumnData[];
  /** Non-fatal deviations noticed while interpreting the table. */
  readonly warnings: readonly string[];
}

/** Options for {@link readTable}. */
export interface ReadTableOptions {
  /**
   * Columns to decode, by `TTYPEn` name (case-insensitive; a duplicate name
   * resolves to its first column) or zero-based index. All columns when
   * omitted. Whole rows are fetched regardless, so a projection saves
   * memory and decode time, not I/O.
   */
  columns?: readonly (string | number)[];
  /** A contiguous row range to decode; the whole table when omitted. */
  rows?: { readonly start: number; readonly count: number };
  /**
   * Return on-disk values without applying `TSCALn`/`TZEROn` or the
   * unsigned-integer convention.
   */
  raw?: boolean;
  /**
   * Cancels the read. Rows are fetched in slabs; the signal is checked
   * before each, so an abort takes effect promptly and rejects with the
   * signal's reason.
   */
  signal?: AbortSignal;
}

const latin1 = new TextDecoder("latin1");

/** @internal Rows are fetched in slabs of at most this many bytes. */
const SLAB_BYTES = 8 * 1024 * 1024;

/** @internal Decode state for one selected column. */
interface ColumnState {
  column: TableColumn;
  values: TableColumnArray;
  mask?: Uint8Array;
  /** Total elements, for lazy mask allocation. */
  elemCount: number;
  /** An `L` column saw a byte outside `T`/`F`/0x00. */
  badLogical: boolean;
}

/** @internal Allocate the output array for a column over `rowCount` rows. */
function makeState(column: TableColumn, rowCount: number): ColumnState {
  const r = column.tform.repeat;
  const n = rowCount * r;

  let values: TableColumnArray;
  switch (column.tform.code) {
    case "L":
    case "X":
    case "B":
      values = new Uint8Array(n);
      break;
    case "I":
      values = new Int16Array(n);
      break;
    case "J":
      values = new Int32Array(n);
      break;
    case "K":
      values = new BigInt64Array(n);
      break;
    case "A":
      values = new Array<string>(rowCount).fill("");
      break;
    case "E":
      values = new Float32Array(n);
      break;
    case "D":
      values = new Float64Array(n);
      break;
    case "C":
      values = new Float32Array(2 * n);
      break;
    default: // M
      values = new Float64Array(2 * n);
      break;
  }

  return { column, values, elemCount: values.length, badLogical: false };
}

/** @internal Set one mask bit, allocating the mask on first use. */
function setMask(state: ColumnState, elem: number): void {
  if (state.mask === undefined) {
    state.mask = new Uint8Array(state.elemCount);
  }
  state.mask[elem] = 1;
}

/**
 * @internal Decode one column's fields from a slab of `slabRows` whole rows
 * into the state's output at row `outRow0`. Always copies; the slab buffer
 * is never retained.
 */
function decodeColumnSlab(
  state: ColumnState,
  bytes: Uint8Array,
  view: DataView,
  slabRows: number,
  rowStride: number,
  outRow0: number,
): void {
  const { column } = state;
  const r = column.tform.repeat;
  const off = column.byteOffset;
  const tnull = column.tnull;
  const tnullBig = column.tnullBig ?? (tnull !== undefined ? BigInt(tnull) : undefined);

  switch (column.tform.code) {
    case "L": {
      const o = state.values as Uint8Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) {
          const b = bytes[base + k];
          if (b === 0x54) {
            o[out + k] = 1;
          } else if (b === 0x46) {
            o[out + k] = 0;
          } else {
            // 0x00 is the undefined logical; other bytes are violations.
            o[out + k] = 0;
            setMask(state, out + k);
            if (b !== 0x00) state.badLogical = true;
          }
        }
      }
      break;
    }
    case "X": {
      const o = state.values as Uint8Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) {
          o[out + k] = (bytes[base + (k >> 3)] >> (7 - (k & 7))) & 1;
        }
      }
      break;
    }
    case "B": {
      const o = state.values as Uint8Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) {
          const v = bytes[base + k];
          o[out + k] = v;
          if (v === tnull) setMask(state, out + k);
        }
      }
      break;
    }
    case "I": {
      const o = state.values as Int16Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) {
          const v = view.getInt16(base + 2 * k, false);
          o[out + k] = v;
          if (v === tnull) setMask(state, out + k);
        }
      }
      break;
    }
    case "J": {
      const o = state.values as Int32Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) {
          const v = view.getInt32(base + 4 * k, false);
          o[out + k] = v;
          if (v === tnull) setMask(state, out + k);
        }
      }
      break;
    }
    case "K": {
      const o = state.values as BigInt64Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) {
          const v = view.getBigInt64(base + 8 * k, false);
          o[out + k] = v;
          if (v === tnullBig) setMask(state, out + k);
        }
      }
      break;
    }
    case "A": {
      const o = state.values as string[];
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;

        // Bytes past a NUL are undefined; trailing blanks are insignificant.
        let len = 0;
        while (len < r && bytes[base + len] !== 0x00) {
          len++;
        }
        while (len > 0 && bytes[base + len - 1] === 0x20) {
          len--;
        }

        o[outRow0 + row] = latin1.decode(bytes.subarray(base, base + len));
      }
      break;
    }
    case "E": {
      const o = state.values as Float32Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) o[out + k] = view.getFloat32(base + 4 * k, false);
      }
      break;
    }
    case "D": {
      const o = state.values as Float64Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * r;
        for (let k = 0; k < r; k++) o[out + k] = view.getFloat64(base + 8 * k, false);
      }
      break;
    }
    case "C": {
      const o = state.values as Float32Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * 2 * r;
        for (let k = 0; k < 2 * r; k++) o[out + k] = view.getFloat32(base + 4 * k, false);
      }
      break;
    }
    default: {
      // M
      const o = state.values as Float64Array;
      for (let row = 0; row < slabRows; row++) {
        const base = row * rowStride + off;
        const out = (outRow0 + row) * 2 * r;
        for (let k = 0; k < 2 * r; k++) o[out + k] = view.getFloat64(base + 8 * k, false);
      }
      break;
    }
  }
}

/**
 * @internal The unsigned/signed integer convention (`TSCALn=1`, `TZEROn` at
 * the half range); mirrors the image path's `unsignedView`. Returns
 * `undefined` if it does not apply.
 */
function unsignedView(state: ColumnState): TableColumnArray | undefined {
  const { tscal, tzero, tzeroBig } = state.column;
  if (tscal !== 1) return undefined;

  const code = state.column.tform.code;
  if (code === "B" && tzero === -(2 ** 7)) {
    const u = state.values as Uint8Array;
    const out = new Int8Array(u.length);
    for (let i = 0; i < u.length; i++) out[i] = u[i] - 2 ** 7;
    return out;
  }
  if (code === "I" && tzero === 2 ** 15) {
    const s = state.values as Int16Array;
    const out = new Uint16Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] + 2 ** 15;
    return out;
  }
  if (code === "J" && tzero === 2 ** 31) {
    const s = state.values as Int32Array;
    const out = new Uint32Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] + 2 ** 31;
    return out;
  }
  if (code === "K" && (tzeroBig === 1n << 63n || tzero === 2 ** 63)) {
    const s = state.values as BigInt64Array;
    const out = new BigUint64Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = BigInt.asUintN(64, s[i] + (1n << 63n));
    return out;
  }

  return undefined;
}

/** @internal Apply the column scaling policy to a freshly decoded array. */
function scaleColumn(state: ColumnState): TableColumnArray {
  const code = state.column.tform.code;
  if (code === "L" || code === "X" || code === "A") return state.values;

  const unsigned = unsignedView(state);
  if (unsigned) return unsigned;

  const { tscal, tzeroBig } = state.column;
  if (tscal === 1 && state.column.tzero === 0 && tzeroBig === undefined) {
    return state.values;
  }

  // A bigint TZERO (K past safe-int) holds the real offset; apply it in
  // float64 like astropy, never the truncated numeric fallback.
  const tzero = tzeroBig !== undefined ? Number(tzeroBig) : state.column.tzero;
  const native = state.values as Exclude<TableColumnArray, string[]>;
  const out = new Float64Array(native.length);
  for (let i = 0; i < native.length; i++) {
    const raw = native[i];
    out[i] = tzero + tscal * (typeof raw === "bigint" ? Number(raw) : raw);
  }

  return out;
}

/**
 * Read and decode the columns of a `BINTABLE` extension, column-major.
 *
 * Rows are fetched through `reader` in bounded slabs, so a large catalog is
 * never materialized as raw bytes, and an optional `rows` range reads only
 * the bytes that range spans. Each selected column comes back as a flat
 * typed array (`repeat` elements per row) with big-endian fields decoded to
 * native values; `TSCALn`/`TZEROn` are applied by default. See
 * {@link FitsTable} for the scaling policy and {@link TableColumnData} for
 * the null-mask contract.
 *
 * Variable-length array columns (`P`/`Q` descriptors) parse into the column
 * model but cannot be decoded yet; selecting one throws. Use a `columns`
 * projection to read the fixed-width columns of a table that contains them.
 *
 * @throws {@link FitsStructureError} if the HDU is not a binary table, the
 * structural or column keywords are invalid, the `columns` or `rows`
 * options are out of range, or the data unit is truncated.
 * @throws {@link FitsUnsupportedError} if the HDU is an ASCII table or a
 * tile-compressed image (`ZIMAGE = T`), or a selected column is a
 * variable-length array.
 *
 * @example
 * ```ts
 * const { hdus } = await openFits(reader);
 * const events = findHdu(hdus, "EVENTS");
 * if (!events) throw new Error("no EVENTS extension");
 * const table = await readTable(events, reader, { columns: ["TIME", "PHA"] });
 * const time = table.columns[0].values as Float64Array;
 * ```
 */
export async function readTable(
  hdu: Hdu,
  reader: RandomAccessReader,
  opts: ReadTableOptions = {},
): Promise<FitsTable> {
  if (hdu == null || typeof hdu !== "object") {
    throw new FitsStructureError("readTable: an Hdu is required");
  }
  if (reader == null || typeof (reader as { read?: unknown }).read !== "function") {
    throw new FitsIoError("readTable: a RandomAccessReader is required");
  }

  if (hdu.type !== "bintable") {
    if (hdu.type === "table") {
      throw new FitsUnsupportedError(
        `HDU ${hdu.index} is an ASCII table; ASCII tables are not supported yet`,
        { hduIndex: hdu.index },
      );
    }

    throw new FitsStructureError(`HDU ${hdu.index} is not a binary table (type ${hdu.type})`, {
      hduIndex: hdu.index,
    });
  }

  // A tile-compressed image is structurally a BINTABLE; name the real
  // thing rather than failing on its heap-backed data column.
  if (hdu.header.getBoolean("ZIMAGE") === true) {
    const algorithm = hdu.header.getString("ZCMPTYPE") ?? "unknown algorithm";
    throw new FitsUnsupportedError(
      `HDU ${hdu.index} is a tile-compressed image (${algorithm}); compressed images are not supported yet`,
      { hduIndex: hdu.index },
    );
  }

  const fail = (msg: string): never => {
    throw new FitsStructureError(`HDU ${hdu.index}: ${msg}`, { hduIndex: hdu.index });
  };
  const header = hdu.header;

  const bitpix = header.getNumber("BITPIX");
  if (bitpix !== 8) {
    fail(`BITPIX ${String(bitpix)} is not 8`);
  }
  const naxis = header.getNumber("NAXIS");
  if (naxis !== 2) {
    fail(`NAXIS ${String(naxis)} is not 2`);
  }
  const naxis1 = header.getNumber("NAXIS1");
  if (naxis1 === undefined || !Number.isInteger(naxis1) || naxis1 < 0) {
    fail(`NAXIS1 ${String(naxis1)} is not a non-negative integer`);
  }
  const naxis2 = header.getNumber("NAXIS2");
  if (naxis2 === undefined || !Number.isInteger(naxis2) || naxis2 < 0) {
    fail(`NAXIS2 ${String(naxis2)} is not a non-negative integer`);
  }
  if (!hdu.dataSizeKnown) {
    fail(
      "the data unit size is unknown; enumerate over the whole file (openFits, or readHdus on complete bytes) and retry",
    );
  }

  const rowStride = naxis1!;
  const totalRows = naxis2!;

  const model = readTableColumns(header, hdu.index);
  const warnings = [...model.warnings];

  if (model.rowWidth > rowStride) {
    fail(`columns span ${model.rowWidth} bytes but NAXIS1 is ${rowStride}`);
  }
  if (model.rowWidth < rowStride) {
    warnings.push(
      `rows carry ${rowStride - model.rowWidth} trailing bytes not covered by any column; ignored`,
    );
  }
  if ((header.getNumber("GCOUNT") ?? 1) !== 1) {
    warnings.push(`GCOUNT ${header.getNumber("GCOUNT")} is not 1; ignored`);
  }
  if (header.getNumber("PCOUNT") === undefined) {
    warnings.push("PCOUNT is missing; assuming no heap");
  }

  let rowStart = 0;
  let rowCount = totalRows;
  if (opts.rows) {
    const { start, count } = opts.rows;
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0) {
      fail(`rows { start: ${start}, count: ${count} } is not a valid range`);
    }
    if (start + count > totalRows) {
      fail(`rows [${start}, ${start + count}) is out of 0..${totalRows}`);
    }
    rowStart = start;
    rowCount = count;
  }

  let selected: TableColumn[];
  if (opts.columns) {
    selected = opts.columns.map((sel) => {
      if (typeof sel === "number") {
        if (!Number.isInteger(sel) || sel < 0 || sel >= model.columns.length) {
          fail(`column index ${sel} is out of 0..${model.columns.length - 1}`);
        }
        return model.columns[sel];
      }

      const upper = sel.toUpperCase();
      const match = model.columns.find((c) => c.name?.toUpperCase() === upper);
      if (match === undefined) {
        fail(`no column is named '${sel}'`);
      }
      return match!;
    });
  } else {
    selected = model.columns;
  }

  for (const column of selected) {
    if (column.tform.code === "P" || column.tform.code === "Q") {
      throw new FitsUnsupportedError(
        `HDU ${hdu.index} column ${column.index + 1} (${column.tform.raw}) is a variable-length array; heap columns are not supported yet`,
        { hduIndex: hdu.index },
      );
    }
  }

  const states = selected.map((column) => makeState(column, rowCount));

  const needBytes = rowCount > 0 && selected.some((c) => c.byteWidth > 0);
  if (needBytes) {
    const rowsPerSlab = Math.max(1, Math.floor(SLAB_BYTES / rowStride));

    for (let done = 0; done < rowCount; done += rowsPerSlab) {
      opts.signal?.throwIfAborted();

      const slabRows = Math.min(rowsPerSlab, rowCount - done);
      const offset = hdu.dataOffset + (rowStart + done) * rowStride;
      const want = slabRows * rowStride;
      const bytes = await reader.read(offset, want);
      if (bytes.length < want) {
        fail(`table data is truncated at byte ${offset + bytes.length}`);
      }

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const state of states) {
        decodeColumnSlab(state, bytes, view, slabRows, rowStride, done);
      }
    }
  }

  const columns: TableColumnData[] = states.map((state) => {
    if (state.badLogical) {
      const label =
        state.column.name === undefined
          ? `column ${state.column.index + 1}`
          : `column ${state.column.index + 1} (${state.column.name})`;
      warnings.push(`${label}: logical bytes outside T/F/0x00 decoded as undefined`);
    }

    return {
      column: state.column,
      values: opts.raw === true ? state.values : scaleColumn(state),
      mask: state.mask,
    };
  });

  return { rowCount, totalRows, columns, warnings };
}
