// Tests for finite burns with mass depletion (research §3.5-3.6, ADR-0005
// "Burns"), reference p11_burn.py. Math.* is fine here -- tests are exempt
// from src/sim's determinism lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import { createBodyTable } from '../ephemeris/bodies.ts';
import type { BodyTable } from '../ephemeris/bodies.ts';
import { startBurn } from './burn.ts';
import { createDynamicObjects, createStepScratch, stepTick } from './step.ts';
import type { DynamicObjects } from './step.ts';

const DT = 60;
const WET_MASS = 1500;
const DRY_MASS = 600;
const EXHAUST_VELOCITY = 30000;
const THRUST = 4000;
const MDOT = THRUST / EXHAUST_VELOCITY;
const BUDGET = EXHAUST_VELOCITY * Math.log(WET_MASS / DRY_MASS); // ~27488.72 m/s

// A body of negligible mass, placed far enough away that its gravity
// contributes nothing measurable over a burn's duration: mu/r^2 ~ 1e-26
// m/s^2 at r = 1e13 m, against deltas of at least 0.5 m/s over at most
// ~1700 s -- twelve-plus orders of magnitude under the 1e-9 relative bar.
// Chosen over an unburned-twin comparison (the alternative research §3.5
// suggests): a twin's path diverges from the burning probe's the moment
// the burn starts, so its gravity increments differ from the probe's too,
// leaving a second-order contamination the tiny-mu setup never introduces.
function farField(): BodyTable {
  return createBodyTable([
    { parent: -1, mu: 1, radius: 1, rotationPeriod: 86400, axialPhaseAtEpoch: 0 },
  ]);
}

interface ProbeArgs {
  prograde: number;
  lateral: number;
  initialVx?: number;
  initialVy?: number;
  wetMass?: number;
  dryMass?: number;
}

function seedProbe(
  objects: DynamicObjects,
  {
    prograde,
    lateral,
    initialVx = 5000,
    initialVy = 0,
    wetMass = WET_MASS,
    dryMass = DRY_MASS,
  }: ProbeArgs,
): { i: number; vx0: number; vy0: number } {
  const i = objects.count++;
  objects.x[i] = 1e13;
  objects.y[i] = 0;
  objects.vx[i] = initialVx;
  objects.vy[i] = initialVy;
  objects.hitBody[i] = -1;
  objects.mass[i] = wetMass;
  objects.dryMass[i] = dryMass;
  objects.thrust[i] = THRUST;
  objects.exhaustVelocity[i] = EXHAUST_VELOCITY;
  const vx0 = objects.vx[i]!;
  const vy0 = objects.vy[i]!;
  startBurn({ objects, index: i, prograde, lateral });
  return { i, vx0, vy0 };
}

/** Runs a single burning probe in free space until the burn ends (plus a
 *  margin of ticks), using the rocket equation to size the run so every
 *  target -- including tank-limited ones -- gets enough ticks. */
function runToCompletion(objects: DynamicObjects, dvRequested: number, margin = 5): void {
  const bodies = farField();
  const tBurn = Math.min(
    (WET_MASS / MDOT) * (1 - Math.exp(-dvRequested / EXHAUST_VELOCITY)),
    (WET_MASS - DRY_MASS) / MDOT,
  );
  const nTicks = Math.ceil(tBurn / DT) + margin;
  const scratch = createStepScratch({ bodies, dt: DT, capacity: objects.count });
  for (let tick = 0; tick < nTicks; tick++) {
    stepTick({ bodies, objects, tick, dt: DT, scratch });
  }
}

describe('startBurn', () => {
  test('throws on zero velocity', () => {
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    objects.vx[i] = 0;
    objects.vy[i] = 0;
    expect(() => startBurn({ objects, index: i, prograde: 10, lateral: 0 })).toThrow();
  });

  test('throws on a zero delta-v target', () => {
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    objects.vx[i] = 100;
    objects.vy[i] = 0;
    expect(() => startBurn({ objects, index: i, prograde: 0, lateral: 0 })).toThrow();
  });

  test('records target and delivered, arms burning', () => {
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    objects.vx[i] = 100;
    objects.vy[i] = 0;
    startBurn({ objects, index: i, prograde: 30, lateral: 40 });
    expect(objects.burnTarget[i]).toBeCloseTo(50, 12);
    expect(objects.burnDelivered[i]).toBe(0);
    expect(objects.burning[i]).toBe(1);
  });

  test('pure prograde freezes n along the velocity direction', () => {
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    objects.vx[i] = 300;
    objects.vy[i] = 400; // |v| = 500
    startBurn({ objects, index: i, prograde: 10, lateral: 0 });
    expect(objects.burnNx[i]).toBeCloseTo(300 / 500, 15);
    expect(objects.burnNy[i]).toBeCloseTo(400 / 500, 15);
  });

  test('pure lateral freezes n at +90 degrees, left of velocity', () => {
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    objects.vx[i] = 300;
    objects.vy[i] = 400; // |v| = 500, l = (-0.8, 0.6)
    startBurn({ objects, index: i, prograde: 0, lateral: 10 });
    expect(objects.burnNx[i]).toBeCloseTo(-400 / 500, 15);
    expect(objects.burnNy[i]).toBeCloseTo(300 / 500, 15);
  });
});

