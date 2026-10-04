import {
  FitsStructureError,
  readTable,
  type Hdu,
  type RandomAccessReader,
  type ReadTableOptions,
} from "@fits-js/core";
import type { RecordBatch } from "apache-arrow";
import { toRecordBatch } from "./table.js";

const BATCH_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_ROWS = 65536;

/** Options for {@link readArrowBatches}. */
export interface ReadArrowBatchesOptions extends ReadTableOptions {
  /**
   * Rows per batch; the last batch holds the remainder. Defaults to as
   * many rows as fit in about 16 MiB of table and heap bytes, at most
   * 65,536.
   */
  batchRows?: number;
  /**
   * Receives the warnings `readTable` reports, each distinct message once
   * per call, since header-level warnings would otherwise repeat for every
   * batch. Warnings are dropped when this is not set.
   */
  onWarning?: (message: string) => void;
}

// Heap bytes are averaged over the rows, so varlen-heavy tables get
// smaller batches too.
function defaultBatchRows(hdu: Hdu): number {
  const naxis1 = hdu.header.getNumber("NAXIS1") ?? 0;
  const naxis2 = hdu.header.getNumber("NAXIS2") ?? 0;
  const pcount = hdu.header.getNumber("PCOUNT") ?? 0;
  const rowBytes = naxis1 + (naxis2 > 0 ? pcount / naxis2 : 0);

  return Math.min(MAX_BATCH_ROWS, Math.max(1, Math.floor(BATCH_BYTES / Math.max(rowBytes, 1))));
}

/**
 * Read a `BINTABLE` or ASCII `TABLE` extension as a stream of Apache
 * Arrow record batches, one `readTable` call per batch, so only one batch
 * of rows is held in memory at a time.
 *
 * Every batch has the same schema, typed as {@link toArrowTable} describes.
 * `columns`, `rows`, `raw` and `signal` work as in `readTable`: `rows`
 * limits the range and `batchRows` splits it. An empty range yields one
 * batch with no rows, so a consumer still sees the schema. Stopping the
 * iteration early stops reading.
 *
 * The batches can be written straight into an IPC stream, which is how
 * they reach DuckDB-wasm without sharing Arrow objects across library
 * copies:
 *
 * ```ts
 * const writer = new RecordBatchStreamWriter();
 * for await (const batch of readArrowBatches(hdu, reader)) writer.write(batch);
 * writer.finish();
 * await conn.insertArrowFromIPCStream(writer.toUint8Array(true), { name: "t" });
 * ```
 *
 * Errors surface from the first `next()` call, as with any async
 * generator.
 *
 * @throws {RangeError} If `batchRows` is not a positive integer.
 * @throws {FitsStructureError} If `rows` is invalid or out of range, or
 *   for any structural problem `readTable` reports.
 */
export async function* readArrowBatches(
  hdu: Hdu,
  reader: RandomAccessReader,
  opts: ReadArrowBatchesOptions = {},
): AsyncGenerator<RecordBatch, void, undefined> {
  const { batchRows, onWarning, ...tableOpts } = opts;
  if (batchRows !== undefined && (!Number.isSafeInteger(batchRows) || batchRows < 1)) {
    throw new RangeError(`batchRows ${batchRows} is not a positive integer`);
  }

  tableOpts.signal?.throwIfAborted();

  const seen = new Set<string>();
  const report = (warnings: readonly string[]): void => {
    for (const warning of warnings) {
      if (!seen.has(warning)) {
        seen.add(warning);
        onWarning?.(warning);
      }
    }
  };

  // Zero rows: validates the HDU and the projection and returns the
  // schema without fetching any row bytes.
  const probe = await readTable(hdu, reader, { ...tableOpts, rows: { start: 0, count: 0 } });
  report(probe.warnings);

  let start = 0;
  let count = probe.totalRows;
  if (tableOpts.rows) {
    ({ start, count } = tableOpts.rows);
    const fail = (msg: string): never => {
      throw new FitsStructureError(`HDU ${hdu.index}: ${msg}`, { hduIndex: hdu.index });
    };
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0) {
      fail(`rows { start: ${start}, count: ${count} } is not a valid range`);
    }
    if (start + count > probe.totalRows) {
      fail(`rows [${start}, ${start + count}) is out of 0..${probe.totalRows}`);
    }
  }

  if (count === 0) {
    yield toRecordBatch(probe);
    return;
  }

  const step = batchRows ?? defaultBatchRows(hdu);
  const end = start + count;
  for (let at = start; at < end; at += step) {
    const rows = { start: at, count: Math.min(step, end - at) };
    const table = await readTable(hdu, reader, { ...tableOpts, rows });
    report(table.warnings);
    yield toRecordBatch(table);
  }
}
