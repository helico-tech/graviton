import { describe, expect, test } from 'vitest';
import { WARP_LADDER, clampRung, stepRung, ticksPerFrame, togglePause } from './warp.ts';

describe('ticksPerFrame', () => {
  test('reads the ladder by rung', () => {
    expect(ticksPerFrame(0)).toBe(0);
    expect(ticksPerFrame(1)).toBe(1);
    expect(ticksPerFrame(5)).toBe(10000);
  });
});

describe('clampRung', () => {
  test('clamps below zero to the paused rung', () => {
    expect(clampRung(-3)).toBe(0);
  });

  test('clamps above the top rung to the top rung', () => {
    expect(clampRung(99)).toBe(WARP_LADDER.length - 1);
  });

  test('passes a valid rung through unchanged', () => {
    expect(clampRung(2)).toBe(2);
  });
});

describe('stepRung', () => {
  test('moves one rung up or down', () => {
    expect(stepRung(2, 1)).toBe(3);
    expect(stepRung(2, -1)).toBe(1);
  });

  test('clamps at the paused end', () => {
    expect(stepRung(0, -1)).toBe(0);
  });

  test('clamps at the fastest end', () => {
    const top = WARP_LADDER.length - 1;
    expect(stepRung(top, 1)).toBe(top);
  });
});

describe('togglePause', () => {
  test('pauses from any non-zero rung', () => {
    expect(togglePause(3, 3)).toBe(0);
  });

  test('resumes at the last non-zero rung, not always 1x', () => {
    expect(togglePause(0, 4)).toBe(4);
  });
});
