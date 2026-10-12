/** @internal Pack 0/1 bytes into an LSB-first bitmap, Arrow's Bool layout. */
export function packBits(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array((bytes.length + 7) >> 3);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      out[i >> 3] |= 1 << (i & 7);
    }
  }

  return out;
}

/**
 * @internal Turn a FITS null mask (one byte per element, 1 = undefined) into
 * an Arrow validity bitmap (one bit per element, 1 = valid).
 */
export function validityBitmap(mask: Uint8Array): { bitmap: Uint8Array; nullCount: number } {
  const bitmap = new Uint8Array((mask.length + 7) >> 3);
  let nullCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) {
      bitmap[i >> 3] |= 1 << (i & 7);
    } else {
      nullCount++;
    }
  }

  return { bitmap, nullCount };
}

/**
 * @internal Validity for float values, grouped `width` at a time: an element
 * is null when any of its values is NaN, which FITS defines as null for
 * float and complex columns (§7.3.3.1), or when `mask` marks it. Returns
 * undefined when nothing is null, so the common case allocates nothing.
 */
export function floatValidity(
  values: Float32Array | Float64Array,
  width: 1 | 2,
  mask?: Uint8Array,
): { bitmap: Uint8Array; nullCount: number } | undefined {
  const length = values.length / width;
  let bitmap: Uint8Array | undefined;
  let nullCount = 0;

  for (let i = 0; i < length; i++) {
    let isNull = false;
    for (let k = i * width; k < (i + 1) * width; k++) {
      // NaN is the only value not equal to itself.
      if (values[k] !== values[k] || (mask !== undefined && mask[k] !== 0)) {
        isNull = true;
      }
    }
    if (!isNull) {
      continue;
    }

    if (bitmap === undefined) {
      bitmap = new Uint8Array((length + 7) >> 3).fill(0xff);
      if (length & 7) {
        bitmap[bitmap.length - 1] = (1 << (length & 7)) - 1;
      }
    }
    bitmap[i >> 3] &= ~(1 << (i & 7));
    nullCount++;
  }

  return bitmap === undefined ? undefined : { bitmap, nullCount };
}
