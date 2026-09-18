// Tests for the position/velocity history ring buffer (ADR-0007 §7, research §5.4). Math.* is
// fine here -- tests are exempt from src/sim's determinism lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import {
  createHistoryBuffer,
  firstAvailableTick,
  NEVER_RECORDED,
  recordHistory,
  sampleState,
} from './history.ts';

const DT = 60;

describe('recordHistory / firstAvailableTick', () => {
  test('an object never written reports NEVER_RECORDED', () => {
    const h = createHistoryBuffer({ objectCapacity: 2, historyTicks: 4 });
    expect(firstAvailableTick(h, 0)).toBe(NEVER_RECORDED);
  });

  test('before the ring wraps, firstAvailableTick is the launch tick', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 4 });
    recordHistory({ history: h, object: 0, tick: 10, x: 1, y: 0, vx: 0, vy: 0 });
    recordHistory({ history: h, object: 0, tick: 11, x: 2, y: 0, vx: 0, vy: 0 });
    expect(firstAvailableTick(h, 0)).toBe(10);
    expect(h.lastTick[0]).toBe(11);
  });

  test('once the ring wraps, firstAvailableTick becomes the oldest still-retained tick', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 4 });
    for (let t = 0; t < 10; t++) {
      recordHistory({ history: h, object: 0, tick: t, x: t, y: 0, vx: 1, vy: 0 });
    }
    // 4 slots retained, last write at tick 9: oldest retained is 9 - 4 + 1 = 6.
    expect(firstAvailableTick(h, 0)).toBe(6);
    expect(h.lastTick[0]).toBe(9);
  });

  test('a wrapped ring reads back only the retained window correctly', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 4 });
    for (let t = 0; t < 10; t++) {
      recordHistory({ history: h, object: 0, tick: t, x: t * 100, y: 0, vx: 1, vy: 0 });
    }
    // Ticks 6, 7, 8, 9 remain; sampling exactly at a retained integer tick returns that value.
    const s = sampleState({ history: h, object: 0, t: 7 * DT, dt: DT });
    expect(s.x).toBeCloseTo(700, 9);
  });

  test('sampleState throws for a tick before the object existed', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 8 });
    recordHistory({ history: h, object: 0, tick: 5, x: 0, y: 0, vx: 0, vy: 0 });
    recordHistory({ history: h, object: 0, tick: 6, x: 1, y: 0, vx: 0, vy: 0 });
    expect(() => sampleState({ history: h, object: 0, t: 4 * DT, dt: DT })).toThrow();
  });

  test('sampleState throws for a tick outside the retained (wrapped) window', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 4 });
    for (let t = 0; t < 10; t++) {
      recordHistory({ history: h, object: 0, tick: t, x: t, y: 0, vx: 1, vy: 0 });
    }
    expect(() => sampleState({ history: h, object: 0, t: 2 * DT, dt: DT })).toThrow();
  });

  test('sampleState throws past the last recorded tick', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 8 });
    recordHistory({ history: h, object: 0, tick: 0, x: 0, y: 0, vx: 0, vy: 0 });
    expect(() => sampleState({ history: h, object: 0, t: 5 * DT, dt: DT })).toThrow();
  });

  // GRV-0030, docs/issues/2026-09-18-downlink-emission-throws-at-current-tick.md: `t` landing
  // exactly on the most recently recorded tick used to throw here even though it needs no "next"
  // sample -- cubic Hermite at s=0 depends only on the t0 endpoint (h01/h11 are both 0 there), and
  // `sim.ts`'s `advance` always leaves `history.lastTick[object] === sim.tick`, so this is not a
  // corner case: it is what every "what do we see right now" query looks like.
  test('sampleState at exactly the last recorded tick returns that sample, without needing a later one', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 8 });
    recordHistory({ history: h, object: 0, tick: 5, x: 10, y: 20, vx: 3, vy: -4 });
    recordHistory({ history: h, object: 0, tick: 6, x: 13, y: 16, vx: 3, vy: -4 });
    const s = sampleState({ history: h, object: 0, t: 6 * DT, dt: DT });
    expect(s).toEqual({ x: 13, y: 16, vx: 3, vy: -4 });
  });
});

describe('sampleState: cubic Hermite interpolation', () => {
  test('is exact for constant-velocity motion (the cruise case)', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 8 });
    const vx = 1234.5;
    const vy = -876.25;
    for (let t = 0; t <= 4; t++) {
      recordHistory({ history: h, object: 0, tick: t, x: vx * t * DT, y: vy * t * DT, vx, vy });
    }
    for (const frac of [0, 0.1, 0.37, 0.5, 0.83, 1]) {
      const t = (2 + frac) * DT;
      const s = sampleState({ history: h, object: 0, t, dt: DT });
      expect(s.x).toBeCloseTo(vx * t, 6);
      expect(s.y).toBeCloseTo(vy * t, 6);
      expect(s.vx).toBeCloseTo(vx, 9);
      expect(s.vy).toBeCloseTo(vy, 9);
    }
  });

  test('reproduces the bracketing samples exactly at integer ticks', () => {
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 8 });
    const xs = [0, 5, 3, 9, 2];
    const vxs = [1, -2, 4, -1, 0.5];
    for (let t = 0; t < xs.length; t++) {
      recordHistory({ history: h, object: 0, tick: t, x: xs[t]!, y: 0, vx: vxs[t]!, vy: 0 });
    }
    // Up to, but not including, the last recorded tick: sampleState needs a bracketing pair
    // (t0, t0+1), so the very last tick has no "next" sample to interpolate against.
    for (let t = 0; t < xs.length - 1; t++) {
      const s = sampleState({ history: h, object: 0, t: t * DT, dt: DT });
      expect(s.x).toBeCloseTo(xs[t]!, 9);
      expect(s.vx).toBeCloseTo(vxs[t]!, 9);
    }
  });

  test('interpolates a curved (accelerating) trajectory closely between samples', () => {
    // x(t) = 0.5*a*t^2, a smooth curve recorded only at tick boundaries -- Hermite (cubic, using
    // the recorded velocity as the tangent) should track it far more closely than a linear lerp
    // would over one tick.
    const h = createHistoryBuffer({ objectCapacity: 1, historyTicks: 8 });
    const a = 2.5;
    const trueX = (t: number) => 0.5 * a * t * t;
    const trueVx = (t: number) => a * t;
    for (let tick = 0; tick <= 4; tick++) {
      const t = tick * DT;
      recordHistory({ history: h, object: 0, tick, x: trueX(t), y: 0, vx: trueVx(t), vy: 0 });
    }
    const tMid = 2.5 * DT;
    const s = sampleState({ history: h, object: 0, t: tMid, dt: DT });
    // Cubic Hermite matching position+velocity at both ends is exact for a quadratic -- x(t) here
    // is quadratic in t, so the interpolated value should match to numerical precision.
    expect(s.x).toBeCloseTo(trueX(tMid), 6);
    expect(s.vx).toBeCloseTo(trueVx(tMid), 6);
  });
});
