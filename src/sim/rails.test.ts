// Tests for RailTable validation and launch geometry (docs/work/GRV-0014).
// Math.* is fine here -- tests are exempt from src/sim's determinism lint
// (ADR-0002) -- and used deliberately as an independent oracle: production
// computes phase and direction with dsincos/surfacePhase, the tests below
// recompute the same geometry with Math.cos/Math.sin/Math.atan2 so a real
// formula bug would show up as a mismatch, not just a self-consistency check.
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from './ephemeris/bodies.ts';
import type { BodyDef, EphemerisOut } from './ephemeris/bodies.ts';
import { createRailTable, railGeometry } from './rails.ts';
import type { RailDef } from './rails.ts';

const MU_SUN = 1.32712440018e20;
const AU = 1.495978707e11;

function makeEph(n: number): EphemerisOut {
  return {
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
  };
}

describe('createRailTable validation', () => {
  const sun: BodyDef = {
    parent: -1,
    mu: MU_SUN,
    radius: 6.957e8,
    rotationPeriod: 2.2e6,
    axialPhaseAtEpoch: 0,
  };
  const bodies = createBodyTable([sun]);
  const rail: RailDef = {
    host: 0,
    longitude: 0.3,
    muzzleSpeedMin: 60000,
    muzzleSpeedMax: 300000,
    headingCone: 1.2,
    reloadTicks: 360,
  };

  test('accepts a valid rail', () => {
    expect(() => createRailTable([rail], bodies)).not.toThrow();
  });

  test('precomputes cosHeadingCone with an independent oracle', () => {
    const table = createRailTable([rail], bodies);
    expect(Math.abs(table.cosHeadingCone[0]! - Math.cos(rail.headingCone))).toBeLessThan(1e-12);
  });

  test('accepts the boundary headingCone = pi (the whole sphere is reachable)', () => {
    expect(() => createRailTable([{ ...rail, headingCone: Math.PI }], bodies)).not.toThrow();
  });

  test('accepts muzzleSpeedMin === muzzleSpeedMax (a fixed-speed rail)', () => {
    expect(() =>
      createRailTable([{ ...rail, muzzleSpeedMin: 1000, muzzleSpeedMax: 1000 }], bodies),
    ).not.toThrow();
  });

  test.each([
    ['host', -1],
    ['host', 1],
    ['host', 1.5],
    ['longitude', NaN],
    ['longitude', Infinity],
    ['muzzleSpeedMin', 0],
    ['muzzleSpeedMin', -1],
    ['muzzleSpeedMin', NaN],
    ['muzzleSpeedMax', NaN],
    ['headingCone', 0],
    ['headingCone', -0.1],
    ['headingCone', Math.PI + 1e-9],
    ['headingCone', NaN],
    ['reloadTicks', -1],
    ['reloadTicks', 1.5],
    ['reloadTicks', NaN],
  ])('throws when a rail has %s = %p', (field, value) => {
    expect(() => createRailTable([{ ...rail, [field]: value }], bodies)).toThrow();
  });

  test('throws when muzzleSpeedMax is below muzzleSpeedMin', () => {
    expect(() =>
      createRailTable([{ ...rail, muzzleSpeedMin: 200000, muzzleSpeedMax: 100000 }], bodies),
    ).toThrow();
  });
});

describe('railGeometry: position', () => {
  test('lies exactly on the surface, at the expected angle, for a known phase', () => {
    const rotationPeriod = 90000;
    const axialPhaseAtEpoch = 0.4;
    const longitude = 1.1;
    const radius = 6.371e6;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_SUN, radius, rotationPeriod, axialPhaseAtEpoch },
    ]);
    const rails = createRailTable(
      [
        {
          host: 0,
          longitude,
          muzzleSpeedMin: 1,
          muzzleSpeedMax: 2,
          headingCone: 1,
          reloadTicks: 0,
        },
      ],
      bodies,
    );
    const t = 12345;
    const eph = makeEph(1);
    evaluateEphemeris(bodies, t, eph);

    const g = railGeometry({ bodies, rails, rail: 0, t, eph });

    // Independent oracle: same reduce-before-trig shape, computed with Math.*.
    const cycles = t / rotationPeriod;
    const frac = cycles - Math.floor(cycles);
    const expectedPhi = axialPhaseAtEpoch + 2 * Math.PI * frac + longitude;

    expect(Math.hypot(g.x, g.y)).toBeCloseTo(radius, 3); // exactly on the surface
    expect(Math.abs(g.x - radius * Math.cos(expectedPhi))).toBeLessThan(radius * 1e-9);
    expect(Math.abs(g.y - radius * Math.sin(expectedPhi))).toBeLessThan(radius * 1e-9);
    expect(Math.abs(g.ux - Math.cos(expectedPhi))).toBeLessThan(1e-9);
    expect(Math.abs(g.uy - Math.sin(expectedPhi))).toBeLessThan(1e-9);
  });
});

