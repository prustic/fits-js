/** Base class for every error thrown by `@fits-js/core`. */
export class FitsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A header could not be parsed, or violated the FITS standard while parsing
 * in strict mode. Carries enough context to locate the offending card.
 */
export class FitsHeaderError extends FitsError {
  /** Zero-based index of the card within the header, when known. */
  readonly cardIndex?: number;
  /** Keyword of the offending card, when known. */
  readonly keyword?: string;
  /** The raw 80-character card image, when known. */
  readonly rawCard?: string;

  constructor(
    message: string,
    context?: {
      cardIndex?: number;
      keyword?: string;
      rawCard?: string;
      cause?: unknown;
    },
  ) {
    super(message, context?.cause === undefined ? undefined : { cause: context.cause });
    this.cardIndex = context?.cardIndex;
    this.keyword = context?.keyword;
    this.rawCard = context?.rawCard;
  }
}
