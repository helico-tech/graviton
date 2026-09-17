// Unit tests for the two-ladder substep level (research §4.2, ADR-0005
// "Substep ladder"). Math.cbrt is fine here -- tests are exempt from
// src/sim's determinism lint (ADR-0002) -- and used only to derive an
// independent boundary to probe against, never inside the production code.
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';
import { computeKDyn, L_MAX, substepLevel, ZETA } from './ladder.ts';

function singleBody(mu: number): { bodies: BodyTable; eph: EphemerisOut } {
  const bodies = createBodyTable([{ parent: -1, mu, radius: 1 }]);
  const eph: EphemerisOut = {
    x: new Float64Array(1),
    y: new Float64Array(1),
    vx: new Float64Array(1),
    vy: new Float64Array(1),
  };
  evaluateEphemeris(bodies, 0, eph); // always the origin at rest: body 0 is the primary
  return { bodies, eph };
}

const DT = 60;

describe('dynamical ladder', () => {
  test('flips level exactly at 4^L r^3 = k_dyn, for two different L', () => {
    const { bodies, eph } = singleBody(1.3e17);
    const kDyn = computeKDyn(bodies, DT);
    for (const L of [1, 3]) {
      // r^3 = k_dyn / 4^(L-1) is the boundary between level L-1 and level L
      // (research §4.2's doubling loop): 4^(L-1) applied to r^3 sits just at
      // k_dyn. Probed with a tiny independent margin on either side.
      const rBoundary = Math.cbrt(kDyn[0]! / 4 ** (L - 1));
      const below = rBoundary * (1 - 1e-6);
      const above = rBoundary * (1 + 1e-6);
      expect(substepLevel({ bodies, kDyn, dt: DT, x: below, y: 0, vx: 0, vy: 0, eph })).toBe(L);
      expect(substepLevel({ bodies, kDyn, dt: DT, x: above, y: 0, vx: 0, vy: 0, eph })).toBe(L - 1);
    }
  });

  test('mass sensitivity: a gas giant refines more than a moonlet at the same range', () => {
    const r = 1e7;
    const moonlet = singleBody(1e10);
    const giant = singleBody(1.3e17);
    const levelMoonlet = substepLevel({
      bodies: moonlet.bodies,
      kDyn: computeKDyn(moonlet.bodies, DT),
      dt: DT,
      x: r,
      y: 0,
      vx: 0,
      vy: 0,
      eph: moonlet.eph,
    });
    const levelGiant = substepLevel({
      bodies: giant.bodies,
      kDyn: computeKDyn(giant.bodies, DT),
      dt: DT,
      x: r,
      y: 0,
      vx: 0,
      vy: 0,
      eph: giant.eph,
    });
    expect(levelMoonlet).toBe(0);
    expect(levelGiant).toBeGreaterThan(levelMoonlet);
  });

  test('clamps to L_MAX rather than looping past it', () => {
    const { bodies, eph } = singleBody(1e20);
    const kDyn = computeKDyn(bodies, DT);
    const level = substepLevel({ bodies, kDyn, dt: DT, x: 1, y: 0, vx: 0, vy: 0, eph });
    expect(level).toBe(L_MAX);
  });
});

describe('crossing ladder', () => {
  test("uses velocity relative to the body, not the object's raw velocity", () => {
    // Earth-like body on a fast (~29.8 km/s) circular orbit around the Sun,
    // object placed just outside it (2 body radii) so body 1 dominates the
    // ladder and the distant Sun contributes level 0 regardless of velocity
    // (research §4.2's "v_rel ... relative to the body").
    const MU_SUN = 1.32712440018e20;
    const MU_EARTH = 3.986004418e14;
    const AU = 1.495978707e11;
    const bodies = createBodyTable([
      { parent: -1, mu: MU_SUN, radius: 6.957e8 },
      { parent: 0, mu: MU_EARTH, radius: 6.371e6, a: AU, e: 0, argPeriapsis: 0, meanAnomaly0: 0 },
    ]);
    const eph: EphemerisOut = {
      x: new Float64Array(2),
      y: new Float64Array(2),
      vx: new Float64Array(2),
      vy: new Float64Array(2),
    };
    evaluateEphemeris(bodies, 12345, eph);
    const kDyn = computeKDyn(bodies, DT);
    const offset = 2 * 6.371e6;
    const x = eph.x[1]! + offset;
    const y = eph.y[1]!;

    // Object matches body 1's velocity exactly: relative velocity is zero,
    // even though the object's absolute (inertial) speed is ~29.8 km/s.
    const matchingVelocity = substepLevel({
      bodies,
      kDyn,
      dt: DT,
      x,
      y,
      vx: eph.vx[1]!,
      vy: eph.vy[1]!,
      eph,
    });
    expect(matchingVelocity).toBe(0);

    // Object at rest in the inertial frame: absolute speed is zero, but
    // relative to body 1 it is the full ~29.8 km/s orbital speed.
    const stationaryObject = substepLevel({ bodies, kDyn, dt: DT, x, y, vx: 0, vy: 0, eph });
    expect(stationaryObject).toBeGreaterThan(0);
  });

  test('flips level exactly at dt*vRel = zeta*r', () => {
    const { bodies, eph } = singleBody(1); // negligible mass: dynamical ladder stays at 0
    const kDyn = computeKDyn(bodies, DT);
    const r = 1e6;
    const vBoundary = (ZETA * r) / DT;
    const below = vBoundary * (1 - 1e-6);
    const above = vBoundary * (1 + 1e-6);
    expect(substepLevel({ bodies, kDyn, dt: DT, x: r, y: 0, vx: below, vy: 0, eph })).toBe(0);
    expect(substepLevel({ bodies, kDyn, dt: DT, x: r, y: 0, vx: above, vy: 0, eph })).toBe(1);
  });
});