describe('railGeometry: velocity', () => {
  test('on a stationary primary, velocity is exactly the surface rotation term', () => {
    const rotationPeriod = 43200; // 12 h
    const radius = 6.371e6;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_SUN, radius, rotationPeriod, axialPhaseAtEpoch: 0 },
    ]);
    const rails = createRailTable(
      [
        {
          host: 0,
          longitude: 0,
          muzzleSpeedMin: 1,
          muzzleSpeedMax: 2,
          headingCone: 1,
          reloadTicks: 0,
        },
      ],
      bodies,
    );
    const t = 5000;
    const eph = makeEph(1);
    evaluateEphemeris(bodies, t, eph); // host velocity is (0, 0): the primary never moves

    const g = railGeometry({ bodies, rails, rail: 0, t, eph });

    const omega = (2 * Math.PI) / rotationPeriod;
    const cycles = t / rotationPeriod;
    const frac = cycles - Math.floor(cycles);
    const phi = 2 * Math.PI * frac;
    const expectedVx = omega * radius * -Math.sin(phi);
    const expectedVy = omega * radius * Math.cos(phi);

    expect(Math.abs(g.vx - expectedVx)).toBeLessThan(1e-6);
    expect(Math.abs(g.vy - expectedVy)).toBeLessThan(1e-6);
  });

  test('on a circular-orbit host, velocity is the exact sum of host velocity and surface rotation', () => {
    const MU_STAR = 1.32712440018e20;
    const a = AU;
    const hostRotationPeriod = 90000;
    const radius = 6.371e6;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_STAR, radius: 6.957e8, rotationPeriod: 2.2e6, axialPhaseAtEpoch: 0 },
      {
        parent: 0,
        mu: 3.986004418e14,
        radius,
        a,
        e: 0,
        argPeriapsis: 0,
        meanAnomaly0: 0,
        rotationPeriod: hostRotationPeriod,
        axialPhaseAtEpoch: 0.9,
      },
    ]);
    const rails = createRailTable(
      [
        {
          host: 1,
          longitude: 2.0,
          muzzleSpeedMin: 1,
          muzzleSpeedMax: 2,
          headingCone: 1,
          reloadTicks: 0,
        },
      ],
      bodies,
    );
    const t = 777777;
    const eph = makeEph(2);
    evaluateEphemeris(bodies, t, eph);

    // Closed form for a circular orbit: |v| = sqrt(mu/a), tangential, so
    // (vx, vy) = speed * (-sin(theta), cos(theta)) with theta the orbital
    // angle -- read directly off the independently-verified ephemeris
    // (bodies.test.ts's own "speed equals sqrt(mu/a)" pins that formula) so
    // this test isolates the rail's *addition* of the rotation term rather
    // than re-deriving the orbit itself.
    const hostVx = eph.vx[1]!;
    const hostVy = eph.vy[1]!;

    const omega = (2 * Math.PI) / hostRotationPeriod;
    const cycles = t / hostRotationPeriod;
    const frac = cycles - Math.floor(cycles);
    const phi = 0.9 + 2 * Math.PI * frac + 2.0; // axialPhaseAtEpoch + turn + longitude
    const rotVx = omega * radius * -Math.sin(phi);
    const rotVy = omega * radius * Math.cos(phi);

    const g = railGeometry({ bodies, rails, rail: 0, t, eph });

    expect(Math.abs(g.vx - (hostVx + rotVx))).toBeLessThan(1e-6);
    expect(Math.abs(g.vy - (hostVy + rotVy))).toBeLessThan(1e-6);
  });
});

describe('launch window: the rail sweeps with rotation', () => {
  test('the local vertical points opposite itself half a rotation period later, and repeats after a full period', () => {
    const rotationPeriod = 50000;
    const radius = 1e6;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_SUN, radius, rotationPeriod, axialPhaseAtEpoch: 0.2 },
    ]);
    const rails = createRailTable(
      [
        {
          host: 0,
          longitude: 0,
          muzzleSpeedMin: 1,
          muzzleSpeedMax: 2,
          headingCone: 1,
          reloadTicks: 0,
        },
      ],
      bodies,
    );
    const eph = makeEph(1);
    const t0 = 1234;

    evaluateEphemeris(bodies, t0, eph);
    const g0 = railGeometry({ bodies, rails, rail: 0, t: t0, eph });

    evaluateEphemeris(bodies, t0 + rotationPeriod / 2, eph);
    const gHalf = railGeometry({ bodies, rails, rail: 0, t: t0 + rotationPeriod / 2, eph });

    evaluateEphemeris(bodies, t0 + rotationPeriod, eph);
    const gFull = railGeometry({ bodies, rails, rail: 0, t: t0 + rotationPeriod, eph });

    // Antipodal after half a turn: a bearing the rail could hit at t0 is
    // exactly the one it cannot hit (without crossing the cone) at t0+T/2 --
    // this is the geometric root of "the launch window is a rotation phase"
    // (GAME-0001 §4.2).
    expect(Math.abs(gHalf.ux - -g0.ux)).toBeLessThan(1e-9);
    expect(Math.abs(gHalf.uy - -g0.uy)).toBeLessThan(1e-9);
    // Back to the same bearing after a full turn.
    expect(Math.abs(gFull.ux - g0.ux)).toBeLessThan(1e-9);
    expect(Math.abs(gFull.uy - g0.uy)).toBeLessThan(1e-9);
  });
});
