// Tier two of the two-tier model (docs/domain/simulation-determinism.md):
// dynamic objects integrated in the field of the tier-one bodies, ported
// from `tick`/`levelFor` in q5_perf2.mjs (research §3.5, §4.2). Objects
// live as dense arrays iterated by index only (determinism rule 5). Groups
// are built fresh each tick from state alone, so the ladder in ladder.ts
// stays the only thing that decides how finely an object is integrated.
//
// Surface collision is tested on substep endpoints only, never on a PEFRL
// stage (research §3.4): after each substep the ephemeris is evaluated
// again at the exact endpoint time, because the group's last kick stage
// lands at a fraction of h short of the endpoint (XI+2*CHI+D3 =~ 0.8214),
// not at the endpoint itself. Finite burns (mass depletion, thrust kick,
// ladder term) are pefrl.ts's and ladder.ts's (GRV-0007).
//
// Fixed-contact impact (GRV-0015, research §B.4): tested per substep,
// before the body-surface test of that substep, on the swept segment of the
// probe's position *relative to the contact* -- endpoint sampling alone
// misses a contact crossed between two substep endpoints. `evaluateContacts`
// needs the contact's host state at the substep's start and end; the end
// evaluation already exists for the body-surface test, so it is reused as
// the *next* substep's start rather than evaluated twice.

import { evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';
import { evaluateContacts } from '../contacts.ts';
import type { ContactState, ContactTable } from '../contacts.ts';
import { computeKDyn, L_MAX, substepLevel } from './ladder.ts';
import { pefrlSubstep } from './pefrl.ts';
import type { PefrlObjects } from './pefrl.ts';

export interface DynamicObjects extends PefrlObjects {
  count: number;
}

export function createDynamicObjects(capacity: number): DynamicObjects {
  const hitBody = new Int32Array(capacity);
  hitBody.fill(-1);
  const hitContact = new Int32Array(capacity);
  hitContact.fill(-1);
  return {
    count: 0,
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    vx: new Float64Array(capacity),
    vy: new Float64Array(capacity),
    hitBody,
    hitContact,
    mass: new Float64Array(capacity),
    dryMass: new Float64Array(capacity),
    thrust: new Float64Array(capacity),
    exhaustVelocity: new Float64Array(capacity),
    burnNx: new Float64Array(capacity),
    burnNy: new Float64Array(capacity),
    burnTarget: new Float64Array(capacity),
    burnDelivered: new Float64Array(capacity),
    burning: new Uint8Array(capacity),
  };
}

function makeEph(n: number): EphemerisOut {
  return {
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
  };
}

export interface StepScratch {
  /** mu[b] * (dt/eta)^2 per body, computed once for this scratch's dt. */
  kDyn: Float64Array;
  /** Bodies' ephemeris at the tick's start time, filled once per tick and
   *  never mutated again: both the grouping pass's ladder call and every
   *  level's s=0 substep read it as "the start of this instant" (GRV-0015 --
   *  `eph` below is instead clobbered repeatedly within the substep loop,
   *  so it cannot serve that second purpose once a level other than the
   *  first-processed one begins). */
  tickStartEph: EphemerisOut;
  eph: EphemerisOut;
  /** Contacts' position/velocity at the tick's start time (GRV-0015): the
   *  ladder's batch input, and every level's s=0 substep's p0 source. */
  contactEph: EphemerisOut;
  /** This substep's swept-segment endpoints for every contact, in the
   *  probe-independent (host-only) frame: p0 is copied from `contactEph`
   *  (s=0) or the previous substep's p1 (s>0, GRV-0015's reuse); p1 is
   *  evaluated fresh each substep from `eph` once it holds the endpoint. */
  contactP0: EphemerisOut;
  contactP1: EphemerisOut;
  /** Probe positions at the current substep's start, snapshotted before
   *  `pefrlSubstep` moves them: the impact test needs both endpoints of the
   *  swept segment (GRV-0015). */
  objStartX: Float64Array;
  objStartY: Float64Array;
  /** One preallocated index buffer per level, sized to capacity. */
  groupIndex: Int32Array[];
  groupCount: Int32Array;
}

export function createStepScratch({
  bodies,
  contacts,
  dt,
  capacity,
}: {
  bodies: BodyTable;
  contacts: ContactTable;
  dt: number;
  capacity: number;
}): StepScratch {
  const groupIndex: Int32Array[] = [];
  for (let l = 0; l <= L_MAX; l++) groupIndex.push(new Int32Array(capacity));
  return {
    kDyn: computeKDyn(bodies, dt),
    tickStartEph: makeEph(bodies.count),
    eph: makeEph(bodies.count),
    contactEph: makeEph(contacts.count),
    contactP0: makeEph(contacts.count),
    contactP1: makeEph(contacts.count),
    objStartX: new Float64Array(capacity),
    objStartY: new Float64Array(capacity),
    groupIndex,
    groupCount: new Int32Array(L_MAX + 1),
  };
}

/** expended: hit a body, or hit/cleared a fixed contact -- the two freezing
 *  causes, checked together everywhere an object's liveness decides whether
 *  it still moves, is grouped, or can arm a pending burn (GRV-0015). */
function expended(objects: DynamicObjects, i: number): boolean {
  return objects.hitBody[i]! !== -1 || objects.hitContact[i]! !== -1;
}

function testCollisions({
  bodies,
  objects,
  idx,
  n,
  eph,
}: {
  bodies: BodyTable;
  objects: DynamicObjects;
  idx: Int32Array;
  n: number;
  eph: EphemerisOut;
}): void {
  for (let j = 0; j < n; j++) {
    const i = idx[j]!;
    if (expended(objects, i)) continue;
    const px = objects.x[i]!;
    const py = objects.y[i]!;
    for (let b = 0; b < bodies.count; b++) {
      const dx = px - eph.x[b]!;
      const dy = py - eph.y[b]!;
      const radius = bodies.radius[b]!;
      if (dx * dx + dy * dy <= radius * radius) {
        objects.hitBody[i] = b;
        // Every kick and drift after this skips a hit object (pefrl.ts), so
        // a still-armed burn would freeze mid-burn instead of ending: clear
        // it here, at the same substep endpoint, so `burning` stays
        // consistent with `hitBody` for hashSim/serializeSim (state-driven,
        // not derived).
        objects.burning[i] = 0;
        break;
      }
    }
  }
}

function copyContactPositions(dst: EphemerisOut, src: EphemerisOut, count: number): void {
  for (let c = 0; c < count; c++) {
    dst.x[c] = src.x[c]!;
    dst.y[c] = src.y[c]!;
  }
}

function snapshotObjectStart(
  objects: DynamicObjects,
  idx: Int32Array,
  n: number,
  outX: Float64Array,
  outY: Float64Array,
): void {
  for (let j = 0; j < n; j++) {
    const i = idx[j]!;
    outX[i] = objects.x[i]!;
    outY[i] = objects.y[i]!;
  }
}

/** Closest approach of the probe's position relative to a contact, on the
 *  swept segment p0 -> p1 (relative motion over the substep, not endpoint
 *  sampling -- research §B.4): if several contacts are within reach in the
 *  same substep, the smallest `s` (earliest along the segment) wins, ties
 *  by lowest contact index -- guaranteed by scanning contacts in ascending
 *  index and only replacing on a strictly smaller `s`. Cleared contacts are
 *  skipped: a consolidated hulk that already broke up cannot catch anything
 *  else. */
function testContactImpacts({
  objects,
  idx,
  n,
  h,
  tick,
  contacts,
  contactState,
  p0,
  p1,
  objStartX,
  objStartY,
}: {
  objects: DynamicObjects;
  idx: Int32Array;
  n: number;
  h: number;
  tick: number;
  contacts: ContactTable;
  contactState: ContactState;
  p0: EphemerisOut;
  p1: EphemerisOut;
  objStartX: Float64Array;
  objStartY: Float64Array;
}): void {
  for (let j = 0; j < n; j++) {
    const i = idx[j]!;
    if (expended(objects, i)) continue;
    const px0 = objStartX[i]!;
    const py0 = objStartY[i]!;
    const px1 = objects.x[i]!;
    const py1 = objects.y[i]!;

    let bestS = Infinity;
    let bestContact = -1;
    for (let c = 0; c < contacts.count; c++) {
      if (contactState.cleared[c]) continue;
      const r0x = px0 - p0.x[c]!;
      const r0y = py0 - p0.y[c]!;
      const r1x = px1 - p1.x[c]!;
      const r1y = py1 - p1.y[c]!;
      const dx = r1x - r0x;
      const dy = r1y - r0y;
      const denom = dx * dx + dy * dy;
      // Zero-length relative segment (no relative motion this substep): the
      // whole segment is one point, s = 0 is as good as any.
      let s = denom === 0 ? 0 : -(r0x * dx + r0y * dy) / denom;
      if (s < 0) s = 0;
      else if (s > 1) s = 1;
      const cx = r0x + s * dx;
      const cy = r0y + s * dy;
      const captureRadius = contacts.captureRadius[c]!;
      if (cx * cx + cy * cy > captureRadius * captureRadius) continue;
      if (s < bestS) {
        bestS = s;
        bestContact = c;
      }
    }

    if (bestContact === -1) continue;
    const c = bestContact;

    // Mean relative velocity over the substep -- consistent with the swept
    // segment used to detect the impact, not the instantaneous relative
    // velocity at either endpoint.
    const rvx = (px1 - p1.x[c]! - (px0 - p0.x[c]!)) / h;
    const rvy = (py1 - p1.y[c]! - (py0 - p0.y[c]!)) / h;
    const speed = Math.sqrt(rvx * rvx + rvy * rvy);
    const energy = 0.5 * objects.mass[i]! * speed * speed;

    objects.hitContact[i] = c;
    // Same reasoning as a body hit (testCollisions above): every kick and
    // drift after this skips an expended object, so a still-armed burn
    // would freeze mid-burn rather than end.
    objects.burning[i] = 0;

    contactState.impactTick[c] = tick;
    contactState.impactSpeed[c] = speed;
    contactState.impactEnergy[c] = energy;
    if (energy >= contacts.minimumImpactEnergy[c]!) contactState.cleared[c] = 1;
  }
}

export interface StepTickArgs {
  bodies: BodyTable;
  objects: DynamicObjects;
  contacts: ContactTable;
  contactState: ContactState;
  tick: number;
  dt: number;
  scratch: StepScratch;
}

/** One tick: evaluate the ephemeris, group live objects by their own
 *  substep level, integrate each group with 2^L substeps of dt/2^L, and
 *  freeze any object that impacts a fixed contact or crosses a body's
 *  surface. No allocation. */
export function stepTick({
  bodies,
  objects,
  contacts,
  contactState,
  tick,
  dt,
  scratch,
}: StepTickArgs): void {
  const t = tick * dt;
  evaluateEphemeris(bodies, t, scratch.tickStartEph);
  evaluateContacts({ bodies, contacts, t, hostEph: scratch.tickStartEph, out: scratch.contactEph });

  scratch.groupCount.fill(0);
  for (let i = 0; i < objects.count; i++) {
    if (expended(objects, i)) continue;
    const level = substepLevel({
      bodies,
      kDyn: scratch.kDyn,
      dt,
      x: objects.x[i]!,
      y: objects.y[i]!,
      vx: objects.vx[i]!,
      vy: objects.vy[i]!,
      eph: scratch.tickStartEph,
      contacts,
      contactEph: scratch.contactEph,
      burning: objects.burning[i]!,
      mass: objects.mass[i]!,
      dryMass: objects.dryMass[i]!,
      thrust: objects.thrust[i]!,
      exhaustVelocity: objects.exhaustVelocity[i]!,
      burnTarget: objects.burnTarget[i]!,
      burnDelivered: objects.burnDelivered[i]!,
    });
    const group = scratch.groupIndex[level]!;
    group[scratch.groupCount[level]!] = i;
    scratch.groupCount[level]!++;
  }

  for (let level = 0; level <= L_MAX; level++) {
    const n = scratch.groupCount[level]!;
    if (n === 0) continue;
    const idx = scratch.groupIndex[level]!;
    const substeps = 1 << level;
    const h = dt / substeps;
    for (let s = 0; s < substeps; s++) {
      const tSubstep = t + s * h;

      // Contact p0 source for this substep: tick-start state for every
      // level's s=0 (every level starts there), the previous substep's
      // endpoint otherwise -- never a fresh evaluation (research §B.4).
      copyContactPositions(
        scratch.contactP0,
        s === 0 ? scratch.contactEph : scratch.contactP1,
        contacts.count,
      );
      snapshotObjectStart(objects, idx, n, scratch.objStartX, scratch.objStartY);

      pefrlSubstep({ bodies, objects, idx, n, t: tSubstep, h, eph: scratch.eph });
      evaluateEphemeris(bodies, tSubstep + h, scratch.eph);
      evaluateContacts({
        bodies,
        contacts,
        t: tSubstep + h,
        hostEph: scratch.eph,
        out: scratch.contactP1,
      });

      testContactImpacts({
        objects,
        idx,
        n,
        h,
        tick,
        contacts,
        contactState,
        p0: scratch.contactP0,
        p1: scratch.contactP1,
        objStartX: scratch.objStartX,
        objStartY: scratch.objStartY,
      });
      testCollisions({ bodies, objects, idx, n, eph: scratch.eph });
    }
  }
}
