// Integration tests for stepTick: the ghost invariant (a probe integrated
// alone matches the same probe integrated in a crowd, research §4.3), batch
// invariance (no accumulated-time bug), and surface collision on substep
// endpoints. Math.* is fine here -- tests are exempt from src/sim's
// determinism lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';
import { contactPoint, createContactState, createContactTable, NO_IMPACT } from '../contacts.ts';
import type { ContactState, ContactTable, FixedContactDef } from '../contacts.ts';
import { createHash, digest, updateFloat64, updateWord } from '../state/hash.ts';
import { startBurn } from './burn.ts';
import { createDynamicObjects, createStepScratch, stepTick } from './step.ts';
import type { DynamicObjects } from './step.ts';

// GRV-0015: the tests in this file that predate fixed contacts stay
// contact-free; the empty table needs no bodies of its own to validate
// against.
const NO_CONTACTS = createContactTable(
  [],
  createBodyTable([{ parent: -1, mu: 1, radius: 1, rotationPeriod: 1, axialPhaseAtEpoch: 0 }]),
);
const NO_CONTACT_STATE = createContactState(0);

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
    { parent: -1, mu: MU_SUN, radius: 6.957e8, rotationPeriod: 2.2e6, axialPhaseAtEpoch: 0 },
    {
      parent: 0,
      mu: MU_JUPITER,
      radius: R_JUPITER,
      a: 5.2 * AU,
      e: 0.0489,
      argPeriapsis: 0.257,
      meanAnomaly0: 0.6,
      rotationPeriod: 35730,
      axialPhaseAtEpoch: 0,
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
    const aloneScratch = createStepScratch({ bodies, contacts: NO_CONTACTS, dt: DT, capacity: 1 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({
        bodies,
        objects: alone,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch: aloneScratch,
      });
    }

    const crowd = createDynamicObjects(201);
    seedProbe(crowd, jupiterEph);
    seedOthers(crowd, jupiterEph, 200, makeRng(42));
    const crowdScratch = createStepScratch({
      bodies,
      contacts: NO_CONTACTS,
      dt: DT,
      capacity: 201,
    });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({
        bodies,
        objects: crowd,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch: crowdScratch,
      });
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
    const wholeScratch = createStepScratch({ bodies, contacts: NO_CONTACTS, dt: DT, capacity: 50 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({
        bodies,
        objects: whole,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch: wholeScratch,
      });
    }

    const batched = createDynamicObjects(50);
    seedProbe(batched, jupiterEph);
    seedOthers(batched, jupiterEph, 49, makeRng(7));
    const batchedScratch = createStepScratch({
      bodies,
      contacts: NO_CONTACTS,
      dt: DT,
      capacity: 50,
    });
    const batches = [83, 41, 1, 97, 78]; // arbitrary, sums to nTicks
    expect(batches.reduce((a, b) => a + b, 0)).toBe(nTicks);
    let tick = 0;
    for (const size of batches) {
      for (let k = 0; k < size; k++, tick++) {
        stepTick({
          bodies,
          objects: batched,
          contacts: NO_CONTACTS,
          contactState: NO_CONTACT_STATE,
          tick,
          dt: DT,
          scratch: batchedScratch,
        });
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
    const bodies = createBodyTable([
      { parent: -1, mu: 3.986004418e14, radius, rotationPeriod: 86400, axialPhaseAtEpoch: 0 },
    ]);
    const objects = createDynamicObjects(1);
    objects.count = 1;
    objects.x[0] = 10 * radius;
    objects.y[0] = 0;
    objects.vx[0] = -1e5;
    objects.vy[0] = 0;
    objects.hitBody[0] = -1;
    const scratch = createStepScratch({ bodies, contacts: NO_CONTACTS, dt: DT, capacity: 1 });

    let tick = 0;
    for (; tick < 40 && objects.hitBody[0] === -1; tick++) {
      stepTick({
        bodies,
        objects,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch,
      });
    }
    expect(objects.hitBody[0]).toBe(0);

    const frozen = { x: objects.x[0], y: objects.y[0], vx: objects.vx[0], vy: objects.vy[0] };
    for (let k = 0; k < 5; k++, tick++) {
      stepTick({
        bodies,
        objects,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch,
      });
    }
    expect(objects.x[0]).toBe(frozen.x);
    expect(objects.y[0]).toBe(frozen.y);
    expect(objects.vx[0]).toBe(frozen.vx);
    expect(objects.vy[0]).toBe(frozen.vy);
  });

  test('a probe hit mid-burn has burning cleared the same tick the hit is recorded', () => {
    const radius = 6.371e6;
    const bodies = createBodyTable([
      { parent: -1, mu: 3.986004418e14, radius, rotationPeriod: 86400, axialPhaseAtEpoch: 0 },
    ]);
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
    const scratch = createStepScratch({ bodies, contacts: NO_CONTACTS, dt: DT, capacity: 1 });

    let tick = 0;
    for (; tick < 40 && objects.hitBody[0] === -1; tick++) {
      expect(objects.burning[0]).toBe(1); // still burning right up to the hit
      stepTick({
        bodies,
        objects,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch,
      });
    }
    expect(objects.hitBody[0]).toBe(0); // actually hit within the run
    expect(objects.burning[0]).toBe(0); // cleared the same tick the hit was recorded

    const frozenDelivered = objects.burnDelivered[0];
    const frozenMass = objects.mass[0];
    for (let k = 0; k < 5; k++, tick++) {
      stepTick({
        bodies,
        objects,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch,
      });
    }
    expect(objects.burning[0]).toBe(0); // stays cleared
    expect(objects.burnDelivered[0]).toBe(frozenDelivered); // frozen with position/velocity
    expect(objects.mass[0]).toBe(frozenMass);
  });

  test('a grazing pass at 1.05 body radii is not flagged', () => {
    const mu = 3.986004418e14;
    const radius = 6.371e6;
    const bodies = createBodyTable([
      { parent: -1, mu, radius, rotationPeriod: 86400, axialPhaseAtEpoch: 0 },
    ]);
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
    const scratch = createStepScratch({ bodies, contacts: NO_CONTACTS, dt: DT, capacity: 1 });

    const nTicks = Math.ceil((t1 - t0) / DT);
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({
        bodies,
        objects,
        contacts: NO_CONTACTS,
        contactState: NO_CONTACT_STATE,
        tick,
        dt: DT,
        scratch,
      });
    }
    expect(objects.hitBody[0]).toBe(-1);
  });
});

