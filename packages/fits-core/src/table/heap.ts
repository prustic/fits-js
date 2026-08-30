import type { FitsHeader } from "../header/header.js";
import { heapArrayBytes, type ColumnTypeCode } from "./columns.js";

/**
 * @internal Where a BINTABLE's heap lives, in absolute source bytes.
 * `base` is heap byte 0; descriptor offsets are relative to it.
 */
export interface HeapGeometry {
  readonly base: number;
  readonly length: number;
}

/** @internal Gathered rows are indexed by `Int32Array`, as Arrow lists are. */
export const MAX_HEAP_SLOTS = 2 ** 31 - 1;

/**
 * @internal Locate the heap from the header (FITS v4.0 §7.3.5). The layout
 * is `[table](optional gap)[heap]`, `THEAP` is the offset from the start of
 * the data unit and defaults to `NAXIS1 * NAXIS2`, and `PCOUNT` spans the
 * gap plus the heap. `problem` is set when the heap cannot be located, which
 * is fatal only if a variable-length column is actually selected.
 */
export function heapGeometry(
  header: FitsHeader,
  dataOffset: number,
  naxis1: number,
  naxis2: number,
): { geometry: HeapGeometry; problem?: string; warnings: string[] } {
  const warnings: string[] = [];
  const tableBytes = naxis1 * naxis2;

  const pcountRaw = header.getNumber("PCOUNT");
  const pcount = pcountRaw ?? 0;
  if (pcountRaw !== undefined && (!Number.isInteger(pcount) || pcount < 0)) {
    return {
      geometry: { base: dataOffset + tableBytes, length: 0 },
      problem: `PCOUNT ${pcountRaw} is not a non-negative integer`,
      warnings,
    };
  }

  let theap = tableBytes;
  const theapRaw = header.getNumber("THEAP");
  if (theapRaw !== undefined) {
    if (pcount === 0) {
      // THEAP "shall not be used" without a heap to point at (§7.3.2).
      warnings.push(`THEAP ${theapRaw} is set but PCOUNT is 0; ignored`);
    } else if (!Number.isInteger(theapRaw) || theapRaw < 0) {
      return {
        geometry: { base: dataOffset + tableBytes, length: 0 },
        problem: `THEAP ${theapRaw} is not a non-negative integer`,
        warnings,
      };
    } else if (theapRaw < tableBytes) {
      return {
        geometry: { base: dataOffset + tableBytes, length: 0 },
        problem: `THEAP ${theapRaw} would overlap the ${tableBytes}-byte main table`,
        warnings,
      };
    } else if (theapRaw > tableBytes + pcount) {
      return {
        geometry: { base: dataOffset + tableBytes, length: 0 },
        problem: `THEAP ${theapRaw} is past the end of the data unit`,
        warnings,
      };
    } else {
      theap = theapRaw;
    }
  }

  return {
    geometry: { base: dataOffset + theap, length: tableBytes + pcount - theap },
    warnings,
  };
}

/** @internal Slots one element of `elementCode` occupies in the output. */
export function slotsPerElement(elementCode: Exclude<ColumnTypeCode, "P" | "Q">): number {
  return elementCode === "C" || elementCode === "M" ? 2 : 1;
}

/** @internal The gather layout for one variable-length column. */
export interface GatherPlan {
  /** Slot boundaries, `rowCount + 1` entries with `offsets[0] === 0`. */
  readonly offsets: Int32Array;
  /** Total slots, equal to the last offset. */
  readonly total: number;
  /** First row whose count exceeded the declared `(emax)`, if any. */
  readonly overMaxRow?: number;
}

/**
 * @internal Validate every descriptor against the heap and prefix-sum the
 * row lengths into Arrow-style slot boundaries. Pure, so the whole
 * descriptor contract is testable without building a file.
 *
 * `problem` is a fatal message naming the offending row; the standard
 * leaves negative counts and offsets undefined and requires arrays to lie
 * entirely within the heap, so those are refused rather than truncated the
 * way astropy truncates them.
 */
export function planGather(
  counts: Float64Array,
  heapOffsets: Float64Array,
  elementCode: Exclude<ColumnTypeCode, "P" | "Q">,
  heapLength: number,
  maxCount?: number,
): { plan?: GatherPlan; problem?: string } {
  const rowCount = counts.length;
  const offsets = new Int32Array(rowCount + 1);
  const slots = slotsPerElement(elementCode);

  let overMaxRow: number | undefined;
  let total = 0;
  for (let row = 0; row < rowCount; row++) {
    const count = counts[row];
    if (!Number.isInteger(count) || count < 0) {
      return { problem: `row ${row} has a negative or non-integer array length (${count})` };
    }

    if (count > 0) {
      const at = heapOffsets[row];
      if (!Number.isInteger(at) || at < 0) {
        return { problem: `row ${row} has a negative or non-integer heap offset (${at})` };
      }

      const bytes = heapArrayBytes(elementCode, count);
      if (at + bytes > heapLength) {
        return {
          problem: `row ${row} spans heap bytes ${at}..${at + bytes} but the heap is ${heapLength} bytes`,
        };
      }
      if (maxCount !== undefined && count > maxCount && overMaxRow === undefined) {
        overMaxRow = row;
      }
    }

    total += count * slots;
    if (total > MAX_HEAP_SLOTS) {
      return {
        problem: `gathered elements exceed ${MAX_HEAP_SLOTS}; read fewer rows with the rows option`,
      };
    }
    offsets[row + 1] = total;
  }

  return { plan: { offsets, total, overMaxRow } };
}

/** @internal One contiguous heap read covering one or more arrays. */
export interface HeapWindow {
  /** Heap-relative start offset. */
  readonly start: number;
  readonly length: number;
  /** Index into `order` one past the last array this window covers. */
  readonly end: number;
}

/**
 * @internal Plan the next read over descriptors sorted by heap offset. A
 * window always starts at a referenced array, so unreferenced gaps are
 * never fetched and no gap threshold needs tuning. A single array larger
 * than `maxBytes` becomes a window of its own.
 */
export function nextHeapWindow(
  order: Uint32Array,
  heapOffsets: Float64Array,
  byteLengths: Float64Array,
  from: number,
  maxBytes: number,
): HeapWindow {
  const first = order[from];
  const start = heapOffsets[first];
  let length = byteLengths[first];
  let end = from + 1;

  while (end < order.length) {
    const ref = order[end];
    const reach = heapOffsets[ref] + byteLengths[ref] - start;
    if (reach > maxBytes) break;

    // Sorted by offset, but an aliased array may end inside an earlier one.
    if (reach > length) length = reach;
    end++;
  }

  return { start, length, end };
}
