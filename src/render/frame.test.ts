// captureFrame (GRV-0022): the renderer's one read of a live Sim, turned into a plain snapshot.
// Built on a small hand-rolled scenario (primary, one orbiting body, a rail, a contact) rather
// than a bundled level, so the expected geometry is checkable by hand.
import { describe, expect, test } from 'vitest';
import { advance, createSim } from '../sim/sim.ts';
import type { Scenario } from '../sim/sim.ts';
import { captureFrame, largestOrbitApoapsis } from './frame.ts';
import type { FrameLevelNames } from './frame.ts';

const PRIMARY_MU = 1.327e20; // sun-like, so the orbiting body's period is a sane number of seconds
const A = 1e9;
const E = 0.1;

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    dt: 60,
    capacity: 4,
    burnNodeCapacity: 0,
    bodies: [
      { parent: -1, mu: PRIMARY_MU, radius: 1000, rotationPeriod: 1e5, axialPhaseAtEpoch: 0 },
      {
        parent: 0,
        mu: 3.986e14,
        radius: 500,
        a: A,
        e: E,
        argPeriapsis: 0,
        meanAnomaly0: 0, // periapsis at t=0, so the body's position is exactly checkable
        rotationPeriod: 5e4,
        axialPhaseAtEpoch: 0,
      },
    ],
    rails: [
      {
        host: 1,
        longitude: 0,
        muzzleSpeedMin: 1,
        muzzleSpeedMax: 1e6,
        headingCone: Math.PI,
        reloadTicks: 0,
      },
    ],
    contacts: [{ host: 1, longitude: Math.PI / 2, captureRadius: 10, minimumImpactEnergy: 0 }],
    post: { host: 1, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 100, propellantMass: 100, exhaustVelocity: 3000, thrust: 100 },
    streams: [],
    ...overrides,
  };
}

const levelNames: FrameLevelNames = {
  bodyIds: ['primary', 'orbiter'],
  railIds: ['rail-a'],
  contactIds: ['contact-a'],
  bodyClasses: ['star', 'rock'],
  names: { bodies: ['Primary', 'Orbiter'], rails: ['Rail A'], contacts: ['Contact A'] },
};

