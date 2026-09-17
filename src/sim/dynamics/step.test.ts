// Integration tests for stepTick: the ghost invariant (a probe integrated
// alone matches the same probe integrated in a crowd, research §4.3), batch
// invariance (no accumulated-time bug), and surface collision on substep
// endpoints. Math.* is fine here -- tests are exempt from src/sim's
// determinism lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';
import { createHash, digest, updateFloat64, updateWord } from '../state/hash.ts';
import { startBurn } from './burn.ts';
import { createDynamicObjects, createStepScratch, stepTick } from './step.ts';
import type { DynamicObjects } from './step.ts';

const TWO_PI = 6.283185307179586;
const MU_SUN = 1.32712440018e20;
const MU_JUPITER = 1.26687e17;
const R_JUPITER = 7.1492e7;
const AU = 1.495978707e11;
const DT = 60;

function makeEph(count: number): EphemerisOut {
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
  };
}

function sunJupiter(): BodyTable {
  return createBodyTable([
    { parent: -1, mu: MU_SUN, radius: 6.957e8 },
    {
      parent: 0,
      mu: MU_JUPITER,
      radius: R_JUPITER,
      a: 5.2 * AU,
      e: 0.0489,
      argPeriapsis: 0.257,
      meanAnomaly0: 0.6,
    },
  ]);
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashOf(objects: DynamicObjects): string {
  const state = createHash();
  for (let i = 0; i < objects.count; i++) {
    updateFloat64(state, objects.x[i]!);
    updateFloat64(state, objects.y[i]!);
    updateFloat64(state, objects.vx[i]!);
    updateFloat64(state, objects.vy[i]!);
    updateWord(state, objects.hitBody[i]!);
  }
  return digest(state);
}

/** A grazing hyperbolic-ish pass relative to Jupiter's position at tick 0:
 *  close enough at first to force a non-zero substep level, then it flies
 *  away. Doesn't need to be an exact hyperbola -- only flyby-accuracy.test.ts
 *  needs that -- just a trajectory that stresses the ladder. */
function seedProbe(objects: DynamicObjects, jupiterEph: EphemerisOut): number {
  const i = objects.count++;
  const r = 1.05 * R_JUPITER;
  objects.x[i] = jupiterEph.x[1]! + r;
  objects.y[i] = jupiterEph.y[1]!;
  objects.vx[i] = jupiterEph.vx[1]!;
  objects.vy[i] = jupiterEph.vy[1]! + 2e5;
  objects.hitBody[i] = -1;
  return i;
}

function seedOthers(
  objects: DynamicObjects,
  jupiterEph: EphemerisOut,
  n: number,
  rng: () => number,
): void {
  const jx = jupiterEph.x[1]!;
  const jy = jupiterEph.y[1]!;
  const jvx = jupiterEph.vx[1]!;
  const jvy = jupiterEph.vy[1]!;
  for (let k = 0; k < n; k++) {
    const i = objects.count++;
    if (k % 2 === 0) {
      // scattered far away: cruise, level 0
      const r = (1.2 + 2.0 * rng()) * AU;
      const th = rng() * TWO_PI;
      const speed = 1e5 + 2e5 * rng();
      const ph = rng() * TWO_PI;
      objects.x[i] = r * Math.cos(th);
      objects.y[i] = r * Math.sin(th);
      objects.vx[i] = speed * Math.cos(ph);
      objects.vy[i] = speed * Math.sin(ph);
    } else {
      // circular orbit just above Jupiter's surface: stays deep, high level
      const r = 1.1 * R_JUPITER;
      const th = rng() * TWO_PI;
      const vc = Math.sqrt(MU_JUPITER / r);
      objects.x[i] = jx + r * Math.cos(th);
      objects.y[i] = jy + r * Math.sin(th);
      objects.vx[i] = jvx - vc * Math.sin(th);
      objects.vy[i] = jvy + vc * Math.cos(th);
    }
    objects.hitBody[i] = -1;
  }
}

describe('ghost isolation', () => {
  test('a probe integrated alone matches the same probe among 200 other objects, bit for bit', () => {
    const bodies = sunJupiter();
    const jupiterEph = makeEph(2);
    evaluateEphemeris(bodies, 0, jupiterEph);
    const nTicks = 500;

    const alone = createDynamicObjects(1);
    seedProbe(alone, jupiterEph);
    const aloneScratch = createStepScratch({ bodies, dt: DT, capacity: 1 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({ bodies, objects: alone, tick, dt: DT, scratch: aloneScratch });
    }

    const crowd = createDynamicObjects(201);
    seedProbe(crowd, jupiterEph);
    seedOthers(crowd, jupiterEph, 200, makeRng(42));
    const crowdScratch = createStepScratch({ bodies, dt: DT, capacity: 201 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({ bodies, objects: crowd, tick, dt: DT, scratch: crowdScratch });
    }

    expect(crowd.count).toBe(201);
    expect(Object.is(crowd.x[0], alone.x[0])).toBe(true);
    expect(Object.is(crowd.y[0], alone.y[0])).toBe(true);
    expect(Object.is(crowd.vx[0], alone.vx[0])).toBe(true);
    expect(Object.is(crowd.vy[0], alone.vy[0])).toBe(true);
    expect(crowd.hitBody[0]).toBe(alone.hitBody[0]);
  });
});

describe('batch invariance', () => {
  test('N ticks in one loop matches the same N ticks split into arbitrary batches', () => {
    const bodies = sunJupiter();
    const jupiterEph = makeEph(2);
    evaluateEphemeris(bodies, 0, jupiterEph);
    const nTicks = 300;

    const whole = createDynamicObjects(50);
    seedProbe(whole, jupiterEph);
    seedOthers(whole, jupiterEph, 49, makeRng(7));
    const wholeScratch = createStepScratch({ bodies, dt: DT, capacity: 50 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({ bodies, objects: whole, tick, dt: DT, scratch: wholeScratch });
    }

    const batched = createDynamicObjects(50);
    seedProbe(batched, jupiterEph);
    seedOthers(batched, jupiterEph, 49, makeRng(7));
    const batchedScratch = createStepScratch({ bodies, dt: DT, capacity: 50 });
    const batches = [83, 41, 1, 97, 78]; // arbitrary, sums to nTicks
    expect(batches.reduce((a, b) => a + b, 0)).toBe(nTicks);
    let tick = 0;
    for (const size of batches) {
      for (let k = 0; k < size; k++, tick++) {
        stepTick({ bodies, objects: batched, tick, dt: DT, scratch: batchedScratch });
      }
    }

    expect(hashOf(batched)).toBe(hashOf(whole));
  });
});

// Exact hyperbolic two-body propagator, ported from `hyper_state`/`t_at_r`
// in docs/research/2026-09-03-02-simulation-numerics-probes/p4_integrator.py
// (research §3.2). Duplicated in flyby-accuracy.test.ts rather than shared
// from a plain .ts helper: production src/sim files can't use Math.sinh
// (ADR-0002), and every *.test.ts file is exempt, so a test-only fixture is
// the only place this can live.
function hyperState(mu: number, rp: number, vinf: number, t: number) {
  const aa = mu / (vinf * vinf);
  const e = 1 + rp / aa;
  const n = Math.sqrt(mu / (aa * aa * aa));
  const M = n * t;
  let H =
    Math.abs(M) < 1e3 ? Math.asinh(M / e) : Math.sign(M) * Math.log((2 * Math.abs(M)) / e + 1.8);
  for (let i = 0; i < 200; i++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    const d = -f / fp;
    H += d;
    if (Math.abs(d) < 1e-16 * Math.max(1, Math.abs(H))) break;
  }
  const ch = Math.cosh(H);
  const sh = Math.sinh(H);
  const r = aa * (e * ch - 1);
  const x = aa * (e - ch);
  const y = aa * Math.sqrt(e * e - 1) * sh;
  const k = Math.sqrt(mu * aa) / r;
  return { x, y, vx: -k * sh, vy: k * Math.sqrt(e * e - 1) * ch };
}

function tAtR(mu: number, rp: number, vinf: number, r: number): number {
  const aa = mu / (vinf * vinf);
  const e = 1 + rp / aa;
  const H = Math.acosh((r / aa + 1) / e);
  return (e * Math.sinh(H) - H) / Math.sqrt(mu / (aa * aa * aa));
}

describe('surface collision', () => {
  test('an object aimed at a body is flagged with the right body index and freezes', () => {
    const radius = 6.371e6;
    const bodies = createBodyTable([{ parent: -1, mu: 3.986004418e14, radius }]);
    const objects = createDynamicObjects(1);
    objects.count = 1;
    objects.x[0] = 10 * radius;
    objects.y[0] = 0;
    objects.vx[0] = -1e5;
    objects.vy[0] = 0;
    objects.hitBody[0] = -1;
    const scratch = createStepScratch({ bodies, dt: DT, capacity: 1 });

    let tick = 0;
    for (; tick < 40 && objects.hitBody[0] === -1; tick++) {
      stepTick({ bodies, objects, tick, dt: DT, scratch });
    }
    expect(objects.hitBody[0]).toBe(0);

    const frozen = { x: objects.x[0], y: objects.y[0], vx: objects.vx[0], vy: objects.vy[0] };
    for (let k = 0; k < 5; k++, tick++) {
      stepTick({ bodies, objects, tick, dt: DT, scratch });
    }
    expect(objects.x[0]).toBe(frozen.x);
    expect(objects.y[0]).toBe(frozen.y);
    expect(objects.vx[0]).toBe(frozen.vx);
    expect(objects.vy[0]).toBe(frozen.vy);
  });

  test('a probe hit mid-burn has burning cleared the same tick the hit is recorded', () => {
    const radius = 6.371e6;
    const bodies = createBodyTable([{ parent: -1, mu: 3.986004418e14, radius }]);
    const objects = createDynamicObjects(1);
    objects.count = 1;
    objects.x[0] = 10 * radius;
    objects.y[0] = 0;
    objects.vx[0] = -1e5;
    objects.vy[0] = 0;
    objects.hitBody[0] = -1;
    objects.mass[0] = 1000;
    objects.dryMass[0] = 400;
    objects.thrust[0] = 1; // tiny: doesn't meaningfully perturb the aim
    objects.exhaustVelocity[0] = 3000;
    // Target far beyond what a ~2400 s run at 1 N can deliver, and a tank
    // far from empty over the same span: the burn stays active the whole
    // way in, so the only thing that can clear it is the collision itself.
    startBurn({ objects, index: 0, prograde: 1_000_000, lateral: 0 });
    const scratch = createStepScratch({ bodies, dt: DT, capacity: 1 });

    let tick = 0;
    for (; tick < 40 && objects.hitBody[0] === -1; tick++) {
      expect(objects.burning[0]).toBe(1); // still burning right up to the hit
      stepTick({ bodies, objects, tick, dt: DT, scratch });
    }
    expect(objects.hitBody[0]).toBe(0); // actually hit within the run
    expect(objects.burning[0]).toBe(0); // cleared the same tick the hit was recorded

    const frozenDelivered = objects.burnDelivered[0];
    const frozenMass = objects.mass[0];
    for (let k = 0; k < 5; k++, tick++) {
      stepTick({ bodies, objects, tick, dt: DT, scratch });
    }
    expect(objects.burning[0]).toBe(0); // stays cleared
    expect(objects.burnDelivered[0]).toBe(frozenDelivered); // frozen with position/velocity
    expect(objects.mass[0]).toBe(frozenMass);
  });

  test('a grazing pass at 1.05 body radii is not flagged', () => {
    const mu = 3.986004418e14;
    const radius = 6.371e6;
    const bodies = createBodyTable([{ parent: -1, mu, radius }]);
    const rp = 1.05 * radius;
    const vinf = 1e5;

    const rStart = 300 * rp;
    const t0 = -tAtR(mu, rp, vinf, rStart);
    const t1 = -t0;
    const init = hyperState(mu, rp, vinf, t0);
    const objects = createDynamicObjects(1);
    objects.count = 1;
    objects.x[0] = init.x;
    objects.y[0] = init.y;
    objects.vx[0] = init.vx;
    objects.vy[0] = init.vy;
    objects.hitBody[0] = -1;
    const scratch = createStepScratch({ bodies, dt: DT, capacity: 1 });

    const nTicks = Math.ceil((t1 - t0) / DT);
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({ bodies, objects, tick, dt: DT, scratch });
    }
    expect(objects.hitBody[0]).toBe(-1);
  });
});
