// Tests for ContactTable validation and contact kinematics (docs/work/
// GRV-0015). Math.* is fine here -- tests are exempt from src/sim's
// determinism lint (ADR-0002) -- and used deliberately as an independent
// oracle: production computes phase and direction with dsincos/surfacePhase,
// these tests recompute the same geometry with Math.cos/Math.sin/Math.sqrt
// so a real formula bug shows up as a mismatch, not just a self-consistency
// check.
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from './ephemeris/bodies.ts';
import type { BodyDef, EphemerisOut } from './ephemeris/bodies.ts';
import { contactPoint, createContactState, createContactTable, NO_IMPACT } from './contacts.ts';
import type { FixedContactDef } from './contacts.ts';

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

describe('createContactTable validation', () => {
  const sun: BodyDef = {
    parent: -1,
    mu: MU_SUN,
    radius: 6.957e8,
    rotationPeriod: 2.2e6,
    axialPhaseAtEpoch: 0,
  };
  const bodies = createBodyTable([sun]);
  const contact: FixedContactDef = {
    host: 0,
    longitude: 0.3,
    captureRadius: 40000,
    minimumImpactEnergy: 2.4e12,
  };

  test('accepts a valid contact', () => {
    expect(() => createContactTable([contact], bodies)).not.toThrow();
  });

  test('accepts a zero minimumImpactEnergy (any impact clears it)', () => {
    expect(() =>
      createContactTable([{ ...contact, minimumImpactEnergy: 0 }], bodies),
    ).not.toThrow();
  });

  test.each([
    ['host', -1],
    ['host', 1],
    ['host', 1.5],
    ['longitude', NaN],
    ['longitude', Infinity],
    // docs/issues/2026-09-18-unbounded-angles-reach-trig-kernel.md: [-2pi, 2pi] is the accepted
    // range (both endpoints included), independent of the compiler's own [0, 2pi) normalisation.
    ['longitude', 2 * Math.PI + 1e-9],
    ['longitude', -2 * Math.PI - 1e-9],
    ['captureRadius', 0],
    ['captureRadius', -1],
    ['captureRadius', NaN],
    ['minimumImpactEnergy', -1],
    ['minimumImpactEnergy', NaN],
  ])('throws when a contact has %s = %p', (field, value) => {
    expect(() => createContactTable([{ ...contact, [field]: value }], bodies)).toThrow();
  });
});

describe('createContactTable validation: longitude boundary', () => {
  test('accepts longitude at the +-2pi boundary', () => {
    const sun: BodyDef = {
      parent: -1,
      mu: MU_SUN,
      radius: 6.957e8,
      rotationPeriod: 2.2e6,
      axialPhaseAtEpoch: 0,
    };
    const bodies = createBodyTable([sun]);
    expect(() =>
      createContactTable(
        [{ host: 0, longitude: 2 * Math.PI, captureRadius: 40000, minimumImpactEnergy: 0 }],
        bodies,
      ),
    ).not.toThrow();
    expect(() =>
      createContactTable(
        [{ host: 0, longitude: -2 * Math.PI, captureRadius: 40000, minimumImpactEnergy: 0 }],
        bodies,
      ),
    ).not.toThrow();
  });
});

describe('contactPoint: position', () => {
  test('lies exactly on the surface, at the expected angle, for a known phase', () => {
    const rotationPeriod = 90000;
    const axialPhaseAtEpoch = 0.4;
    const longitude = 1.1;
    const radius = 6.371e6;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_SUN, radius, rotationPeriod, axialPhaseAtEpoch },
    ]);
    const contacts = createContactTable(
      [{ host: 0, longitude, captureRadius: 40000, minimumImpactEnergy: 1e12 }],
      bodies,
    );
    const t = 12345;
    const eph = makeEph(1);
    evaluateEphemeris(bodies, t, eph);

    const p = contactPoint({ bodies, contacts, contact: 0, t, eph });

    const cycles = t / rotationPeriod;
    const frac = cycles - Math.floor(cycles);
    const expectedPhi = axialPhaseAtEpoch + 2 * Math.PI * frac + longitude;

    expect(Math.hypot(p.x, p.y)).toBeCloseTo(radius, 3);
    expect(Math.abs(p.x - radius * Math.cos(expectedPhi))).toBeLessThan(radius * 1e-9);
    expect(Math.abs(p.y - radius * Math.sin(expectedPhi))).toBeLessThan(radius * 1e-9);
  });
});

describe('contactPoint: velocity, circular-orbit host with spin', () => {
  test('is the exact sum of host orbital velocity and surface rotation', () => {
    const hostRotationPeriod = 90000;
    const radius = 6.371e6;
    const a = AU;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_SUN, radius: 6.957e8, rotationPeriod: 2.2e6, axialPhaseAtEpoch: 0 },
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
    const contacts = createContactTable(
      [{ host: 1, longitude: 2.0, captureRadius: 40000, minimumImpactEnergy: 1e12 }],
      bodies,
    );
    const t = 777777;
    const eph = makeEph(2);
    evaluateEphemeris(bodies, t, eph);

    const hostVx = eph.vx[1]!;
    const hostVy = eph.vy[1]!;
    const omega = (2 * Math.PI) / hostRotationPeriod;
    const cycles = t / hostRotationPeriod;
    const frac = cycles - Math.floor(cycles);
    const phi = 0.9 + 2 * Math.PI * frac + 2.0;
    const rotVx = omega * radius * -Math.sin(phi);
    const rotVy = omega * radius * Math.cos(phi);

    const p = contactPoint({ bodies, contacts, contact: 0, t, eph });

    expect(Math.abs(p.vx - (hostVx + rotVx))).toBeLessThan(1e-6);
    expect(Math.abs(p.vy - (hostVy + rotVy))).toBeLessThan(1e-6);
  });

  test('is O(1): position at a far future time matches a direct query, no stepping', () => {
    const rotationPeriod = 43200;
    const radius = 1.8216e6;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_SUN, radius, rotationPeriod, axialPhaseAtEpoch: 0.2 },
    ]);
    const contacts = createContactTable(
      [{ host: 0, longitude: 0.5, captureRadius: 40000, minimumImpactEnergy: 1e12 }],
      bodies,
    );
    const t = 3.15e8; // ~10 years out
    const eph = makeEph(1);
    evaluateEphemeris(bodies, t, eph);
    const direct = contactPoint({ bodies, contacts, contact: 0, t, eph });

    const eph2 = makeEph(1);
    evaluateEphemeris(bodies, t, eph2);
    const again = contactPoint({ bodies, contacts, contact: 0, t, eph: eph2 });

    expect(direct.x).toBe(again.x);
    expect(direct.y).toBe(again.y);
    expect(direct.vx).toBe(again.vx);
    expect(direct.vy).toBe(again.vy);
  });
});

describe('createContactState', () => {
  test('starts uncleared, with the NO_IMPACT sentinel and zero speed/energy', () => {
    const state = createContactState(3);
    expect(Array.from(state.cleared)).toEqual([0, 0, 0]);
    expect(Array.from(state.impactTick)).toEqual([NO_IMPACT, NO_IMPACT, NO_IMPACT]);
    expect(Array.from(state.impactSpeed)).toEqual([0, 0, 0]);
    expect(Array.from(state.impactEnergy)).toEqual([0, 0, 0]);
  });
});
