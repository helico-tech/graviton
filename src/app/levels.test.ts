import { describe, expect, test } from 'vitest';
import { getLevel, levelIds } from './levels.ts';

describe('levels registry', () => {
  test('levelIds is sorted and includes the campaign level', () => {
    const ids = levelIds();
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain('L01-intercept');
  });

  test('getLevel resolves a bundled id to its compiled level', () => {
    const level = getLevel('L01-intercept');
    expect(level?.id).toBe('L01-intercept');
    expect(level?.name).toBe('Intercept');
    expect(level?.scenario.dt).toBeGreaterThan(0);
  });

  test('getLevel returns undefined for an unknown id', () => {
    expect(getLevel('nope')).toBeUndefined();
  });
});
