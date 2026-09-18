import { describe, expect, test } from 'vitest';
import { TICK_BUDGET_PER_FRAME, easedWarpValue, effectiveTicksThisFrame } from './loop.ts';

describe('effectiveTicksThisFrame', () => {
  test('rungs under the budget pass through unclamped', () => {
    expect(effectiveTicksThisFrame(0)).toBe(0);
    expect(effectiveTicksThisFrame(1)).toBe(1);
    expect(effectiveTicksThisFrame(2)).toBe(10);
    expect(effectiveTicksThisFrame(3)).toBe(100);
  });

  test('rungs over the budget clamp to the budget, not the nominal rate', () => {
    expect(effectiveTicksThisFrame(4)).toBe(TICK_BUDGET_PER_FRAME); // nominal 1000
    expect(effectiveTicksThisFrame(5)).toBe(TICK_BUDGET_PER_FRAME); // nominal 10000
  });
});

describe('easedWarpValue', () => {
  test('is exactly from at elapsed 0', () => {
    expect(easedWarpValue({ from: 1, to: 10000, elapsedMs: 0 })).toBe(1);
  });

  test('is exactly to at the full duration', () => {
    expect(easedWarpValue({ from: 1, to: 10000, elapsedMs: 150 })).toBe(10000);
  });

  test('is linear at the midpoint', () => {
    expect(easedWarpValue({ from: 0, to: 100, elapsedMs: 75, durationMs: 150 })).toBe(50);
  });

  test('clamps at to past the duration, never overshoots', () => {
    expect(easedWarpValue({ from: 0, to: 100, elapsedMs: 500, durationMs: 150 })).toBe(100);
  });

  test('clamps at from before elapsed 0', () => {
    expect(easedWarpValue({ from: 10, to: 0, elapsedMs: -5, durationMs: 150 })).toBe(10);
  });
});
