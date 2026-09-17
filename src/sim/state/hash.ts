// FNV-1a-style twin-lane 32-bit word hash over raw double bits and raw
// integer words (ADR-0005 "Hash"). A test oracle for golden replay, not a
// portable or cryptographic hash, so iterating 32-bit words instead of bytes
// is fine.

const OFFSET_A = 0x811c9dc5 | 0;
const OFFSET_B = 0x01000193 | 0;
const PRIME_A = 0x01000193;
const PRIME_B = 0x85ebca6b;

const bits = new DataView(new ArrayBuffer(8));

export interface HashState {
  a: number;
  b: number;
}

export function createHash(): HashState {
  return { a: OFFSET_A, b: OFFSET_B };
}

/** Mixes one raw 32-bit word into both lanes: tick counters, rng words. */
export function updateWord(state: HashState, word: number): void {
  const w = word | 0;
  state.a = Math.imul(state.a ^ w, PRIME_A);
  state.b = Math.imul(state.b ^ w, PRIME_B);
}

/**
 * -0 hashes as +0 (two states equal in every comparison must hash equal).
 * NaN always throws, not just in a dev build: it has 2^52 distinct bit
 * patterns and arithmetic doesn't have to preserve which one, so a NaN loose
 * in the state would make golden replay flaky instead of failing loudly.
 */
export function updateFloat64(state: HashState, value: number): void {
  if (Number.isNaN(value)) {
    throw new Error('updateFloat64: cannot hash NaN');
  }
  const canonical = value === 0 ? 0 : value;
  bits.setFloat64(0, canonical);
  const hi = bits.getUint32(0) | 0;
  const lo = bits.getUint32(4) | 0;
  state.a = Math.imul(state.a ^ lo, PRIME_A);
  state.a = Math.imul(state.a ^ hi, PRIME_A);
  state.b = Math.imul(state.b ^ hi, PRIME_B);
  state.b = Math.imul(state.b ^ lo, PRIME_B);
}

export function updateFloat64Array(
  state: HashState,
  values: Float64Array,
  length: number = values.length,
): void {
  for (let i = 0; i < length; i++) {
    updateFloat64(state, values[i]!);
  }
}

export function digest(state: HashState): string {
  return toHex(state.a) + toHex(state.b);
}

function toHex(word: number): string {
  return (word >>> 0).toString(16).padStart(8, '0');
}