// GRV-0015: fixed contacts and the swept-segment impact test.
describe('fixed contact impact', () => {
  // A host far too small and light to matter (radius/mu negligible) whose
  // only role is to carry one contact near the origin, with a rotation
  // period long enough that the contact is effectively fixed in inertial
  // space over the span of one tick.
  function negligibleHost(): BodyTable {
    return createBodyTable([
      { parent: -1, mu: 1, radius: 1, rotationPeriod: 1e12, axialPhaseAtEpoch: 0 },
    ]);
  }

  // dt*vRel/zeta for DT/VREL below is 18 000 000; a floored zeta*r at or
  // above that keeps the contact crossing ladder (and the body's own,
  // negligible-mu term) at level 0 -- a single substep spanning the whole
  // tick -- which is what lets a hand-picked chord exercise the
  // closest-approach-of-the-swept-segment math directly, deliberately
  // decoupled from the ladder's own (already covered by ladder.test.ts)
  // refinement behaviour. The capture radius here is chosen for that
  // isolation, not to resemble a level's real numbers (tests/golden/
  // intercept.json covers a realistic capture radius end to end).
  const DT2 = 60;
  const VREL = 300000; // 300 km/s, matching the design brief's example
  const HALF_CHORD = (DT2 * VREL) / 2; // 9 000 000 m
  const HUGE_CAPTURE_RADIUS = 600_000_000;

  function chordProbe(objects: DynamicObjects, yOffset: number): void {
    const i = objects.count++;
    objects.x[i] = -HALF_CHORD;
    objects.y[i] = yOffset;
    objects.vx[i] = VREL;
    objects.vy[i] = 0;
    objects.hitBody[i] = -1;
    objects.hitContact[i] = -1;
    objects.mass[i] = 1000;
  }

  test('a probe crossing the capture sphere between two swept-segment endpoints is caught, both endpoints outside it', () => {
    const bodies = negligibleHost();
    const contacts = createContactTable(
      [{ host: 0, longitude: 0, captureRadius: HUGE_CAPTURE_RADIUS, minimumImpactEnergy: 0 }],
      bodies,
    );
    const contactState = createContactState(1);
    const objects = createDynamicObjects(1);
    chordProbe(objects, HUGE_CAPTURE_RADIUS - 100); // 100 m inside at closest approach
    const scratch = createStepScratch({ bodies, contacts, dt: DT2, capacity: 1 });

    // Confirm the endpoints really are outside the capture sphere before
    // trusting the "swept segment, not endpoint sampling" claim below.
    const startDist = Math.hypot(objects.x[0]!, objects.y[0]!);
    expect(startDist).toBeGreaterThan(HUGE_CAPTURE_RADIUS);

    stepTick({ bodies, objects, contacts, contactState, tick: 0, dt: DT2, scratch });

    const endDist = Math.hypot(objects.x[0]!, objects.y[0]!);
    expect(endDist).toBeGreaterThan(HUGE_CAPTURE_RADIUS);
    expect(objects.hitContact[0]).toBe(0);
    expect(objects.hitBody[0]).toBe(-1);
    expect(contactState.impactSpeed[0]).toBeCloseTo(VREL, 0);
    expect(contactState.impactEnergy[0]).toBeGreaterThan(0);
  });

  test('a pass just outside the capture sphere is not caught', () => {
    const bodies = negligibleHost();
    const contacts = createContactTable(
      [{ host: 0, longitude: 0, captureRadius: HUGE_CAPTURE_RADIUS, minimumImpactEnergy: 0 }],
      bodies,
    );
    const contactState = createContactState(1);
    const objects = createDynamicObjects(1);
    chordProbe(objects, HUGE_CAPTURE_RADIUS + 100); // 100 m outside at closest approach
    const scratch = createStepScratch({ bodies, contacts, dt: DT2, capacity: 1 });

    stepTick({ bodies, objects, contacts, contactState, tick: 0, dt: DT2, scratch });

    expect(objects.hitContact[0]).toBe(-1);
    expect(contactState.impactTick[0]).toBe(NO_IMPACT);
  });

  test('two contacts within reach in the same substep: the smallest s (earliest along the segment) wins', () => {
    // One host, radius 50 km, hosting two contacts at antipodal longitudes
    // (+-50 km apart along x). The probe's chord is a small (+-80 km) sweep
    // near x, held at a huge, near-constant y offset (HUGE_CAPTURE_RADIUS
    // minus a wide 1 000 km margin) so that: the distance to *either*
    // contact stays comfortably inside both their (also huge) capture
    // radii throughout, and -- just as important -- the probe's distance to
    // the host's own *centre* (the unfloored body crossing-ladder term)
    // stays large too, since it is dominated by the same y offset. Both
    // keep the ladder at level 0 (a single substep spanning the whole
    // tick), which is what lets this chord's two crossings land in that
    // one substep rather than being separated across several as the ladder
    // refines on approach.
    const hostRadius = 50000;
    const bodies = createBodyTable([
      { parent: -1, mu: 1, radius: hostRadius, rotationPeriod: 1e12, axialPhaseAtEpoch: 0 },
    ]);
    const contacts = createContactTable(
      [
        { host: 0, longitude: 0, captureRadius: HUGE_CAPTURE_RADIUS, minimumImpactEnergy: 0 }, // ~(+50 km, 0): crossed second
        { host: 0, longitude: Math.PI, captureRadius: HUGE_CAPTURE_RADIUS, minimumImpactEnergy: 0 }, // ~(-50 km, 0): crossed first
      ],
      bodies,
    );
    const contactState = createContactState(2);
    const objects = createDynamicObjects(1);
    const y0 = HUGE_CAPTURE_RADIUS - 1_000_000;
    const halfChord = 80000;
    const i = objects.count++;
    objects.x[i] = -halfChord;
    objects.y[i] = y0;
    objects.vx[i] = (2 * halfChord) / DT2;
    objects.vy[i] = 0;
    objects.hitBody[i] = -1;
    objects.hitContact[i] = -1;
    objects.mass[i] = 1000;
    const scratch = createStepScratch({ bodies, contacts, dt: DT2, capacity: 1 });

    stepTick({ bodies, objects, contacts, contactState, tick: 0, dt: DT2, scratch });

    expect(objects.hitContact[0]).toBe(1); // the antipodal (smaller-s) contact, index 1
    expect(contactState.impactTick[1]).toBe(0);
    expect(contactState.impactTick[0]).toBe(NO_IMPACT); // never tested: the probe was already expended
  });

  test('zero-length relative segment: a probe motionless relative to a contact it is inside is still caught, no crash', () => {
    // Probe and host both sit still on the x-axis with the primary's own
    // (always-zero) velocity, and mu is small enough that gravity's
    // substep-long perturbation rounds away to nothing at this position
    // scale -- p0 and p1 come out bit-identical, so the segment's squared
    // length underflows to exactly 0 and the `denom === 0` guard is what
    // actually runs, not an approximation of it.
    const bodies = createBodyTable([
      { parent: -1, mu: 1e-20, radius: 1, rotationPeriod: 1e295, axialPhaseAtEpoch: 0 },
    ]);
    const contacts = createContactTable(
      [{ host: 0, longitude: 0, captureRadius: 1000, minimumImpactEnergy: 0 }],
      bodies,
    );
    const contactState = createContactState(1);
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    objects.x[i] = 1; // exactly the contact's own position (host radius 1, longitude 0)
    objects.y[i] = 0;
    objects.vx[i] = 0;
    objects.vy[i] = 0;
    objects.hitBody[i] = -1;
    objects.hitContact[i] = -1;
    objects.mass[i] = 1000;
    const scratch = createStepScratch({ bodies, contacts, dt: DT2, capacity: 1 });

    stepTick({ bodies, objects, contacts, contactState, tick: 0, dt: DT2, scratch });

    expect(objects.hitContact[0]).toBe(0);
    expect(Number.isNaN(contactState.impactSpeed[0])).toBe(false);
    expect(contactState.impactSpeed[0]).toBe(0);
    expect(contactState.impactEnergy[0]).toBe(0);
  });

  test('impact is tested before the body-surface test in the same substep: a contact on the surface catches the probe first', () => {
    const radius = 6.371e6;
    // A long rotation period (unlike the existing radial-approach fixtures
    // this test otherwise mirrors, which use a real 24 h day): the probe
    // flies a fixed inertial line, so a realistic spin would rotate the
    // longitude-0 contact away from that line during the several minutes
    // of approach, and only the body itself (not the contact riding a
    // now-different point on it) would still be there to hit.
    const bodies = createBodyTable([
      { parent: -1, mu: 3.986004418e14, radius, rotationPeriod: 1e9, axialPhaseAtEpoch: 0 },
    ]);
    const contacts = createContactTable(
      [{ host: 0, longitude: 0, captureRadius: 100000, minimumImpactEnergy: 0 }],
      bodies,
    );
    const contactState = createContactState(1);
    const objects = createDynamicObjects(1);
    const i = objects.count++;
    objects.x[i] = 10 * radius;
    objects.y[i] = 0;
    objects.vx[i] = -1e5;
    objects.vy[i] = 0;
    objects.hitBody[i] = -1;
    objects.hitContact[i] = -1;
    objects.mass[i] = 1000;
    const scratch = createStepScratch({ bodies, contacts, dt: DT, capacity: 1 });

    let tick = 0;
    for (; tick < 40 && objects.hitContact[0] === -1 && objects.hitBody[0] === -1; tick++) {
      stepTick({ bodies, objects, contacts, contactState, tick, dt: DT, scratch });
    }
    expect(objects.hitContact[0]).toBe(0);
    expect(objects.hitBody[0]).toBe(-1);
  });

  function openSpaceContact(minimumImpactEnergy: number): {
    bodies: BodyTable;
    contacts: ContactTable;
  } {
    const bodies = negligibleHost();
    const contacts = createContactTable(
      [{ host: 0, longitude: 0, captureRadius: 40000, minimumImpactEnergy }],
      bodies,
    );
    return { bodies, contacts };
  }

  function radialApproach(objects: DynamicObjects): void {
    const i = objects.count++;
    objects.x[i] = 5_000_000;
    objects.y[i] = 0;
    objects.vx[i] = -50000; // 50 km/s
    objects.vy[i] = 0;
    objects.hitBody[i] = -1;
    objects.hitContact[i] = -1;
    objects.mass[i] = 1000;
  }

  function runUntilExpended(args: {
    bodies: BodyTable;
    objects: DynamicObjects;
    contacts: ContactTable;
    contactState: ContactState;
  }): void {
    const { bodies, objects, contacts, contactState } = args;
    const scratch = createStepScratch({ bodies, contacts, dt: DT, capacity: objects.count });
    for (
      let tick = 0;
      tick < 200 && objects.hitContact[0] === -1 && objects.hitBody[0] === -1;
      tick++
    ) {
      stepTick({ bodies, objects, contacts, contactState, tick, dt: DT, scratch });
    }
  }

  test('impact energy below the minimum expends the probe but leaves the contact uncleared', () => {
    // ~50 km/s closing on a 1000 kg probe delivers ~1.25 TJ; set the
    // minimum well above that.
    const { bodies, contacts } = openSpaceContact(1e13);
    const contactState = createContactState(1);
    const objects = createDynamicObjects(1);
    radialApproach(objects);

    runUntilExpended({ bodies, objects, contacts, contactState });

    expect(objects.hitContact[0]).toBe(0);
    expect(objects.hitBody[0]).toBe(-1);
    expect(contactState.impactEnergy[0]).toBeGreaterThan(0);
    expect(contactState.impactEnergy[0]).toBeLessThan(1e13);
    expect(contactState.cleared[0]).toBe(0);
  });

  test('a cleared contact no longer catches probes', () => {
    // Same geometry, minimum well below the ~1.25 TJ delivered: the first
    // probe clears it.
    const { bodies, contacts } = openSpaceContact(1e12);
    const contactState = createContactState(1);
    const first = createDynamicObjects(1);
    radialApproach(first);
    runUntilExpended({ bodies, objects: first, contacts, contactState });
    expect(contactState.cleared[0]).toBe(1);

    // A second probe flown the identical approach must pass straight
    // through -- the contact is gone.
    const second = createDynamicObjects(1);
    radialApproach(second);
    const scratch = createStepScratch({ bodies, contacts, dt: DT, capacity: 1 });
    for (let tick = 0; tick < 200; tick++) {
      stepTick({ bodies, objects: second, contacts, contactState, tick, dt: DT, scratch });
    }
    expect(second.hitContact[0]).toBe(-1);
    expect(second.hitBody[0]).toBe(-1);
  });
});