describe('delivered delta-v accuracy', () => {
  // research §3.6 / P11e's own table for reference, m_wet 1500 kg, m_dry
  // 600 kg, v_e 30 km/s, T 4 kN, dt 60 s.
  const targets = [0.5, 5, 50, 200, 1000, 5000];

  test.each(targets)(
    'target %s m/s delivered within 1e-9 relative, measured on the velocity',
    (dv) => {
      const objects = createDynamicObjects(1);
      const { i, vx0, vy0 } = seedProbe(objects, { prograde: dv, lateral: 0 });
      runToCompletion(objects, dv);

      expect(objects.burning[i]).toBe(0);
      const dvx = objects.vx[i]! - vx0;
      const dvy = objects.vy[i]! - vy0;
      const delivered = Math.sqrt(dvx * dvx + dvy * dvy);
      expect(Math.abs(delivered / dv - 1)).toBeLessThanOrEqual(1e-9);

      // The bookkeeping accumulator matches the actual velocity change too --
      // both are cut by the same analytic final stage.
      expect(Math.abs(objects.burnDelivered[i]! / dv - 1)).toBeLessThanOrEqual(1e-9);
    },
  );
});

describe('mass depletion', () => {
  test('final mass matches the rocket equation to 1e-9 relative', () => {
    const dv = 1000;
    const objects = createDynamicObjects(1);
    const { i } = seedProbe(objects, { prograde: dv, lateral: 0 });
    runToCompletion(objects, dv);

    const expected = WET_MASS * Math.exp(-dv / EXHAUST_VELOCITY);
    expect(Math.abs(objects.mass[i]! / expected - 1)).toBeLessThanOrEqual(1e-9);
  });
});

describe('tank-limited burn', () => {
  test('a request beyond the tank ends at dry mass, reports what was delivered', () => {
    const requested = 50000; // well past the ~27 489 m/s budget
    const objects = createDynamicObjects(1);
    const { i } = seedProbe(objects, { prograde: requested, lateral: 0 });
    runToCompletion(objects, requested);

    expect(objects.burning[i]).toBe(0);
    expect(Math.abs(objects.mass[i]! - DRY_MASS)).toBeLessThanOrEqual(1e-9 * DRY_MASS);
    expect(Math.abs(objects.burnDelivered[i]! / BUDGET - 1)).toBeLessThanOrEqual(1e-9);
  });
});

describe('frozen direction', () => {
  test('stays frozen while velocity rotates under gravity', () => {
    // A real attractor this time -- close enough that the probe's velocity
    // direction visibly rotates over the course of a long burn.
    const mu = 3.986004418e14; // Earth-like
    const bodies = createBodyTable([
      { parent: -1, mu, radius: 1, rotationPeriod: 86400, axialPhaseAtEpoch: 0 },
    ]);
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    const r = 4e7;
    objects.x[i] = r;
    objects.y[i] = 0;
    const vCirc = Math.sqrt(mu / r);
    objects.vx[i] = 0;
    objects.vy[i] = vCirc;
    objects.hitBody[i] = -1;
    objects.mass[i] = WET_MASS;
    objects.dryMass[i] = DRY_MASS;
    objects.thrust[i] = THRUST;
    objects.exhaustVelocity[i] = EXHAUST_VELOCITY;

    startBurn({ objects, index: i, prograde: 2000, lateral: 0 }); // long burn: ~756 s
    const nx0 = objects.burnNx[i]!;
    const ny0 = objects.burnNy[i]!;
    expect(nx0).toBeCloseTo(0, 15);
    expect(ny0).toBeCloseTo(1, 15);

    const scratch = createStepScratch({ bodies, dt: DT, capacity: 1 });
    for (let tick = 0; tick < 5 && objects.burning[i]; tick++) {
      stepTick({ bodies, objects, tick, dt: DT, scratch });
    }
    // Still mid-burn (5 ticks * 60 s = 300 s < ~756 s burn time), velocity
    // direction has visibly rotated away from the frozen n...
    expect(objects.burning[i]).toBe(1);
    const speed = Math.sqrt(objects.vx[i]! * objects.vx[i]! + objects.vy[i]! * objects.vy[i]!);
    const vDirX = objects.vx[i]! / speed;
    expect(Math.abs(vDirX)).toBeGreaterThan(1e-3);
    // ...but n itself never moved.
    expect(objects.burnNx[i]).toBe(nx0);
    expect(objects.burnNy[i]).toBe(ny0);
  });
});

