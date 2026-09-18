// markFraction and computeUplinkWindows are the timeline strip's own pure functions (GRV-0023
// acceptance "timeline mark placement (pure function from ticks to x fractions)"; GRV-0031's own
// uplink-availability band); DOM assembly around them is covered by tests/e2e/selection.spec.ts and
// tests/e2e/horizon.spec.ts, which can read the real positioned elements.
import { describe, expect, test } from 'vitest';
import { computeUplinkWindows, markFraction } from './timeline.ts';
import { createSim } from '../sim/sim.ts';
import type { Scenario } from '../sim/sim.ts';

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

describe('computeUplinkWindows', () => {
  // A post on a small primary at the origin and a single occluding body sitting on the +x axis at
  // (1e8, 0), radius 5e6 -- large enough, and slow-orbiting enough (mu 1, a 1e8: an enormous
  // period), to stay effectively fixed over the tiny tick range these tests sample. A path point
  // straight beyond the occluder from the post is blocked; one off to the side at the same range
  // is not -- confirmed directly against segmentBlocked before writing this fixture.
  function occluderScenario(): Scenario {
    return {
      dt: 1,
      capacity: 1,
      burnNodeCapacity: 0,
      bodies: [
        { parent: -1, mu: 1, radius: 1e6, rotationPeriod: 1e20, axialPhaseAtEpoch: 0 },
        {
          parent: 0,
          mu: 1,
          radius: 5e6,
          rotationPeriod: 1e20,
          axialPhaseAtEpoch: 0,
          a: 1e8,
          e: 0,
          argPeriapsis: 0,
          meanAnomaly0: 0,
        },
      ],
      rails: [],
      contacts: [],
      post: { host: 0, longitude: 0 },
      historyTicks: 16,
      probe: { dryMass: 1, propellantMass: 1, exhaustVelocity: 1, thrust: 1 },
      streams: [],
    };
  }

  test('finds exactly one blocked window where the path passes behind the occluder', () => {
    const sim = createSim({ scenario: occluderScenario(), seed: 1 });
    const path = Array.from({ length: 15 }, (_, tick) => {
      const behind = tick >= 5 && tick <= 9;
      return behind ? { tick, x: 2e8, y: 0 } : { tick, x: 1e8, y: 1e9 };
    });

    expect(computeUplinkWindows({ sim, path })).toEqual([{ startTick: 5, endTick: 9 }]);
  });

  test('an entirely clear path has no windows', () => {
    const sim = createSim({ scenario: occluderScenario(), seed: 1 });
    const path = Array.from({ length: 10 }, (_, tick) => ({ tick, x: 1e8, y: 1e9 }));
    expect(computeUplinkWindows({ sim, path })).toEqual([]);
  });

  test('a path still blocked at its own last sample leaves the window open-ended there', () => {
    const sim = createSim({ scenario: occluderScenario(), seed: 1 });
    const path = Array.from({ length: 5 }, (_, tick) => ({ tick: tick + 5, x: 2e8, y: 0 }));
    expect(computeUplinkWindows({ sim, path })).toEqual([{ startTick: 5, endTick: 9 }]);
  });

  test('an empty path has no windows', () => {
    const sim = createSim({ scenario: occluderScenario(), seed: 1 });
    expect(computeUplinkWindows({ sim, path: [] })).toEqual([]);
  });
});
