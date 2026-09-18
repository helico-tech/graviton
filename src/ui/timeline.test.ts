// markFraction is the one part of the timeline strip that's a pure function (GRV-0023 acceptance
// "timeline mark placement (pure function from ticks to x fractions)"); DOM assembly around it is
// covered by tests/e2e/selection.spec.ts, which can read the real positioned elements.
import { describe, expect, test } from 'vitest';
import { markFraction } from './timeline.ts';

describe('markFraction', () => {
  test.each([
    [0, 100, 0],
    [50, 100, 0.5],
    [100, 100, 1],
    [-10, 100, 0], // clamps below the range's start
    [150, 100, 1], // clamps past the range's end
  ])('tick %d of %d ticks -> %d', (tick, rangeTicks, expected) => {
    expect(markFraction({ tick, rangeTicks })).toBeCloseTo(expected);
  });

  test('a zero-length range never divides by zero', () => {
    expect(markFraction({ tick: 0, rangeTicks: 0 })).toBe(0);
  });
});
