import type { TableColumn, TableColumnData } from "@fits-js/core";
import {
  Bool,
  FixedSizeList,
  Field,
  Float32,
  Float64,
  Int16,
  Int32,
  Int64,
  Int8,
  List,
  Uint16,
  Uint32,
  Uint64,
  Uint8,
  Utf8,
  makeData,
  type Data,
  type DataType,
} from "apache-arrow";
import { packBits, validityBitmap } from "./bits.js";
import { encodeUtf8 } from "./utf8.js";

type NumericArray = Exclude<TableColumnData["values"], string[]>;

// makeData is overloaded per concrete type; the column type is only known at
// runtime, so the props are built loosely and checked by the caller.
const make = makeData as unknown as (props: object) => Data;

/** @internal One converted column. */
export interface ArrowColumn {
  readonly field: Field;
  readonly data: Data;
}

function elementCode(column: TableColumn): string {
  const tform = column.tform;
  return tform.kind === "ascii" ? tform.code : (tform.elementCode ?? tform.code);
}

/**
 * @internal Whether core can mask this column. Decided from the column
 * definition alone, so every batch of a table gets the same schema.
 */
export function isNullable(column: TableColumn): boolean {
  if (column.tform.kind === "ascii") {
    return true;
  }

  const code = elementCode(column);
  if (code === "L") {
    return true;
  }

  const integer = code === "B" || code === "I" || code === "J" || code === "K";
  return integer && (column.tnull !== undefined || column.tnullBig !== undefined);
}

/**
 * @internal Arrow field names, unique ignoring case, since DuckDB compares
 * identifiers that way and pyarrow cannot select a repeated name. Every
 * `TTYPEn` keeps its name on first use; repeats and unnamed columns take
 * DuckDB's `_1`, `_2` suffixes, skipping names already taken.
 */
export function fieldNames(columns: readonly TableColumn[]): string[] {
  const taken = new Set<string>();
  const names: (string | undefined)[] = columns.map((column) => {
    const name = column.name;
    if (name === undefined || taken.has(name.toUpperCase())) {
      return undefined;
    }

    taken.add(name.toUpperCase());
    return name;
  });

  return names.map((name, i) => {
    if (name !== undefined) {
      return name;
    }

    const base = columns[i].name ?? `col${columns[i].index + 1}`;
    let unique = base;
    for (let k = 1; taken.has(unique.toUpperCase()); k++) {
      unique = `${base}_${k}`;
    }
    taken.add(unique.toUpperCase());

    return unique;
  });
}

function fieldMetadata(column: TableColumn): Map<string, string> {
  const metadata = new Map<string, string>();
  if (column.name !== undefined) {
    metadata.set("fits:TTYPE", column.name);
  }
  metadata.set("fits:TFORM", column.tform.raw.trim());
  if (column.unit !== undefined) {
    metadata.set("fits:TUNIT", column.unit);
  }
  if (column.tdisp !== undefined) {
    metadata.set("fits:TDISP", column.tdisp);
  }
  if (column.tdim !== undefined) {
    metadata.set("fits:TDIM", `(${column.tdim.join(",")})`);
  }

  return metadata;
}

// Keyed by the array class rather than TFORM, since scaling changes the type.
const LEAF_TYPES = new Map<unknown, () => DataType>([
  [Uint8Array, () => new Uint8()],
  [Int8Array, () => new Int8()],
  [Int16Array, () => new Int16()],
  [Uint16Array, () => new Uint16()],
  [Int32Array, () => new Int32()],
  [Uint32Array, () => new Uint32()],
  [BigInt64Array, () => new Int64()],
  [BigUint64Array, () => new Uint64()],
  [Float32Array, () => new Float32()],
  [Float64Array, () => new Float64()],
]);

function numericType(values: NumericArray, label: string): DataType {
  const leaf = LEAF_TYPES.get(values.constructor);
  if (leaf === undefined) {
    throw new TypeError(`${label}: values are not a supported typed array`);
  }

  return leaf();
}

