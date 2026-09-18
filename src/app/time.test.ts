// Time formatting (GAME-0001 §4.11, GAME-0002 §8): T+dd:hh:mm:ss from integer tick*dt arithmetic,
// never wall time (docs/domain/simulation-determinism.md rule 1).
import { describe, expect, test } from 'vitest';
import { formatSimTime } from './time.ts';

describe('formatSimTime', () => {
  test('tick 0 is all zeroes', () => {
    expect(formatSimTime({ tick: 0, dt: 30 })).toBe('T+00:00:00:00');
  });

  test('59 seconds stays under a minute', () => {
    expect(formatSimTime({ tick: 59, dt: 1 })).toBe('T+00:00:00:59');
  });

  test('exact minute boundary at dt=30', () => {
    expect(formatSimTime({ tick: 2, dt: 30 })).toBe('T+00:00:01:00');
  });

  test('exact hour boundary at dt=30', () => {
    expect(formatSimTime({ tick: 120, dt: 30 })).toBe('T+00:01:00:00');
  });

  test('exact day boundary at dt=60', () => {
    expect(formatSimTime({ tick: 1440, dt: 60 })).toBe('T+01:00:00:00');
  });

  test('several days, hours, minutes and seconds together at dt=60', () => {
    // 4 days 12h 33m 8s, matching GAME-0002 §8's own mockup value.
    const totalSeconds = 4 * 86400 + 12 * 3600 + 33 * 60 + 8;
    expect(formatSimTime({ tick: totalSeconds / 60, dt: 60 })).toBe('T+04:12:33:08');
  });
});
