// Physics invariants rather than golden bit patterns: the Kepler solver's own
// exactness is already pinned in kepler.test.ts, so this exercises the parent
// chain composition and the state-vector formulas (research §1.3-1.4) against
// closed-form orbital mechanics. Math.* is fine here -- this file is a test,
// exempt from src/sim's determinism lint (ADR-0002), and never part of the
// simulation itself.
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from './bodies.ts';
import type { BodyDef, EphemerisOut } from './bodies.ts';

const MU_SUN = 1.32712440018e20;
const MU_EARTH = 3.986004418e14;
const MU_MOON = 4.9048695e12;
const AU = 1.495978707e11;

function makeOut(n: number): EphemerisOut {
  return {
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
  };
}

describe('createBodyTable validation', () => {
  const sun: BodyDef = { parent: -1, mu: MU_SUN, radius: 6.957e8 };
  const earthlike: BodyDef = {
    parent: 0,
    mu: MU_EARTH,
    radius: 6.371e6,
    a: AU,
    e: 0.1,
    argPeriapsis: 0,
    meanAnomaly0: 0,
  };

  test('throws when eccentricity exceeds 0.8', () => {
    expect(() => createBodyTable([sun, { ...earthlike, e: 0.81 }])).toThrow();
  });

  test('throws when eccentricity is negative', () => {
    expect(() => createBodyTable([sun, { ...earthlike, e: -0.001 }])).toThrow();
  });

  test('throws when parent[i] >= i', () => {
    expect(() => createBodyTable([sun, { ...earthlike, parent: 1 }])).toThrow();
    expect(() => createBodyTable([sun, { ...earthlike, parent: 2 }])).toThrow();
  });

  test('throws when semi-major axis is non-positive', () => {
    expect(() => createBodyTable([sun, { ...earthlike, a: 0 }])).toThrow();
    expect(() => createBodyTable([sun, { ...earthlike, a: -AU }])).toThrow();
  });

  test('throws when mu is non-positive', () => {
    expect(() => createBodyTable([{ ...sun, mu: 0 }, earthlike])).toThrow();
    expect(() => createBodyTable([sun, { ...earthlike, mu: -1 }])).toThrow();
  });

  test('accepts a valid table', () => {
    expect(() => createBodyTable([sun, earthlike])).not.toThrow();
  });
});

