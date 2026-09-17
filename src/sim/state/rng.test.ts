// Goldens were produced by running makeStream/sfc32 from
// docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs directly
// in node, so the port below is proven equal to the reference (see
// docs/evidence/GRV-0004/README.md).
import { describe, expect, test } from 'vitest';
import { createStream, drawU32, drawUnit } from './rng.ts';

function firstDraws(seed: number, name: string, n: number): string[] {
  const stream = createStream({ seed, name });
  const draws: string[] = [];
  for (let i = 0; i < n; i++) draws.push(drawU32(stream).toString(16).padStart(8, '0'));
  return draws;
}

describe('rng', () => {
  test('matches the reference golden for the first draws of a named stream', () => {
    expect(firstDraws(0xc0ffee, 'debris_ejection', 4)).toEqual([
      '094de769',
      '08f34cb7',
      'deffc941',
      '1db7dd01',
    ]);
  });

  test('a different name is an independent stream from the same seed', () => {
    expect(firstDraws(0xc0ffee, 'sensor_noise', 4)).toEqual([
      '121bd350',
      '3dc08811',
      'ecc441bc',
      'a5702c31',
    ]);
  });

  test('the same seed and name reproduce the same sequence', () => {
    expect(firstDraws(1, 'hazard_onset', 8)).toEqual(firstDraws(1, 'hazard_onset', 8));
  });

  test('a stream restored from its four saved words continues identically', () => {
    const stream = createStream({ seed: 7, name: 'restore_check' });
    drawU32(stream);
    drawU32(stream);
    drawU32(stream);
    const saved = Uint32Array.from(stream);

    const continuedOriginal = [drawU32(stream), drawU32(stream)];
    const restored = Uint32Array.from(saved);
    const continuedRestored = [drawU32(restored), drawU32(restored)];

    expect(continuedRestored).toEqual(continuedOriginal);
  });

  test('float draws stay in [0, 1)', () => {
    const stream = createStream({ seed: 1, name: 'range_check' });
    for (let i = 0; i < 200_000; i++) {
      const value = drawUnit(stream);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