describe('burn ladder term', () => {
  // research §3.6: m_wet 1500 kg, v_e 30 km/s, T 4 kN. The doc's own "a 10
  // m/s burn lasts 3.75 s" is the linear approximation (m*dv/T); the exact
  // rocket-equation value (what production code, and remForTBurn below,
  // actually compute) is 3.7494 s -- just under the dt/16 = 3.75 boundary,
  // one level finer than the prose's rounded illustration. Boundary probed
  // directly instead of trusting that coincidence, matching the dynamical
  // ladder's own boundary test above.
  const NEGLIGIBLE_MU = 1; // keeps the dynamical/crossing terms at L = 0
  const MASS = 1500;
  const THRUST = 4000;
  const EXHAUST_VELOCITY = 30000;
  const MDOT = THRUST / EXHAUST_VELOCITY;

  // Inverse of production's t_burn(rem) = (m/mdot)*(1 - exp(-rem/ve))
  // (research §3.6), solved for the rem whose burn time is exactly
  // tBurn. Math.exp/Math.log are fine here -- tests are exempt from
  // src/sim's determinism lint (ADR-0002) -- and used only to derive an
  // independent boundary to probe against, never inside the production
  // code.
  function remForTBurn(tBurn: number): number {
    return -EXHAUST_VELOCITY * Math.log(1 - (tBurn * MDOT) / MASS);
  }

  test('flips level exactly at dt/2^L = t_burn_remaining, for two different L', () => {
    const { bodies, eph } = singleBody(NEGLIGIBLE_MU);
    const kDyn = computeKDyn(bodies, DT);
    for (const L of [3, 5]) {
      // tBoundary = dt/2^(L-1) sits just at the boundary between level
      // L-1 and level L (burnLevel's halving loop); probed with a tiny
      // independent margin on either side, converted to the rem that
      // produces that burn time.
      const tBoundary = DT / 2 ** (L - 1);
      const below = remForTBurn(tBoundary * (1 - 1e-6));
      const above = remForTBurn(tBoundary * (1 + 1e-6));
      const argsFor = (rem: number) => ({
        bodies,
        kDyn,
        dt: DT,
        x: 1e13,
        y: 0,
        vx: 0,
        vy: 0,
        eph,
        burning: 1,
        mass: MASS,
        thrust: THRUST,
        exhaustVelocity: EXHAUST_VELOCITY,
        burnTarget: rem,
        burnDelivered: 0,
      });
      expect(substepLevel(argsFor(below))).toBe(L);
      expect(substepLevel(argsFor(above))).toBe(L - 1);
    }
  });

  test('level returns to 0 once the burn has ended', () => {
    const { bodies, eph } = singleBody(NEGLIGIBLE_MU);
    const kDyn = computeKDyn(bodies, DT);
    const level = substepLevel({
      bodies,
      kDyn,
      dt: DT,
      x: 1e13,
      y: 0,
      vx: 0,
      vy: 0,
      eph,
      burning: 0,
      mass: 1500,
      thrust: THRUST,
      exhaustVelocity: EXHAUST_VELOCITY,
      burnTarget: 10,
      burnDelivered: 10,
    });
    expect(level).toBe(0);
  });

  // docs/issues/2026-09-17-burn-ladder-term-ignores-tank-exhaustion.md: the
  // ladder term must use min(t_target_remaining, (m - dryMass)/mdot), not
  // t_target_remaining alone, or a tank that runs dry inside the next tick
  // goes unrefined right when it matters most.
  test('a tank-limited burn gets the finer level the target-only formula misses', () => {
    const { bodies, eph } = singleBody(NEGLIGIBLE_MU);
    const kDyn = computeKDyn(bodies, DT);
    const args = {
      bodies,
      kDyn,
      dt: DT,
      x: 1e13,
      y: 0,
      vx: 0,
      vy: 0,
      eph,
      burning: 1,
      mass: 1500,
      thrust: THRUST,
      exhaustVelocity: EXHAUST_VELOCITY,
      burnTarget: 5000, // far from reached: t_target_remaining ~= 1726 s
      burnDelivered: 0,
    };
    // Without dryMass, the ladder only sees the far-off delta-v target and
    // stays coarse...
    expect(substepLevel(args)).toBe(0);
    // ...but with 3 kg of propellant left (tauDry = 3/mdot = 22.5 s), the
    // tank runs dry inside the next tick (dt = 60 s): dt/2 = 30 > 22.5,
    // dt/4 = 15 <= 22.5, so the tank-aware term must land on level 2.
    expect(substepLevel({ ...args, dryMass: 1497 })).toBe(2);
  });
});
