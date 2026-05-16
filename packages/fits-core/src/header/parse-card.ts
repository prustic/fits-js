import { FitsHeaderError } from "../errors.js";
import type { HeaderCard, HeaderValue } from "./card.js";

const COMMENTARY_KEYWORDS = new Set(["COMMENT", "HISTORY", ""]);

/** @internal */
export interface ParsedCard {
  readonly card: HeaderCard;
  readonly stringBody?: string;
  /** String value continues into a following CONTINUE card. */
  readonly continues: boolean;
}

/** @internal */
export interface CardParseContext {
  readonly cardIndex: number;
  readonly strict: boolean;
  readonly warn: (message: string) => void;
}

/** @internal */
export function rstripSpaces(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x20) end--;
  return end === s.length ? s : s.slice(0, end);
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

function reject(ctx: CardParseContext, keyword: string, raw: string, message: string): void {
  if (ctx.strict) {
    throw new FitsHeaderError(message, {
      cardIndex: ctx.cardIndex,
      keyword,
      rawCard: raw,
    });
  }
  ctx.warn(message);
}

/** FITS keywords are uppercase A-Z, digit, hyphen, underscore (no spaces). */
function isStandardKeyword(field8: string): boolean {
  const k = field8.trimEnd();
  if (k.length === 0) return true;
  for (const ch of k) {
    const c = ch.charCodeAt(0);
    const ok = (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || ch === "-" || ch === "_";
    if (!ok) return false;
  }
  return true;
}

/**
 * Parse a FITS numeric literal. Returns its value and whether it was
 * integral, or undefined when `token` is not a well-formed number spanning
 * its whole length.
 */
function scanNumber(token: string): { value: number; integral: boolean } | undefined {
  let i = 0;
  const n = token.length;
  if (n === 0) return undefined;
  if (token[i] === "+" || token[i] === "-") i++;
  let sawDigit = false;
  while (i < n && isDigit(token.charCodeAt(i))) {
    i++;
    sawDigit = true;
  }
  let integral = true;
  if (i < n && token[i] === ".") {
    integral = false;
    i++;
    while (i < n && isDigit(token.charCodeAt(i))) {
      i++;
      sawDigit = true;
    }
  }
  if (!sawDigit) return undefined;
  let normalized = token;
  if (i < n) {
    const e = token[i];
    if (e === "e" || e === "E" || e === "d" || e === "D") {
      integral = false;
      // D is the Fortran double spelling of the E exponent.
      normalized = token.slice(0, i) + "e" + token.slice(i + 1);
      i++;
      if (i < n && (token[i] === "+" || token[i] === "-")) i++;
      let expDigit = false;
      while (i < n && isDigit(token.charCodeAt(i))) {
        i++;
        expDigit = true;
      }
      if (!expDigit) return undefined;
    }
  }
  if (i !== n) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? { value, integral } : undefined;
}

function classifyScalar(
  token: string,
  ctx: CardParseContext,
  keyword: string,
  raw: string,
): HeaderValue {
  if (token === "") return undefined;
  if (token === "T") return true;
  if (token === "F") return false;

  if (token[0] === "(" && token[token.length - 1] === ")") {
    const comma = token.indexOf(",");
    if (comma > 0) {
      const re = scanNumber(token.slice(1, comma).trim());
      const im = scanNumber(token.slice(comma + 1, -1).trim());
      if (re && im) return { real: re.value, imag: im.value };
    }
  }

  const num = scanNumber(token);
  if (num) {
    if (num.integral && !Number.isSafeInteger(num.value)) return BigInt(token);
    return num.value;
  }

  reject(
    ctx,
    keyword,
    raw,
    `non-standard value for ${keyword || "(blank)"}: ${JSON.stringify(token)}`,
  );
  return token;
}

type Field =
  | { kind: "string"; value: string; comment?: string; terminated: boolean }
  | { kind: "scalar"; text: string; comment?: string };

/** Split a value field into a typed value and an optional comment. */
function splitField(field: string): Field {
  if (field[0] === "'") {
    let value = "";
    let i = 1;
    let terminated = false;
    for (; i < field.length; i++) {
      if (field[i] !== "'") {
        value += field[i];
        continue;
      }
      // A doubled quote is a literal quote; a lone quote ends the string.
      if (field[i + 1] === "'") {
        value += "'";
        i++;
        continue;
      }
      i++;
      terminated = true;
      break;
    }
    const slash = field.slice(i).indexOf("/");
    return {
      kind: "string",
      value,
      comment: slash >= 0 ? field.slice(i + slash + 1).trim() : undefined,
      terminated,
    };
  }
  const slash = field.indexOf("/");
  if (slash >= 0) {
    return {
      kind: "scalar",
      text: field.slice(0, slash).trim(),
      comment: field.slice(slash + 1).trim(),
    };
  }
  return { kind: "scalar", text: field.trim() };
}

/**
 * Resolve a CONTINUE card body. The header walker stitches the returned
 * `body` onto the in-progress long string.
 *
 * @internal
 */
export function parseContinuation(
  text: string,
  ctx: CardParseContext,
): { body: string; continues: boolean; comment?: string } {
  const field = splitField(text.trim());
  if (field.kind !== "string") {
    reject(ctx, "CONTINUE", text, "CONTINUE card body is not a quoted string");
    return { body: "", continues: false };
  }
  if (!field.terminated) {
    reject(ctx, "CONTINUE", text, "unterminated string in CONTINUE card");
  }
  const trimmed = rstripSpaces(field.value);
  const continues = trimmed.endsWith("&");
  return {
    body: continues ? trimmed.slice(0, -1) : field.value,
    continues,
    comment: field.comment,
  };
}

/**
 * Parse one 80-character card. Continued strings are not stitched here; the
 * caller does that using `stringBody` / `continues`.
 *
 * @internal
 */
export function parseCard(raw80: string, ctx: CardParseContext): ParsedCard {
  const raw = rstripSpaces(raw80);
  const keywordField = raw80.slice(0, 8);
  const keyword = keywordField.trim().toUpperCase();

  if (keyword === "HIERARCH" && raw80.includes("=")) {
    const eq = raw80.indexOf("=");
    // astropy collapses runs of spaces between HIERARCH tokens to one.
    const hKeyword = raw80.slice(8, eq).trim().split(" ").filter(Boolean).join(" ");
    return finishValueCard(hKeyword, splitField(raw80.slice(eq + 1).trim()), ctx, raw);
  }

  if (COMMENTARY_KEYWORDS.has(keyword)) {
    return {
      card: { keyword, value: undefined, commentary: true, raw },
      continues: false,
    };
  }

  if (raw80[8] !== "=") {
    // A non-commentary keyword with no value indicator is malformed:
    // reject in strict, treat as commentary in lenient.
    reject(ctx, keyword, raw, `card has no value indicator: ${keyword}`);
    return {
      card: { keyword, value: undefined, commentary: true, raw },
      continues: false,
    };
  }

  if (!isStandardKeyword(keywordField)) {
    reject(ctx, keyword, raw, `non-standard keyword characters: ${keyword}`);
  }

  if (raw80.slice(8, 10) !== "= ") {
    reject(
      ctx,
      keyword,
      raw,
      `non-standard value indicator for ${keyword || "(blank)"} (expected "= " in columns 9-10)`,
    );
  }

  return finishValueCard(keyword, splitField(raw80.slice(9).trim()), ctx, raw);
}

function finishValueCard(
  keyword: string,
  field: Field,
  ctx: CardParseContext,
  raw: string,
): ParsedCard {
  if (field.kind === "string") {
    if (!field.terminated) {
      reject(ctx, keyword, raw, `unterminated string for ${keyword}`);
    }
    const inner = field.value;
    const trimmed = rstripSpaces(inner);
    const continues = trimmed.endsWith("&");
    // card.value is the literal standalone value (keeps a non-continuation
    // &, drops trailing blanks); stringBody is the join piece.
    return {
      card: {
        keyword,
        value: rstripSpaces(inner),
        comment: field.comment,
        commentary: false,
        raw,
      },
      stringBody: continues ? trimmed.slice(0, -1) : inner,
      continues,
    };
  }

  return {
    card: {
      keyword,
      value: classifyScalar(field.text, ctx, keyword, raw),
      comment: field.comment,
      commentary: false,
      raw,
    },
    continues: false,
  };
}