describe('captureFrame', () => {
  test('carries the tick and dt through unchanged', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({ sim, level: levelNames, observed: [] });
    expect(frame.tick).toBe(0);
    expect(frame.dt).toBe(60);
  });

  test('the primary sits at the origin, has no orbit, and no direction to itself', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({ sim, level: levelNames, observed: [] });
    const primary = frame.bodies[0]!;
    expect(primary.x).toBe(0);
    expect(primary.y).toBe(0);
    expect(primary.orbit).toBeNull();
    expect(primary.directionToPrimaryX).toBe(0);
    expect(primary.directionToPrimaryY).toBe(0);
  });

  test('an orbiting body at its periapsis points straight back at the primary', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({ sim, level: levelNames, observed: [] });
    const orbiter = frame.bodies[1]!;

    expect(orbiter.x).toBeCloseTo(A * (1 - E), 3); // periapsis distance, meanAnomaly0 = 0
    expect(orbiter.y).toBeCloseTo(0, 6);
    expect(orbiter.directionToPrimaryX).toBeCloseTo(-1, 9);
    expect(orbiter.directionToPrimaryY).toBeCloseTo(0, 9);
  });

  test("the orbit ellipse passes through the body's own current position", () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({ sim, level: levelNames, observed: [] });
    const orbiter = frame.bodies[1]!;
    const orbit = orbiter.orbit!;

    // At periapsis a point sits on the major axis, exactly `semiMajorAxis` from the centre --
    // the strongest checkable invariant without re-deriving the ephemeris formula by hand.
    const distanceFromCentre = Math.hypot(orbiter.x - orbit.centreX, orbiter.y - orbit.centreY);
    expect(distanceFromCentre).toBeCloseTo(orbit.semiMajorAxis, 3);
    expect(orbit.semiMajorAxis).toBeCloseTo(A, 6);
    expect(orbit.semiMinorAxis).toBeLessThan(orbit.semiMajorAxis);
    expect(orbit.rotation).toBeCloseTo(0, 9); // argPeriapsis = 0
  });

  test("a rail's muzzle point sits on its host body's surface", () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({ sim, level: levelNames, observed: [] });
    const rail = frame.rails[0]!;
    const host = frame.bodies[1]!;
    expect(Math.hypot(rail.x - host.x, rail.y - host.y)).toBeCloseTo(host.radius, 3);
    expect(rail.id).toBe('rail-a');
    expect(rail.name).toBe('Rail A');
  });

  test("a contact sits on its host body's surface and starts uncleared", () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({ sim, level: levelNames, observed: [] });
    const contact = frame.contacts[0]!;
    const host = frame.bodies[1]!;
    expect(Math.hypot(contact.x - host.x, contact.y - host.y)).toBeCloseTo(host.radius, 3);
    expect(contact.cleared).toBe(false);
  });

  // GRV-0032: captureFrame reads `confirmedCleared`, never sim.contactState -- the glyph must not
  // turn confirmed-good before its own telemetry does, and must not stay dim once it has.
  describe('contacts.cleared reads confirmedCleared, never sim.contactState', () => {
    test('the true state already reads cleared, but telemetry has not confirmed it: still uncleared', () => {
      const sim = createSim({ scenario: scenario(), seed: 1 });
      sim.contactState.cleared[0] = 1;
      const frame = captureFrame({ sim, level: levelNames, observed: [] });
      expect(frame.contacts[0]!.cleared).toBe(false);
    });

    test('confirmedCleared says cleared even though the true state has not (never possible in a real replay, but proves the source is the param): cleared', () => {
      const sim = createSim({ scenario: scenario(), seed: 1 });
      const frame = captureFrame({
        sim,
        level: levelNames,
        observed: [],
        confirmedCleared: [true],
      });
      expect(frame.contacts[0]!.cleared).toBe(true);
    });
  });

  test('no dynamic objects at tick 0 (nothing launched yet)', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({ sim, level: levelNames, observed: [] });
    expect(frame.objects).toEqual([]);
  });

  // GRV-0030: captureFrame reads the observed view for every object, never sim.objects.
  describe('objects read the observed view, never the live state', () => {
    function launchedSim(): ReturnType<typeof createSim> {
      const sim = createSim({ scenario: scenario(), seed: 1 });
      advance({
        sim,
        log: [{ tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 100_000_000 }],
        ticks: 5,
      });
      return sim;
    }

    test('a launched object with no observed-view entry at all draws nothing', () => {
      const sim = launchedSim();
      const frame = captureFrame({ sim, level: levelNames, observed: [] });
      expect(frame.objects).toEqual([
        { x: 0, y: 0, vx: 0, vy: 0, expended: false, observed: false },
      ]);
    });

    test('predicted: null (no observation yet) draws as unobserved, not the live position', () => {
      const sim = launchedSim();
      const liveX = sim.objects.x[0]!;
      const frame = captureFrame({
        sim,
        level: levelNames,
        observed: [{ predicted: null, expended: false }],
      });
      expect(frame.objects[0]).toEqual({
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        expended: false,
        observed: false,
      });
      expect(frame.objects[0]!.x).not.toBe(liveX); // never the true, live state
    });

    test('a predicted position is drawn exactly, distinct from the live one', () => {
      const sim = launchedSim();
      const predicted = { x: 111, y: 222, vx: 3, vy: 4 };
      const frame = captureFrame({
        sim,
        level: levelNames,
        observed: [{ predicted, expended: false }],
      });
      expect(frame.objects[0]).toEqual({ ...predicted, expended: false, observed: true });
      expect(frame.objects[0]!.x).not.toBe(sim.objects.x[0]!);
    });

    test('expended reflects the observation, not the live (unexpended) state', () => {
      const sim = launchedSim();
      expect(sim.objects.hitBody[0]).toBe(-1); // still flying, live
      const frame = captureFrame({
        sim,
        level: levelNames,
        observed: [{ predicted: { x: 1, y: 2, vx: 0, vy: 0 }, expended: true }],
      });
      expect(frame.objects[0]!.expended).toBe(true);
    });
  });

  test('falls back to the "rock" class and a synthesised id/name when the level omits them', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const frame = captureFrame({
      sim,
      level: {
        bodyIds: [],
        railIds: [],
        contactIds: [],
        bodyClasses: [],
        names: { bodies: [], rails: [], contacts: [] },
      },
      observed: [],
    });
    expect(frame.bodies[1]!.klass).toBe('rock');
    expect(frame.bodies[1]!.id).toBe('body-1');
    expect(frame.bodies[1]!.name).toBe('body-1');
  });
});

describe('largestOrbitApoapsis', () => {
  test('is the apoapsis distance for a single-level system', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    expect(largestOrbitApoapsis(sim.bodies)).toBeCloseTo(A * (1 + E), 3);
  });

  test('sums a*(1+e) up the parent chain for a moon around an orbiting planet', () => {
    const moonA = 1e6;
    const moonE = 0.05;
    const withMoon = scenario({
      bodies: [
        { parent: -1, mu: PRIMARY_MU, radius: 1000, rotationPeriod: 1e5, axialPhaseAtEpoch: 0 },
        {
          parent: 0,
          mu: 3.986e14,
          radius: 500,
          a: A,
          e: E,
          argPeriapsis: 0,
          meanAnomaly0: 0,
          rotationPeriod: 5e4,
          axialPhaseAtEpoch: 0,
        },
        {
          parent: 1,
          mu: 4.9e12,
          radius: 100,
          a: moonA,
          e: moonE,
          argPeriapsis: 0,
          meanAnomaly0: 0,
          rotationPeriod: 1e4,
          axialPhaseAtEpoch: 0,
        },
      ],
      rails: [],
      contacts: [],
    });
    const sim = createSim({ scenario: withMoon, seed: 1 });
    expect(largestOrbitApoapsis(sim.bodies)).toBeCloseTo(A * (1 + E) + moonA * (1 + moonE), 3);
  });

  test('is zero for a single-body (star-only) system', () => {
    const single = scenario({
      bodies: [
        { parent: -1, mu: PRIMARY_MU, radius: 1000, rotationPeriod: 1e5, axialPhaseAtEpoch: 0 },
      ],
      rails: [],
      contacts: [],
      post: { host: 0, longitude: 0 },
    });
    const sim = createSim({ scenario: single, seed: 1 });
    expect(largestOrbitApoapsis(sim.bodies)).toBe(0);
  });
});
