// PEFRL (Position-Extended Forest-Ruth-Like), Omelyan, Mryglod & Folk,
// Comput. Phys. Commun. 146 (2002) 188, ported from `step_pefrl` /
// `pefrlGroup` in docs/research/2026-09-03-02-simulation-numerics-probes/
// p4_integrator.py and q5_perf2.mjs (research §3.4-3.5, ADR-0005
// "Integrator"). Four force evaluations, fourth order, symplectic;
// coefficients come from a cube root and a numerical optimisation, so they
// are literals rather than runtime computation.
//
// The whole group shares each of the five drift stages and four kick
// stages, so the ephemeris -- the dominant cost -- is evaluated once per
// stage for the group rather than once per object (research §3.3, §3.5).
// Two of the five drift coefficients are negative (CHI < 0): the substep
// briefly steps backwards in time, harmless for an analytic ephemeris, but
// exactly why collision and surface tests belong on substep endpoints only
// (src/sim/dynamics/step.ts), never inside this function.

import { dexp, dlog } from '../math/kernels.ts';
import { evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';

const XI = 0.1786178958448091;
const LAM = -0.2123418310626054;
const CHI = -0.06626458266981849;
const K1 = (1 - 2 * LAM) * 0.5; // 0.7123418310626054
const D3 = 1 - 2 * (CHI + XI); // 0.7753065776500187

/** The dense object arrays a substep moves. Structural, not imported from
 *  step.ts: step.ts's DynamicObjects satisfies this shape and passing it
 *  needs no import, so the two files stay decoupled. */
export interface PefrlObjects {
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** -1 = not hit; a hit object is skipped by every drift and kick so it
   *  freezes at the position and velocity it had when it hit. */
  hitBody: Int32Array;
  /** -1 = none; a probe that cleared or merely impacted a fixed contact
   *  (GRV-0015) is expended exactly like a body hit -- skipped by every
   *  drift and kick alongside hitBody, so "expended" is `hitBody !== -1 ||
   *  hitContact !== -1`, never a single flag derived from the two. */
  hitContact: Int32Array;
  /** Current propellant + dry mass, kg. Untouched unless `burning`. */
  mass: Float64Array;
  /** Mass left when the tank is empty, kg (research §3.6). */
  dryMass: Float64Array;
  /** Maximum thrust, N -- burns always run at max thrust. */
  thrust: Float64Array;
  /** Effective exhaust velocity, m/s. */
  exhaustVelocity: Float64Array;
  /** Thrust direction, frozen at activation (startBurn in burn.ts), unit. */
  burnNx: Float64Array;
  burnNy: Float64Array;
  /** Requested |delta-v| for the active burn, m/s. */
  burnTarget: Float64Array;
  /** Delta-v delivered so far, m/s; equals burnTarget exactly once the burn
   *  ends (research §3.6 / P11e). */
  burnDelivered: Float64Array;
  /** Explicit state, not derived from burnDelivered vs burnTarget: 1 while
   *  a burn is active, 0 otherwise. */
  burning: Uint8Array;
}

function drift(objects: PefrlObjects, idx: Int32Array, n: number, h: number): void {
  for (let j = 0; j < n; j++) {
    const i = idx[j]!;
    if (objects.hitBody[i] !== -1 || objects.hitContact[i] !== -1) continue;
    objects.x[i]! += h * objects.vx[i]!;
    objects.y[i]! += h * objects.vy[i]!;
  }
}

/** Gravity from every body, point masses only: dynamic objects never
 *  attract each other (ADR-0005 "Dynamic objects"), which is what keeps
 *  the per-object substep ladder exact and the ghost invariant holding in
 *  a crowd (research §4.3). Burning objects add a thrust term along the
 *  frozen direction, cutting on the accumulated delta-v with the final
 *  stage solved analytically (research §3.6 / P11e); see the comment
 *  below for how that combines with PEFRL's signed kick weights. */
function kick(
  objects: PefrlObjects,
  idx: Int32Array,
  n: number,
  bodies: BodyTable,
  eph: EphemerisOut,
  hk: number,
): void {
  for (let j = 0; j < n; j++) {
    const i = idx[j]!;
    if (objects.hitBody[i] !== -1 || objects.hitContact[i] !== -1) continue;
    const px = objects.x[i]!;
    const py = objects.y[i]!;
    let ax = 0;
    let ay = 0;
    for (let b = 0; b < bodies.count; b++) {
      const dx = px - eph.x[b]!;
      const dy = py - eph.y[b]!;
      const r2 = dx * dx + dy * dy;
      const r = Math.sqrt(r2);
      const k = -bodies.mu[b]! / (r2 * r);
      ax += k * dx;
      ay += k * dy;
    }

    if (objects.burning[i]) {
      // Mass and the delivered-delta-v accumulator move by the *same
      // signed* hk the velocity kick below uses, not abs(hk): PEFRL's LAM
      // kicks are negative (a device of the symmetric composition, see the
      // file header -- two of the five drifts are negative for the same
      // reason), not a reversal of the propellant clock, so a kick's
      // contribution to mass and to the accumulator must scale with hk
      // exactly the way its contribution to vx/vy does. Using abs(hk)
      // breaks that: a LAM kick would burn propellant forward while the
      // velocity it produces runs backward, decoupling the two and
      // mis-timing the cutoff by tens of percent (measured while porting
      // this unit -- see docs/evidence/GRV-0007). A burn therefore only
      // *finishes* on a positive (K1) kick: a negative kick can't
      // represent forward progress towards a target or a dry tank, so it
      // never carries the analytic final-stage solve.
      //
      // The delta-v each kick delivers is the *exact* rocket equation for
      // the mass it actually consumes (ve * ln(before/after)), not a
      // midpoint-mass thrust/m_mid estimate: the two agree only to the
      // quadrature's own order, and over many ordinary kicks that residual
      // is enough to miss the 1e-9 mass bar (measured up to 5.6e-8
      // relative) even though the accumulator still hits the delta-v
      // target exactly. The exact form costs one dlog and holds both bars
      // at once.
      const thrust = objects.thrust[i]!;
      const ve = objects.exhaustVelocity[i]!;
      const mdot = thrust / ve;
      const m = objects.mass[i]!;
      const dry = objects.dryMass[i]!;

      let delivered: number;
      if (hk > 0) {
        const rem = objects.burnTarget[i]! - objects.burnDelivered[i]!;
        const tauTarget = (m / mdot) * (1 - dexp(-rem / ve));
        const tauDry = (m - dry) / mdot;
        if (tauTarget < hk && tauTarget <= tauDry) {
          // Final partial stage, target-limited (research §3.6 / P11e):
          // tau solved analytically from the rocket equation. Delivered is
          // rem itself, not re-derived through dlog, so the accumulator
          // lands on the target exactly rather than to within dexp/dlog's
          // own round-trip precision.
          delivered = rem;
          objects.mass[i] = m - mdot * tauTarget;
          objects.burning[i] = 0;
        } else if (tauDry < hk) {
          // Final partial stage, tank-limited: same treatment, cut on the
          // mass floor instead of the delta-v target.
          delivered = ve * dlog(m / dry);
          objects.mass[i] = dry;
          objects.burning[i] = 0;
        } else {
          const mAfter = m - mdot * hk;
          delivered = ve * dlog(m / mAfter);
          objects.mass[i] = mAfter;
        }
      } else {
        const mAfter = m - mdot * hk; // hk < 0: mAfter > m, a transient partial "regain"
        delivered = ve * dlog(m / mAfter);
        objects.mass[i] = mAfter;
      }
      objects.burnDelivered[i] = objects.burnDelivered[i]! + delivered;

      // Time-averaged over the whole kick, matching how a fractional-f
      // contribution folds into the shared ax/ay below (research §3.5).
      const aThAvg = delivered / hk;
      ax += aThAvg * objects.burnNx[i]!;
      ay += aThAvg * objects.burnNy[i]!;
    }

    objects.vx[i]! += hk * ax;
    objects.vy[i]! += hk * ay;
  }
}

export interface PefrlSubstepArgs {
  bodies: BodyTable;
  objects: PefrlObjects;
  idx: Int32Array;
  n: number;
  t: number;
  h: number;
  /** Caller-owned scratch, overwritten at each of the four stages. */
  eph: EphemerisOut;
}

/** Advances every non-hit object named in idx[0..n) by one substep of
 *  length h starting at time t: five drifts, four kicks, the ephemeris
 *  evaluated once per stage for the whole group (research §3.5's
 *  pefrlSubstep). No allocation. */
export function pefrlSubstep({ bodies, objects, idx, n, t, h, eph }: PefrlSubstepArgs): void {
  drift(objects, idx, n, XI * h);
  evaluateEphemeris(bodies, t + XI * h, eph);
  kick(objects, idx, n, bodies, eph, K1 * h);

  drift(objects, idx, n, CHI * h);
  evaluateEphemeris(bodies, t + (XI + CHI) * h, eph);
  kick(objects, idx, n, bodies, eph, LAM * h);

  drift(objects, idx, n, D3 * h);
  evaluateEphemeris(bodies, t + (XI + CHI + D3) * h, eph);
  kick(objects, idx, n, bodies, eph, LAM * h);

  drift(objects, idx, n, CHI * h);
  evaluateEphemeris(bodies, t + (XI + 2 * CHI + D3) * h, eph);
  kick(objects, idx, n, bodies, eph, K1 * h);

  drift(objects, idx, n, XI * h);
}
