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

import { dexp } from '../math/kernels.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';
import type { ContactTable } from '../contacts.ts';

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

/** Smallest L with dt/2^L <= tBurnRemaining: guarantees at least one substep
 *  entirely inside an active burn (research §3.6's "burn ladder term").
 *  Same halving loop as crossingLevel. */
function burnLevel(dt: number, tBurnRemaining: number): number {
  let s = dt;
  let L = 0;
  while (L < L_MAX && s > tBurnRemaining) {
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
  /** Fixed contacts (GRV-0015): the crossing ladder against every contact,
   *  independent of `cleared` -- a ghost integrated alone must take the
   *  same substeps whichever contacts a crowd around it happens to have
   *  cleared (ghost isolation). Optional: callers with no contacts concept
   *  (most existing tests) omit both this and `contactEph` and get the
   *  body-only level. */
  contacts?: ContactTable;
  /** Contacts' state at the tick's start time, same shape as `eph`, one
   *  entry per `contacts` row -- computed once per tick (step.ts), never
   *  per object. */
  contactEph?: EphemerisOut;
  /** Burn state, from this object alone (research §3.6's burn ladder term;
   *  ghost isolation requires the level come only from the object's own
   *  state, never from other objects in its group). Optional: callers with
   *  no burn concept (or a non-burning object) can omit all of these and
   *  get the dynamical/crossing level alone. */
  burning?: number;
  mass?: number;
  thrust?: number;
  exhaustVelocity?: number;
  burnTarget?: number;
  burnDelivered?: number;
  /** Mass left when the tank is empty, kg (research §3.6). Bounds the burn
   *  term by the propellant actually left, not just the delta-v target --
   *  docs/issues/2026-09-17-burn-ladder-term-ignores-tank-exhaustion.md. */
  dryMass?: number;
}

/** The substep level for one object: the max over bodies of the dynamical
 *  and crossing ladders, plus the burn term while a burn is active
 *  (research §4.2, §3.6). */
export function substepLevel({
  bodies,
  kDyn,
  dt,
  x,
  y,
  vx,
  vy,
  eph,
  contacts,
  contactEph,
  burning = 0,
  mass = 0,
  thrust = 0,
  exhaustVelocity = 0,
  burnTarget = 0,
  burnDelivered = 0,
  dryMass = 0,
}: SubstepLevelArgs): number {
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

  // Crossing ladder against every fixed contact (GRV-0015, research §B.4:
  // "the substep ladder as specified does not refine on the target"),
  // independent of `cleared` -- a cleared contact still forces the same
  // refinement a ghost would see integrated alone, which is what keeps ghost
  // isolation holding with contacts present. r is floored at the contact's
  // own capture radius so the loop never chases r -> 0 as a probe centres on
  // it.
  if (contacts && contactEph) {
    for (let c = 0; c < contacts.count; c++) {
      const dx = x - contactEph.x[c]!;
      const dy = y - contactEph.y[c]!;
      const r = Math.sqrt(dx * dx + dy * dy);
      const captureRadius = contacts.captureRadius[c]!;
      const rFloored = r > captureRadius ? r : captureRadius;

      const rvx = vx - contactEph.vx[c]!;
      const rvy = vy - contactEph.vy[c]!;
      const vRel = Math.sqrt(rvx * rvx + rvy * rvy);
      const l = crossingLevel(dt, vRel, ZETA * rFloored);
      if (l > L) L = l;
    }
  }

  if (burning) {
    const mdot = thrust / exhaustVelocity;
    const rem = burnTarget - burnDelivered;
    const tauTarget = (mass / mdot) * (1 - dexp(-rem / exhaustVelocity));
    const tauDry = (mass - dryMass) / mdot;
    const tBurnRemaining = tauTarget < tauDry ? tauTarget : tauDry;
    const lBurn = burnLevel(dt, tBurnRemaining);
    if (lBurn > L) L = lBurn;
  }
  return L;
}
