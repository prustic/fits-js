import type { FitsHeader } from "../header/header.js";

/**
 * The kind of an HDU, from its `SIMPLE`/`XTENSION` keyword. `unknown` is a
 * conforming extension of a type this library does not decode; its bytes are
 * still located and skipped so later HDUs remain reachable.
 */
export type HduType = "primary" | "image" | "bintable" | "table" | "unknown";

/**
 * One Header-Data Unit: its parsed {@link FitsHeader} and the location of
 * its data within the source, without decoding the data itself.
 *
 * @see [FITS Standard v4.0 §3.3-3.4: primary HDU and extensions](https://fits.gsfc.nasa.gov/fits_standard.html)
 */
export interface Hdu {
  /** Zero-based position in the file. */
  readonly index: number;
  readonly type: HduType;
  readonly header: FitsHeader;
  /** `EXTNAME`, when present. */
  readonly name?: string;
  /** `EXTVER`, when present. */
  readonly version?: number;
  /** Byte offset of the data unit from the start of the source. */
  readonly dataOffset: number;
  /** Data unit length in bytes, padded to the 2880 block. */
  readonly dataByteLength: number;
  /**
   * `false` when `dataByteLength` does not reflect the full declared data
   * unit: a structural keyword was missing or out of domain, or the source
   * was truncated. Reading `dataOffset .. dataOffset + dataByteLength` is
   * only safe when this is `true`.
   */
  readonly dataSizeKnown: boolean;
}

/**
 * Find an extension by `EXTNAME` (case-insensitive), optionally also
 * matching `EXTVER`. An HDU with no `EXTVER` is treated as version 1 for
 * the match, following astropy. Returns the first match, or `undefined`.
 */
export function findHdu(hdus: readonly Hdu[], name: string, version?: number): Hdu | undefined {
  const upper = name.toUpperCase();
  return hdus.find(
    (h) =>
      h.name?.toUpperCase() === upper && (version === undefined || (h.version ?? 1) === version),
  );
}