describe('circular orbit', () => {
  const a = AU;
  const table = createBodyTable([
    { parent: -1, mu: MU_SUN, radius: 6.957e8 },
    { parent: 0, mu: MU_EARTH, radius: 6.371e6, a, e: 0, argPeriapsis: 0, meanAnomaly0: 0 },
  ]);
  const out = makeOut(2);
  const meanMotion = Math.sqrt(MU_SUN / (a * a * a));
  const period = (2 * Math.PI) / meanMotion;

  test('radius stays constant to ~1e-9 relative', () => {
    let minR = Infinity;
    let maxR = 0;
    for (let i = 0; i <= 200; i++) {
      evaluateEphemeris(table, (period * i) / 200, out);
      const r = Math.hypot(out.x[1]!, out.y[1]!);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
    expect((maxR - minR) / a).toBeLessThan(1e-9);
  });

  test('speed equals sqrt(mu/a)', () => {
    evaluateEphemeris(table, period * 0.37, out);
    const speed = Math.hypot(out.vx[1]!, out.vy[1]!);
    const expected = Math.sqrt(MU_SUN / a);
    expect(Math.abs(speed - expected) / expected).toBeLessThan(1e-9);
  });

  test('returns to start after one period', () => {
    evaluateEphemeris(table, 0, out);
    const x0 = out.x[1]!;
    const y0 = out.y[1]!;
    evaluateEphemeris(table, period, out);
    expect(Math.abs(out.x[1]! - x0) / a).toBeLessThan(1e-9);
    expect(Math.abs(out.y[1]! - y0) / a).toBeLessThan(1e-9);
  });
});

describe('eccentric orbit (e=0.5)', () => {
  const a = AU;
  const e = 0.5;
  const table = createBodyTable([
    { parent: -1, mu: MU_SUN, radius: 6.957e8 },
    { parent: 0, mu: MU_EARTH, radius: 6.371e6, a, e, argPeriapsis: 0, meanAnomaly0: 0 },
  ]);
  const out = makeOut(2);
  const meanMotion = Math.sqrt(MU_SUN / (a * a * a));
  const period = (2 * Math.PI) / meanMotion;

  test('periapsis and apoapsis distances are a(1-e) and a(1+e)', () => {
    evaluateEphemeris(table, 0, out); // M0 = 0 -> E = 0 -> periapsis
    const rPeri = Math.hypot(out.x[1]!, out.y[1]!);
    expect(Math.abs(rPeri - a * (1 - e)) / a).toBeLessThan(1e-9);

    evaluateEphemeris(table, period / 2, out); // M = pi -> E = pi -> apoapsis
    const rApo = Math.hypot(out.x[1]!, out.y[1]!);
    expect(Math.abs(rApo - a * (1 + e)) / a).toBeLessThan(1e-9);
  });

  test('vis-viva speed matches sqrt(mu(2/r - 1/a)) at several anomalies', () => {
    for (const frac of [0, 0.1, 0.25, 0.4, 0.6, 0.9]) {
      evaluateEphemeris(table, period * frac, out);
      const r = Math.hypot(out.x[1]!, out.y[1]!);
      const speed = Math.hypot(out.vx[1]!, out.vy[1]!);
      const expected = Math.sqrt(MU_SUN * (2 / r - 1 / a));
      expect(Math.abs(speed - expected) / expected).toBeLessThan(1e-9);
    }
  });

  test('specific angular momentum is conserved', () => {
    let h0 = 0;
    [0, 0.15, 0.3, 0.5, 0.7, 0.95].forEach((frac, i) => {
      evaluateEphemeris(table, period * frac, out);
      const h = out.x[1]! * out.vy[1]! - out.y[1]! * out.vx[1]!;
      if (i === 0) {
        h0 = h;
      } else {
        expect(Math.abs(h - h0) / Math.abs(h0)).toBeLessThan(1e-9);
      }
    });
  });

  test('velocity is consistent with a centred finite difference of position', () => {
    const t0 = period * 0.3;
    const dt = 1; // seconds, tiny compared to the ~year-scale period
    evaluateEphemeris(table, t0 - dt, out);
    const xm = out.x[1]!;
    const ym = out.y[1]!;
    evaluateEphemeris(table, t0 + dt, out);
    const xp = out.x[1]!;
    const yp = out.y[1]!;
    const vxFD = (xp - xm) / (2 * dt);
    const vyFD = (yp - ym) / (2 * dt);
    evaluateEphemeris(table, t0, out);
    // Measured ~4e-10 (dominated by the finite-difference truncation error
    // itself, not the ephemeris): docs/evidence/GRV-0005/README.md.
    expect(Math.abs(out.vx[1]! - vxFD) / Math.abs(out.vx[1]!)).toBeLessThan(1e-8);
    expect(Math.abs(out.vy[1]! - vyFD) / Math.abs(out.vy[1]!)).toBeLessThan(1e-8);
  });
});

describe('moon: three-level parent chain', () => {
  test("a moon's primary-centred state equals its parent's plus its own relative state", () => {
    const planet: BodyDef = {
      parent: 0,
      mu: MU_EARTH,
      radius: 6.371e6,
      a: AU,
      e: 0.02,
      argPeriapsis: 0.4,
      meanAnomaly0: 1.1,
    };
    const moonRelative: BodyDef = {
      parent: 0,
      mu: MU_MOON,
      radius: 1.737e6,
      a: 3.844e8,
      e: 0.0549,
      argPeriapsis: 0.9,
      meanAnomaly0: 2.7,
    };

    const full = createBodyTable([
      { parent: -1, mu: MU_SUN, radius: 6.957e8 },
      planet,
      { ...moonRelative, parent: 1 },
    ]);
    // The moon's orbit treated stand-alone, with its parent as the primary:
    // an independent computation of "the moon's own relative state" that
    // never goes through the three-level chain's offset composition.
    const standalone = createBodyTable([
      { parent: -1, mu: planet.mu, radius: planet.radius },
      moonRelative,
    ]);

    const outFull = makeOut(3);
    const outStandalone = makeOut(2);
    const t = 1.5e7;
    evaluateEphemeris(full, t, outFull);
    evaluateEphemeris(standalone, t, outStandalone);

    // Measured ~5e-15 (double-precision floor for two independent 3-level
    // vs. 2-level compositions): docs/evidence/GRV-0005/README.md.
    const relErr = (actual: number, expected: number): number =>
      Math.abs(actual - expected) / Math.abs(expected);
    expect(relErr(outFull.x[2]! - outFull.x[1]!, outStandalone.x[1]!)).toBeLessThan(1e-11);
    expect(relErr(outFull.y[2]! - outFull.y[1]!, outStandalone.y[1]!)).toBeLessThan(1e-11);
    expect(relErr(outFull.vx[2]! - outFull.vx[1]!, outStandalone.vx[1]!)).toBeLessThan(1e-11);
    expect(relErr(outFull.vy[2]! - outFull.vy[1]!, outStandalone.vy[1]!)).toBeLessThan(1e-11);
  });
});

describe('large t', () => {
  test('a 10-year query still works and matches the time-reduced equivalent', () => {
    const a = 1e7; // fast, low orbit: many periods over 10 years
    const table = createBodyTable([
      { parent: -1, mu: MU_EARTH, radius: 6.371e6 },
      { parent: 0, mu: 100, radius: 1, a, e: 0.1, argPeriapsis: 0.3, meanAnomaly0: 0.5 },
    ]);
    const meanMotion = Math.sqrt(MU_EARTH / (a * a * a));
    const period = (2 * Math.PI) / meanMotion;
    const tenYears = 10 * 365.25 * 86400;

    const out = makeOut(2);
    expect(() => evaluateEphemeris(table, tenYears, out)).not.toThrow();

    const outReduced = makeOut(2);
    evaluateEphemeris(table, tenYears % period, outReduced);
    // Measured ~1.8e-11 (`%`'s and the reduction's independent roundoff over
    // ~3.15e8 s): docs/evidence/GRV-0005/README.md.
    expect(Math.abs(out.x[1]! - outReduced.x[1]!) / a).toBeLessThan(1e-9);
    expect(Math.abs(out.y[1]! - outReduced.y[1]!) / a).toBeLessThan(1e-9);
  });
});
