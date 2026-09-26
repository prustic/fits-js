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
