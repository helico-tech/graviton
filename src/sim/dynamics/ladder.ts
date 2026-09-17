// Per-object, per-body substep ladder: the maximum of a dynamical-time
// ladder and a crossing-time ladder, both comparison loops with no
// logarithm and no division, ported from `level_dyn`/`level_cross` in
// p4_integrator.py and `levelFor` in q5_perf2.mjs (research §4.2, ADR-0005
// "Substep ladder"). This supersedes the single distance ladder in
// docs/domain/simulation-determinism.md rule 4: that rule under-refines by
// 1.5x in the exponent and ignores mass (research §4.1).
//
// The level is computed from one object's own state and the bodies alone,
// never from other objects, and must stay that way: it is what lets the
// same probe integrated alone and integrated in a crowd take identical
// substeps (research §4.3, the ghost invariant).

import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';

export const ETA = 0.05;
export const ZETA = 1 / 32;
export const L_MAX = 10;

/** k_dyn[b] = mu[b] * (dt/eta)^2, precomputed once at level load so the
 *  per-tick ladder never takes a cube root (research §4.4). */
export function computeKDyn(bodies: BodyTable, dt: number): Float64Array {
  const kDyn = new Float64Array(bodies.count);
  const c = dt / ETA;
  const c2 = c * c;
  for (let b = 0; b < bodies.count; b++) kDyn[b] = bodies.mu[b]! * c2;
  return kDyn;
}

/** Smallest L with 4^L r^3 >= kDyn: `dt/2^L <= eta*sqrt(r^3/mu)` rearranged
 *  to avoid both the logarithm and the cube root. Multiplying by 4 never
 *  rounds, so the boundary is exact. */
function dynamicalLevel(r3: number, kDyn: number): number {
  let s = r3;
  let L = 0;
  while (L < L_MAX && s < kDyn) {
    s *= 4;
    L++;
  }
  return L;
}

/** Smallest L with (dt/2^L) vRel <= zeta*r. Halving never rounds either. */
function crossingLevel(dt: number, vRel: number, zetaR: number): number {
  let s = dt * vRel;
  let L = 0;
  while (L < L_MAX && s > zetaR) {
    s *= 0.5;
    L++;
  }
  return L;
}

export interface SubstepLevelArgs {
  bodies: BodyTable;
  kDyn: Float64Array;
  dt: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Bodies' state at the tick's start time: the level is chosen from
   *  state at the tick's start (research §4.9). */
  eph: EphemerisOut;
}

/** The substep level for one object: the max over bodies of the dynamical
 *  and crossing ladders (research §4.2). */
export function substepLevel({ bodies, kDyn, dt, x, y, vx, vy, eph }: SubstepLevelArgs): number {
  let L = 0;
  for (let b = 0; b < bodies.count; b++) {
    const dx = x - eph.x[b]!;
    const dy = y - eph.y[b]!;
    const r2 = dx * dx + dy * dy;
    const r = Math.sqrt(r2);
    const r3 = r * r2;
    const l1 = dynamicalLevel(r3, kDyn[b]!);

    // v relative to the body, not the object's raw velocity: what matters
    // near a fast-moving moon is how quickly the gap closes.
    const rvx = vx - eph.vx[b]!;
    const rvy = vy - eph.vy[b]!;
    const vRel = Math.sqrt(rvx * rvx + rvy * rvy);
    const l2 = crossingLevel(dt, vRel, ZETA * r);

    const l = l1 > l2 ? l1 : l2;
    if (l > L) L = l;
  }
  return L;
}
