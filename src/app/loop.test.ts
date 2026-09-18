import { describe, expect, test } from 'vitest';
import {
  TICK_BUDGET_PER_FRAME,
  WARP_EASE_MS,
  easedWarpValue,
  effectiveTicksThisFrame,
  warpEaseFrame,
} from './loop.ts';

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

// Real requestAnimationFrame samples at irregular, non-multiple-of-anything intervals -- nothing
// guarantees a frame lands exactly on WARP_EASE_MS. These are representative real-frame-like
// spacings (roughly 60fps, with one delayed frame) that straddle the 150ms boundary without ever
// landing on it exactly.
const FRAME_ELAPSED_MS = [0, 16.7, 33.1, 51, 149.9, 150, 166];

/** docs/issues/2026-09-18-warp-label-sticks-on-eased-value.md: a faithful extraction of main.ts's
 *  per-frame branch as it shipped in GRV-0023/EPIC-05 -- write `round(easedWarpValue(...))` while
 *  `elapsed < WARP_EASE_MS`, then simply stop writing, on the assumption that the last write had
 *  already landed on the target. It hadn't: no frame in a real, irregularly-spaced sequence needs
 *  to land inside the (149.9, 150) window, so the label sticks on whatever fraction the last frame
 *  before the boundary happened to compute. */
function oldLoopFinalLabel({ from, to }: { from: number; to: number }): number {
  let label = from;
  for (const elapsed of FRAME_ELAPSED_MS) {
    if (elapsed < WARP_EASE_MS) {
      label = Math.round(easedWarpValue({ from, to, elapsedMs: elapsed }));
    } else {
      break; // old code: warpAnim cleared here, nothing written this frame or after
    }
  }
  return label;
}

describe('the old per-frame branch (reproduces the shipped bug)', () => {
  test('does not land on the target for a 10000x -> 0x jump at irregular frame spacing', () => {
    expect(oldLoopFinalLabel({ from: 10000, to: 0 })).not.toBe(0);
  });

  test('does not land on the target for a 0x -> 10000x jump at irregular frame spacing', () => {
    expect(oldLoopFinalLabel({ from: 0, to: 10000 })).not.toBe(10000);
  });
});

describe('warpEaseFrame', () => {
  test('is not finished, and reads the live interpolation, before the duration elapses', () => {
    expect(warpEaseFrame({ from: 0, to: 100, elapsedMs: 75, durationMs: 150 })).toEqual({
      value: 50,
      finished: false,
    });
  });

  test('is finished and exactly the target at the duration', () => {
    expect(warpEaseFrame({ from: 0, to: 100, elapsedMs: 150, durationMs: 150 })).toEqual({
      value: 100,
      finished: true,
    });
  });

  test('is finished and exactly the target past the duration, however far a frame overshoots it', () => {
    expect(warpEaseFrame({ from: 0, to: 100, elapsedMs: 500, durationMs: 150 })).toEqual({
      value: 100,
      finished: true,
    });
  });

  /** The same per-frame loop as `oldLoopFinalLabel`, but always writing whatever `warpEaseFrame`
   *  returns and stopping only once it reports `finished` -- the fixed main.ts contract. */
  function finalLabel({ from, to }: { from: number; to: number }): number {
    let label = from;
    for (const elapsed of FRAME_ELAPSED_MS) {
      const frame = warpEaseFrame({ from, to, elapsedMs: elapsed });
      label = Math.round(frame.value);
      if (frame.finished) break;
    }
    return label;
  }

  test('lands exactly on the target for a 10000x -> 0x jump at irregular frame spacing', () => {
    expect(finalLabel({ from: 10000, to: 0 })).toBe(0);
  });

  test('lands exactly on the target for a 0x -> 10000x jump at irregular frame spacing', () => {
    expect(finalLabel({ from: 0, to: 10000 })).toBe(10000);
  });
});
