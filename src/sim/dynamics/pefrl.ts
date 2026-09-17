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
}

function drift(objects: PefrlObjects, idx: Int32Array, n: number, h: number): void {
  for (let j = 0; j < n; j++) {
    const i = idx[j]!;
    if (objects.hitBody[i] !== -1) continue;
    objects.x[i]! += h * objects.vx[i]!;
    objects.y[i]! += h * objects.vy[i]!;
  }
}

/** Gravity from every body, point masses only: dynamic objects never
 *  attract each other (ADR-0005 "Dynamic objects"), which is what keeps
 *  the per-object substep ladder exact and the ghost invariant holding in
 *  a crowd (research §4.3). */
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
    if (objects.hitBody[i] !== -1) continue;
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
