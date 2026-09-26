import type { FitsTable } from "@fits-js/core";
import { RecordBatch, Schema, Struct, Table, makeData, type Data, type Field } from "apache-arrow";
import { convertColumn, fieldNames } from "./convert.js";

/** @internal Convert a decoded table into a single record batch. */
export function toRecordBatch(table: FitsTable): RecordBatch {
  const fields: Field[] = [];
  const children: Data[] = [];
  const names = fieldNames(table.columns.map((c) => c.column));
  for (const [i, column] of table.columns.entries()) {
    const converted = convertColumn(column, table.rowCount, names[i]);
    fields.push(converted.field);
    children.push(converted.data);
  }

  const data = makeData({
    type: new Struct(fields),
    length: table.rowCount,
    nullCount: 0,
    children,
  });
  return new RecordBatch(new Schema(fields), data);
}

/**
 * Convert a table decoded by `readTable` into an Apache Arrow `Table` with
 * one record batch.
 *
 * Numeric columns share memory with `table`: the Arrow buffers are views of
 * the same typed arrays, so writing to one changes the other. Logical and
 * bit columns are packed into bitmaps, strings are encoded as UTF-8, and
 * null masks become validity bitmaps; those are copies.
 *
 * Column types:
 *
 * - A scalar column (repeat 1) maps to the Arrow type of its decoded array:
 *   `Int16`, `Float64` and so on, after `TSCALn`/`TZEROn` scaling.
 * - A column with repeat `r` maps to `FixedSizeList<T, r>`; `TDIMn` is kept
 *   as metadata, not as nesting.
 * - `L` and `X` map to `Bool`; character columns map to `Utf8`, one string
 *   per row.
 * - Complex `C`/`M` values map to `FixedSizeList<Float32|Float64, 2>` of
 *   (re, im), since Arrow has no complex type.
 * - Variable-length `P`/`Q` columns map to `List<T>`.
 *
 * Fields are named after `TTYPEn`. Names are made unique ignoring case, as
 * DuckDB requires: a repeated name takes a `_1`, `_2` suffix and a column
 * without `TTYPEn` is named `col<n>` after its position. Each field carries
 * `fits:TFORM` metadata, plus `fits:TTYPE`, `fits:TUNIT`, `fits:TDISP` and
 * `fits:TDIM` when the header sets them. A field is nullable when its
 * definition allows undefined values (`L`, integers with `TNULLn`, and every
 * ASCII table column), independent of whether this table has any.
 *
 * `table.warnings` is not carried over; read it from `table` directly.
 *
 * @throws {TypeError} If `table` does not have the shape `readTable`
 *   returns, for example a column whose `values` length does not match
 *   `rowCount`.
 * @throws {RangeError} If a string column needs more than 2 GiB of UTF-8;
 *   read fewer rows at a time with `readArrowBatches`.
 */
export function toArrowTable(table: FitsTable): Table {
  const batch = toRecordBatch(table);
  return new Table(batch.schema, [batch]);
}
