import { FitsHeaderError } from "../errors.js";
import type { HeaderCard } from "./card.js";
import { FitsHeader } from "./header.js";
import { parseCard, parseContinuation, rstripSpaces, type CardParseContext } from "./parse-card.js";

const BLOCK = 2880;
const CARD = 80;

/** Options for {@link parseHeader}. */
export interface ParseHeaderOptions {
  /**
   * Reject standard violations instead of recovering from them. Default
   * `false`: parse leniently and report issues on `warnings`, matching how
   * astropy and CFITSIO tolerate real-world archive files.
   */
  strict?: boolean;
}

/** Result of {@link parseHeader}. */
export interface ParseHeaderResult {
  readonly header: FitsHeader;
  /**
   * Bytes the header occupies, always a multiple of 2880. The data unit (or
   * next HDU) begins at this offset from the start of `bytes`.
   */
  readonly byteLength: number;
  /** Standard deviations recovered from in lenient mode. */
  readonly warnings: readonly string[];
}

const latin1 = new TextDecoder("latin1");

/**
 * Parse a FITS header from the start of `bytes`.
 *
 * Walks the 2880-byte header blocks, parsing 80-character cards until the
 * `END` keyword, and resolves the CONTINUE long-string convention. The byte
 * source is not consulted beyond the header, so this works on an in-memory
 * buffer; streaming and random-access readers are layered on top elsewhere.
 *
 * @example Read keywords from a primary header
 * ```ts
 * import { parseHeader } from "@fits-js/core";
 *
 * const { header, byteLength } = parseHeader(bytes);
 * header.getNumber("NAXIS"); // 2
 * header.getString("OBJECT"); // "M51"
 * // pixel data begins at byteLength
 * ```
 *
 * @see [FITS Standard v4.0 §4: Headers](https://fits.gsfc.nasa.gov/fits_standard.html)
 */
export function parseHeader(
  bytes: Uint8Array,
  options: ParseHeaderOptions = {},
): ParseHeaderResult {
  if (!(bytes instanceof Uint8Array)) {
    throw new FitsHeaderError("parseHeader requires a Uint8Array");
  }
  const strict = options.strict ?? false;
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  if (bytes.length < BLOCK) {
    const msg = `header shorter than one 2880-byte block (${bytes.length} bytes)`;
    if (strict) throw new FitsHeaderError(msg);
    warn(msg);
  }

  const cards: HeaderCard[] = [];
  let cardIndex = 0;
  let offset = 0;
  let ended = false;

  // Continuation accumulator for the CONTINUE long-string convention.
  let pending: { card: HeaderCard; body: string; comment: string; continued: boolean } | undefined;

  const flushPending = () => {
    if (!pending) return;
    // No CONTINUE followed: the trailing & was not a sentinel, keep the
    // card's literal value.
    if (pending.continued) {
      cards.push({
        ...pending.card,
        value: rstripSpaces(pending.body),
        comment: pending.comment || undefined,
      });
    } else {
      cards.push(pending.card);
    }
    pending = undefined;
  };

  outer: while (offset + CARD <= bytes.length) {
    const blockEnd = Math.min(offset + BLOCK, bytes.length);
    for (; offset + CARD <= blockEnd; offset += CARD, cardIndex++) {
      const raw80 = latin1.decode(bytes.subarray(offset, offset + CARD));
      const keyword = raw80.slice(0, 8).trim().toUpperCase();
      const ctx: CardParseContext = { cardIndex, strict, warn };

      if (keyword === "END") {
        flushPending();
        ended = true;
        offset += CARD;
        break outer;
      }

      if (pending && keyword === "CONTINUE") {
        const cont = parseContinuation(raw80.slice(8), ctx);
        pending.continued = true;
        pending.body += cont.body;
        if (cont.comment) {
          pending.comment = pending.comment ? `${pending.comment} ${cont.comment}` : cont.comment;
        }
        if (!cont.continues) flushPending();
        continue;
      }

      flushPending();

      const parsed = parseCard(raw80, ctx);
      if (parsed.continues && parsed.stringBody !== undefined) {
        pending = {
          card: parsed.card,
          body: parsed.stringBody,
          comment: parsed.card.comment ?? "",
          continued: false,
        };
      } else {
        cards.push(parsed.card);
      }
    }
    // Advance to the next block boundary if the loop stopped mid-block.
    offset = blockEnd;
  }

  flushPending();

  if (!ended) {
    const msg = "no END card found before end of input";
    if (strict) throw new FitsHeaderError(msg);
    warn(msg);
  }

  const byteLength = Math.ceil(offset / BLOCK) * BLOCK;
  return { header: new FitsHeader(cards), byteLength, warnings };
}
