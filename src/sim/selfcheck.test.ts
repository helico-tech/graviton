// Tests for the startup self-check (ADR-0005 "Startup self-check", research
// §8.4). Math.* is fine here -- tests are exempt from src/sim's determinism
// lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import { checkGoldenVector, KERNEL_GOLDEN, kernelGoldenVector, selfCheck } from './selfcheck.ts';

describe('kernelGoldenVector', () => {
  test('is reproducible', () => {
    expect(kernelGoldenVector()).toBe(kernelGoldenVector());
  });

  test('matches the stored constant', () => {
    expect(kernelGoldenVector()).toBe(KERNEL_GOLDEN);
  });
});

describe('checkGoldenVector', () => {
  test('passes against the real constant', () => {
    expect(() => checkGoldenVector(KERNEL_GOLDEN)).not.toThrow();
  });

  // Exposed as a plain function specifically so this is testable without
  // monkeypatching any kernel: a deliberately wrong expected value must
  // throw, and the thrown message must carry both hashes.
  test('throws with both hashes when the expected constant is wrong', () => {
    const wrong = 'deadbeefdeadbeef';
    expect(() => checkGoldenVector(wrong)).toThrow(wrong);
    expect(() => checkGoldenVector(wrong)).toThrow(KERNEL_GOLDEN);
  });
});

describe('selfCheck', () => {
  test('passes (and is idempotent, since createSim calls it unconditionally)', () => {
    expect(() => selfCheck()).not.toThrow();
    expect(() => selfCheck()).not.toThrow();
  });
});
