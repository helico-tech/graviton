// Goldens were produced by running hashF64/updateFloat64 from
// docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs directly
// in node, so the port below is proven equal to the reference (see
// docs/evidence/GRV-0004/README.md).
import { describe, expect, test } from 'vitest';
import { createHash, digest, updateFloat64, updateFloat64Array, updateWord } from './hash.ts';

function hashOf(values: number[]): string {
  const state = createHash();
  updateFloat64Array(state, Float64Array.from(values));
  return digest(state);
}

describe('hash', () => {
  test('matches the reference golden for a fixed input', () => {
    expect(hashOf([1, 2, 3, 4])).toBe('b1b97165225664b3');
  });

  test('-0 hashes the same as +0', () => {
    expect(hashOf([1, -0, 3.5, 1e11])).toBe('10f55b836550e295');
    expect(hashOf([1, -0, 3.5, 1e11])).toBe(hashOf([1, 0, 3.5, 1e11]));
  });

  test('NaN always throws', () => {
    const state = createHash();
    expect(() => updateFloat64(state, NaN)).toThrow();
  });

  test('swapping two values changes the hash', () => {
    expect(hashOf([2, 1, 3, 4])).toBe('eb19716532f664b3');
    expect(hashOf([1, 2, 3, 4])).not.toBe(hashOf([2, 1, 3, 4]));
  });

  test('is reproducible for the same input', () => {
    expect(hashOf([1, 2, 3, 4])).toBe(hashOf([1, 2, 3, 4]));
  });

  test('updateFloat64Array respects an explicit length, hashing only the live prefix', () => {
    const state = createHash();
    const buffer = Float64Array.from([1, 2, 3, 4, 999, 999]);
    updateFloat64Array(state, buffer, 4);
    expect(digest(state)).toBe(hashOf([1, 2, 3, 4]));
  });

  test('updateWord mixes an integer word (tick counter, rng word) into the hash', () => {
    const withTick = createHash();
    updateFloat64Array(withTick, Float64Array.from([1, 2, 3, 4]));
    updateWord(withTick, 100);

    const withOtherTick = createHash();
    updateFloat64Array(withOtherTick, Float64Array.from([1, 2, 3, 4]));
    updateWord(withOtherTick, 101);

    expect(digest(withTick)).not.toBe(digest(withOtherTick));
    expect(digest(withTick)).not.toBe(hashOf([1, 2, 3, 4]));
  });
});
