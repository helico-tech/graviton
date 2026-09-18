import { describe, expect, test } from 'vitest';
import { getSolution } from './solutions.ts';

describe('solutions registry', () => {
  test('getSolution resolves L01-intercept to its committed command log', () => {
    const solution = getSolution('L01-intercept');
    expect(solution?.level).toBe('L01-intercept');
    expect(solution?.log.length).toBeGreaterThan(0);
    expect(solution?.log[0]!.kind).toBe('launch');
    expect(solution?.ticks).toBeGreaterThan(0);
  });

  test('getSolution returns undefined for a level with no committed solution', () => {
    expect(getSolution('nope')).toBeUndefined();
  });
});
