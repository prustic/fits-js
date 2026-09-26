const MAX_BYTES = 2 ** 31 - 1;

/** @internal UTF-8 length of `s`; a lone surrogate encodes as U+FFFD. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else {
      n += 3;
    }
  }

  return n;
}

/**
 * @internal Encode strings into Arrow's Utf8 layout: one byte buffer and
 * `length + 1` Int32 offsets. Sized in one pass so the buffer is allocated
 * once.
 */
export function encodeUtf8(strings: readonly string[]): { offsets: Int32Array; bytes: Uint8Array } {
  const offsets = new Int32Array(strings.length + 1);
  let total = 0;
  for (let i = 0; i < strings.length; i++) {
    total += utf8Length(strings[i]);
    if (total > MAX_BYTES) {
      throw new RangeError(
        `string column exceeds ${MAX_BYTES} UTF-8 bytes; read fewer rows, for example with readArrowBatches`,
      );
    }
    offsets[i + 1] = total;
  }

  const bytes = new Uint8Array(total);
  const encoder = new TextEncoder();
  for (let i = 0; i < strings.length; i++) {
    encoder.encodeInto(strings[i], bytes.subarray(offsets[i], offsets[i + 1]));
  }

  return { offsets, bytes };
}