describe('ghost isolation with a burning probe', () => {
  test('a burning probe integrated alone matches the same probe among 200 objects, some also burning', () => {
    const bodies = farField();
    const nTicks = 40;

    const alone = createDynamicObjects(1);
    seedProbe(alone, { prograde: 500, lateral: 0 });
    const aloneScratch = createStepScratch({ bodies, dt: DT, capacity: 1 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({ bodies, objects: alone, tick, dt: DT, scratch: aloneScratch });
    }

    const crowd = createDynamicObjects(201);
    seedProbe(crowd, { prograde: 500, lateral: 0 });
    for (let k = 0; k < 200; k++) {
      const j = crowd.count++;
      crowd.x[j] = 2e13 + k * 1e9;
      crowd.y[j] = 3e12 - k * 5e8;
      crowd.vx[j] = 1000 + k;
      crowd.vy[j] = -500 + k * 2;
      crowd.hitBody[j] = -1;
      if (k % 3 === 0) {
        crowd.mass[j] = WET_MASS;
        crowd.dryMass[j] = DRY_MASS;
        crowd.thrust[j] = THRUST;
        crowd.exhaustVelocity[j] = EXHAUST_VELOCITY;
        startBurn({ objects: crowd, index: j, prograde: 50 + k, lateral: (k % 2) * 20 });
      }
    }
    const crowdScratch = createStepScratch({ bodies, dt: DT, capacity: 201 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({ bodies, objects: crowd, tick, dt: DT, scratch: crowdScratch });
    }

    expect(Object.is(crowd.x[0], alone.x[0])).toBe(true);
    expect(Object.is(crowd.y[0], alone.y[0])).toBe(true);
    expect(Object.is(crowd.vx[0], alone.vx[0])).toBe(true);
    expect(Object.is(crowd.vy[0], alone.vy[0])).toBe(true);
    expect(Object.is(crowd.mass[0], alone.mass[0])).toBe(true);
    expect(Object.is(crowd.burnDelivered[0], alone.burnDelivered[0])).toBe(true);
    expect(crowd.burning[0]).toBe(alone.burning[0]);
  });
});

describe('batch invariance with a multi-tick burn', () => {
  test('N ticks in one loop matches the same N ticks split into arbitrary batches', () => {
    const bodies = farField();
    const nTicks = 60; // covers a burn spanning several ticks (~19 ticks)

    const whole = createDynamicObjects(1);
    seedProbe(whole, { prograde: 1000, lateral: 0 });
    const wholeScratch = createStepScratch({ bodies, dt: DT, capacity: 1 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({ bodies, objects: whole, tick, dt: DT, scratch: wholeScratch });
    }

    const batched = createDynamicObjects(1);
    seedProbe(batched, { prograde: 1000, lateral: 0 });
    const batchedScratch = createStepScratch({ bodies, dt: DT, capacity: 1 });
    const batches = [7, 23, 1, 19, 10]; // arbitrary, sums to nTicks
    expect(batches.reduce((a, b) => a + b, 0)).toBe(nTicks);
    let tick = 0;
    for (const size of batches) {
      for (let k = 0; k < size; k++, tick++) {
        stepTick({ bodies, objects: batched, tick, dt: DT, scratch: batchedScratch });
      }
    }

    expect(batched.vx[0]).toBe(whole.vx[0]);
    expect(batched.vy[0]).toBe(whole.vy[0]);
    expect(batched.mass[0]).toBe(whole.mass[0]);
    expect(batched.burnDelivered[0]).toBe(whole.burnDelivered[0]);
    expect(batched.burning[0]).toBe(whole.burning[0]);
  });
});