function validity(mask: Uint8Array | undefined): object {
  if (mask === undefined) {
    return { nullCount: 0 };
  }

  const { bitmap, nullCount } = validityBitmap(mask);
  return { nullBitmap: bitmap, nullCount };
}

/**
 * @internal Convert one decoded column to an Arrow field and its data.
 * Typed arrays are passed through without copying; only bits, strings and
 * complex list offsets are rebuilt. The mask lands on the innermost data,
 * the one built from `values`, since it has one entry per value.
 */
export function convertColumn(
  columnData: TableColumnData,
  rowCount: number,
  name: string,
): ArrowColumn {
  const { column, values, mask, offsets } = columnData;
  const label = `column ${JSON.stringify(name)}`;
  const nullable = isNullable(column);
  const metadata = fieldMetadata(column);

  if (mask !== undefined) {
    if (!nullable) {
      throw new TypeError(`${label}: has a null mask but its definition cannot hold nulls`);
    }
    if (mask.length !== values.length) {
      throw new TypeError(`${label}: mask has ${mask.length} entries for ${values.length} values`);
    }
  }

  if (Array.isArray(values)) {
    if (values.length !== rowCount) {
      throw new TypeError(`${label}: ${values.length} strings for ${rowCount} rows`);
    }

    const utf8 = encodeUtf8(values);
    const data = make({
      type: new Utf8(),
      length: rowCount,
      valueOffsets: utf8.offsets,
      data: utf8.bytes,
      ...validity(mask),
    });

    return { field: new Field(name, new Utf8(), nullable, metadata), data };
  }

  const tform = column.tform;
  const code = elementCode(column);
  const varlen = tform.kind === "binary" && (tform.code === "P" || tform.code === "Q");
  const complex = code === "C" || code === "M";
  const bool = tform.kind === "binary" && (code === "L" || code === "X");
  const repeat = tform.kind === "binary" && !varlen ? tform.repeat : 1;

  if (varlen) {
    if (
      offsets === undefined ||
      offsets.length !== rowCount + 1 ||
      offsets[0] !== 0 ||
      offsets[rowCount] !== values.length
    ) {
      throw new TypeError(
        `${label}: offsets do not describe ${rowCount} rows of ${values.length} values`,
      );
    }
  } else if (values.length !== rowCount * repeat * (complex ? 2 : 1)) {
    throw new TypeError(
      `${label}: ${values.length} values for ${rowCount} rows of ${tform.raw.trim()}`,
    );
  }
  if (complex && values.length % 2 !== 0) {
    throw new TypeError(`${label}: complex values are not in (re, im) pairs`);
  }
  if (bool && !(values instanceof Uint8Array)) {
    throw new TypeError(`${label}: logical and bit values must be a Uint8Array`);
  }

  let type: DataType = bool ? new Bool() : numericType(values, label);
  let data = make({
    type,
    length: values.length,
    data: bool ? packBits(values as Uint8Array) : values,
    ...validity(mask),
  });
  let fieldNullable = nullable;

  const wrap = (outer: DataType, props: object): void => {
    type = outer;
    data = make({ type, child: data, nullCount: 0, ...props });
    fieldNullable = false;
  };

  if (complex) {
    wrap(new FixedSizeList(2, new Field("item", type, fieldNullable)), {
      length: values.length / 2,
    });
  }

  if (varlen) {
    // Core counts float slots; Arrow counts (re, im) pairs.
    let valueOffsets = offsets!;
    if (complex) {
      valueOffsets = valueOffsets.map((slot) => slot >> 1);
    }
    wrap(new List(new Field("item", type, fieldNullable)), { length: rowCount, valueOffsets });
  } else if (repeat !== 1) {
    wrap(new FixedSizeList(repeat, new Field("item", type, fieldNullable)), { length: rowCount });
  }

  return { field: new Field(name, type, fieldNullable, metadata), data };
}
