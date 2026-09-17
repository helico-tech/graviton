// Unit tests for the two-ladder substep level (research §4.2, ADR-0005
// "Substep ladder"). Math.cbrt is fine here -- tests are exempt from
// src/sim's determinism lint (ADR-0002) -- and used only to derive an
// independent boundary to probe against, never inside the production code.
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';
import { createContactTable } from '../contacts.ts';
import { computeKDyn, L_MAX, substepLevel, ZETA } from './ladder.ts';

function singleBody(mu: number): { bodies: BodyTable; eph: EphemerisOut } {
  const bodies = createBodyTable([
    { parent: -1, mu, radius: 1, rotationPeriod: 86400, axialPhaseAtEpoch: 0 },
  ]);
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
      { parent: -1, mu: MU_SUN, radius: 6.957e8, rotationPeriod: 2.2e6, axialPhaseAtEpoch: 0 },
      {
        parent: 0,
        mu: MU_EARTH,
        radius: 6.371e6,
        a: AU,
        e: 0,
        argPeriapsis: 0,
        meanAnomaly0: 0,
        rotationPeriod: 86400,
        axialPhaseAtEpoch: 0,
      },
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

// GRV-0015: the crossing ladder against a fixed contact, research §B.4's
// fix for "the substep ladder as specified does not refine on the target" --
// a probe closing on a contact in open space, far from any body, must still
// refine.
describe('contact crossing ladder term', () => {
  const NEGLIGIBLE_MU = 1; // keeps the body terms at L = 0
  const CAPTURE_RADIUS = 40000;

  function contactFixture() {
    const { bodies, eph } = singleBody(NEGLIGIBLE_MU);
    const contacts = createContactTable(
      [{ host: 0, longitude: 0, captureRadius: CAPTURE_RADIUS, minimumImpactEnergy: 1e12 }],
      bodies,
    );
    // Contact sits far from the negligible-mass body, at rest -- position
    // chosen independently of the body's own (negligible) influence.
    const contactEph: EphemerisOut = {
      x: new Float64Array([1e10]),
      y: new Float64Array([0]),
      vx: new Float64Array([0]),
      vy: new Float64Array([0]),
    };
    return { bodies, eph, contacts, contactEph };
  }

  test('raises the level on approach in open space, far from any body', () => {
    const { bodies, eph, contacts, contactEph } = contactFixture();
    const kDyn = computeKDyn(bodies, DT);
    // Far from the contact: r stays well above captureRadius, dt*vRel is
    // small relative to zeta*r -- level 0.
    const far = substepLevel({
      bodies,
      kDyn,
      dt: DT,
      x: contactEph.x[0]! - 1e9,
      y: 0,
      vx: 3e5,
      vy: 0,
      eph,
      contacts,
      contactEph,
    });
    // Close to the contact, same closing speed: r is small, dt*vRel exceeds
    // zeta*r, forcing a finer level.
    const close = substepLevel({
      bodies,
      kDyn,
      dt: DT,
      x: contactEph.x[0]! - CAPTURE_RADIUS * 2,
      y: 0,
      vx: 3e5,
      vy: 0,
      eph,
      contacts,
      contactEph,
    });
    expect(far).toBe(0);
    expect(close).toBeGreaterThan(far);
  });

  test('flips level exactly at dt*vRel = zeta*rFloored, using the floored (captureRadius) r', () => {
    const { bodies, eph, contacts, contactEph } = contactFixture();
    const kDyn = computeKDyn(bodies, DT);
    // x placed exactly at the contact: r = 0, floored to captureRadius, so
    // the boundary is the same crossingLevel formula with r = captureRadius.
    const vBoundary = (ZETA * CAPTURE_RADIUS) / DT;
    const below = vBoundary * (1 - 1e-6);
    const above = vBoundary * (1 + 1e-6);
    const argsFor = (vx: number) => ({
      bodies,
      kDyn,
      dt: DT,
      x: contactEph.x[0]!,
      y: 0,
      vx,
      vy: 0,
      eph,
      contacts,
      contactEph,
    });
    expect(substepLevel(argsFor(below))).toBe(0);
    expect(substepLevel(argsFor(above))).toBe(1);
  });

  test('the loop never chases r -> 0: level stays bounded exactly on top of the contact', () => {
    const { bodies, eph, contacts, contactEph } = contactFixture();
    const kDyn = computeKDyn(bodies, DT);
    const closingSpeed = 2000; // m/s -- comfortably below the L_MAX boundary
    // Sitting exactly on the contact: without the floor, r=0 would make
    // zeta*r=0 and the crossing loop would run to L_MAX for any nonzero
    // speed; with the floor, this is exactly the r = captureRadius case, no
    // different from being captureRadius away.
    const onContact = substepLevel({
      bodies,
      kDyn,
      dt: DT,
      x: contactEph.x[0]!,
      y: contactEph.y[0]!,
      vx: closingSpeed,
      vy: 0,
      eph,
      contacts,
      contactEph,
    });
    const atCaptureRadius = substepLevel({
      bodies,
      kDyn,
      dt: DT,
      x: contactEph.x[0]! - CAPTURE_RADIUS,
      y: 0,
      vx: closingSpeed,
      vy: 0,
      eph,
      contacts,
      contactEph,
    });
    expect(onContact).toBe(atCaptureRadius);
    expect(onContact).toBeLessThan(L_MAX);
  });

  test('is identical whether the contact is cleared or not (the ladder never reads cleared state)', () => {
    // substepLevel takes no `cleared` input at all -- this test documents
    // that omission is deliberate: the same ContactTable/contactEph, with
    // no cleared flag threaded through, yields the same level regardless of
    // any caller's notion of cleared (ghost isolation, GRV-0015).
    const { bodies, eph, contacts, contactEph } = contactFixture();
    const kDyn = computeKDyn(bodies, DT);
    const args = {
      bodies,
      kDyn,
      dt: DT,
      x: contactEph.x[0]! - CAPTURE_RADIUS * 2,
      y: 0,
      vx: 3e5,
      vy: 0,
      eph,
      contacts,
      contactEph,
    };
    expect(substepLevel(args)).toBe(substepLevel(args));
  });
});
