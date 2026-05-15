import type { HeaderCard, HeaderValue } from "./card.js";

/**
 * A parsed FITS header: the ordered list of {@link HeaderCard}s plus
 * keyword lookup. Returned inside {@link ParseHeaderResult} by
 * {@link parseHeader}.
 *
 * Keyword lookups are case-insensitive (FITS keywords are uppercase).
 * The standard permits a keyword to repeat; {@link FitsHeader.get} returns
 * the first occurrence and {@link FitsHeader.getAll} returns every one in
 * card order.
 *
 * @example
 * ```ts
 * const { header } = parseHeader(bytes);
 * if (header.getString("XTENSION") === "BINTABLE") {
 *   const fields = header.getNumber("TFIELDS");
 * }
 * ```
 *
 * @see [FITS Standard v4.0 §4.4: Keywords](https://fits.gsfc.nasa.gov/fits_standard.html)
 */
export class FitsHeader {
  readonly cards: readonly HeaderCard[];
  private readonly _byKeyword = new Map<string, HeaderCard[]>();

  constructor(cards: readonly HeaderCard[]) {
    this.cards = [...cards];
    for (const c of this.cards) {
      if (c.commentary) continue;
      // Case-insensitive lookup: HIERARCH keeps original case on the card.
      const k = c.keyword.toUpperCase();
      const list = this._byKeyword.get(k);
      if (list) list.push(c);
      else this._byKeyword.set(k, [c]);
    }
  }

  has(keyword: string): boolean {
    return this._byKeyword.has(keyword.toUpperCase());
  }

  /** First value for the keyword, or `undefined`. */
  get(keyword: string): HeaderValue {
    return this._byKeyword.get(keyword.toUpperCase())?.[0]?.value;
  }

  /** Every value for a keyword, in card order (FITS permits duplicates). */
  getAll(keyword: string): HeaderValue[] {
    return (this._byKeyword.get(keyword.toUpperCase()) ?? []).map((c) => c.value);
  }

  getString(keyword: string): string | undefined {
    const v = this.get(keyword);
    return typeof v === "string" ? v : undefined;
  }

  /**
   * The value as a number, or `undefined` if it is not numeric or is a
   * `bigint` too large to represent exactly. Use {@link FitsHeader.get} to
   * retrieve large integers without loss.
   */
  getNumber(keyword: string): number | undefined {
    const v = this.get(keyword);
    if (typeof v === "number") return v;
    if (typeof v === "bigint") {
      const n = Number(v);
      return BigInt(n) === v ? n : undefined;
    }
    return undefined;
  }

  getBoolean(keyword: string): boolean | undefined {
    const v = this.get(keyword);
    return typeof v === "boolean" ? v : undefined;
  }

  /** Accumulated COMMENT card text, in order. */
  get comments(): string[] {
    return this._commentary("COMMENT");
  }

  /** Accumulated HISTORY card text, in order. */
  get history(): string[] {
    return this._commentary("HISTORY");
  }

  private _commentary(keyword: string): string[] {
    const out: string[] = [];
    for (const c of this.cards) {
      if (c.commentary && c.keyword === keyword) {
        out.push(c.raw.slice(8).trimEnd());
      }
    }
    return out;
  }
}
