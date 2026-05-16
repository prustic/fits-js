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

/**
 * The HDU structure is invalid or unsupported: a missing `SIMPLE`,
 * truncated data unit, or the deprecated random-groups format.
 */
export class FitsStructureError extends FitsError {
  /** Zero-based index of the offending HDU, when known. */
  readonly hduIndex?: number;

  constructor(message: string, context?: { hduIndex?: number; cause?: unknown }) {
    super(message, context?.cause === undefined ? undefined : { cause: context.cause });
    this.hduIndex = context?.hduIndex;
  }
}

/**
 * A conforming FITS construct that this library deliberately does not
 * implement (for example the deprecated random-groups format). Distinct
 * from {@link FitsStructureError}: the input is valid, the support is not
 * here. Thrown unconditionally, not gated by strict mode.
 */
export class FitsUnsupportedError extends FitsError {
  readonly hduIndex?: number;

  constructor(message: string, context?: { hduIndex?: number; cause?: unknown }) {
    super(message, context?.cause === undefined ? undefined : { cause: context.cause });
    this.hduIndex = context?.hduIndex;
  }
}