describe('ghost isolation with contacts present', () => {
  test('a probe integrated alone matches the same probe among 200 objects, some of which impact contacts', () => {
    const bodies = sunJupiter();
    const jupiterEph = makeEph(2);
    evaluateEphemeris(bodies, 0, jupiterEph);
    const nTicks = 500;

    // A contact sitting on Jupiter's own surface: reachable by the
    // circular-orbit crowd members (1.1 * R_JUPITER, seedOthers's odd
    // branch), nowhere near probe 0's grazing hyperbolic path.
    const contactDefs: FixedContactDef[] = [
      { host: 1, longitude: 0, captureRadius: 40000, minimumImpactEnergy: 1e9 },
    ];
    const contacts = createContactTable(contactDefs, bodies);

    const aloneContactState = createContactState(1);
    const alone = createDynamicObjects(1);
    seedProbe(alone, jupiterEph);
    const aloneScratch = createStepScratch({ bodies, contacts, dt: DT, capacity: 1 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({
        bodies,
        objects: alone,
        contacts,
        contactState: aloneContactState,
        tick,
        dt: DT,
        scratch: aloneScratch,
      });
    }

    const crowdContactState = createContactState(1);
    const crowd = createDynamicObjects(202);
    seedProbe(crowd, jupiterEph);
    seedOthers(crowd, jupiterEph, 200, makeRng(42));
    // One deterministic impactor, placed exactly on the contact's own t=0
    // position and velocity so it is caught on the very first substep,
    // before Jupiter's own (real, 9h55m) rotation carries the contact
    // anywhere -- "some crowd members impact" does not depend on the
    // random seeding above, or on chasing a moving target.
    {
      const p = contactPoint({ bodies, contacts, contact: 0, t: 0, eph: jupiterEph });
      const i = crowd.count++;
      crowd.x[i] = p.x;
      crowd.y[i] = p.y;
      crowd.vx[i] = p.vx;
      crowd.vy[i] = p.vy;
      crowd.hitBody[i] = -1;
      crowd.hitContact[i] = -1;
      crowd.mass[i] = 1000;
    }
    const crowdScratch = createStepScratch({ bodies, contacts, dt: DT, capacity: 202 });
    for (let tick = 0; tick < nTicks; tick++) {
      stepTick({
        bodies,
        objects: crowd,
        contacts,
        contactState: crowdContactState,
        tick,
        dt: DT,
        scratch: crowdScratch,
      });
    }

    expect(crowd.count).toBe(202);
    expect(Object.is(crowd.x[0], alone.x[0])).toBe(true);
    expect(Object.is(crowd.y[0], alone.y[0])).toBe(true);
    expect(Object.is(crowd.vx[0], alone.vx[0])).toBe(true);
    expect(Object.is(crowd.vy[0], alone.vy[0])).toBe(true);
    expect(crowd.hitBody[0]).toBe(alone.hitBody[0]);
    expect(crowd.hitContact[0]).toBe(alone.hitContact[0]);
    // The deterministic impactor actually reached the contact -- "some of
    // which impact" is exercised, not vacuously true.
    expect(crowdContactState.impactTick[0]).not.toBe(NO_IMPACT);
    // Probe 0 itself never went near the contact, alone or in the crowd.
    expect(aloneContactState.impactTick[0]).toBe(NO_IMPACT);
  });
});
