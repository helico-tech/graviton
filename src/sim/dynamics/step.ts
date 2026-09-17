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
// ladder term) are pefrl.ts's and ladder.ts's (GRV-0007); the contact term
// is not part of this unit and leaves no stub here.

import { evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../ephemeris/bodies.ts';
import { computeKDyn, L_MAX, substepLevel } from './ladder.ts';
import { pefrlSubstep } from './pefrl.ts';
import type { PefrlObjects } from './pefrl.ts';

export interface DynamicObjects extends PefrlObjects {
  count: number;
}

export function createDynamicObjects(capacity: number): DynamicObjects {
  const hitBody = new Int32Array(capacity);
  hitBody.fill(-1);
  return {
    count: 0,
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    vx: new Float64Array(capacity),
    vy: new Float64Array(capacity),
    hitBody,
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

export interface StepScratch {
  /** mu[b] * (dt/eta)^2 per body, computed once for this scratch's dt. */
  kDyn: Float64Array;
  eph: EphemerisOut;
  /** One preallocated index buffer per level, sized to capacity. */
  groupIndex: Int32Array[];
  groupCount: Int32Array;
}

export function createStepScratch({
  bodies,
  dt,
  capacity,
}: {
  bodies: BodyTable;
  dt: number;
  capacity: number;
}): StepScratch {
  const groupIndex: Int32Array[] = [];
  for (let l = 0; l <= L_MAX; l++) groupIndex.push(new Int32Array(capacity));
  return {
    kDyn: computeKDyn(bodies, dt),
    eph: {
      x: new Float64Array(bodies.count),
      y: new Float64Array(bodies.count),
      vx: new Float64Array(bodies.count),
      vy: new Float64Array(bodies.count),
    },
    groupIndex,
    groupCount: new Int32Array(L_MAX + 1),
  };
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
    if (objects.hitBody[i] !== -1) continue;
    const px = objects.x[i]!;
    const py = objects.y[i]!;
    for (let b = 0; b < bodies.count; b++) {
      const dx = px - eph.x[b]!;
      const dy = py - eph.y[b]!;
      const radius = bodies.radius[b]!;
      if (dx * dx + dy * dy <= radius * radius) {
        objects.hitBody[i] = b;
        break;
      }
    }
  }
}

export interface StepTickArgs {
  bodies: BodyTable;
  objects: DynamicObjects;
  tick: number;
  dt: number;
  scratch: StepScratch;
}

/** One tick: evaluate the ephemeris, group live objects by their own
 *  substep level, integrate each group with 2^L substeps of dt/2^L, and
 *  freeze any object that crosses a body's surface. No allocation. */
export function stepTick({ bodies, objects, tick, dt, scratch }: StepTickArgs): void {
  const t = tick * dt;
  evaluateEphemeris(bodies, t, scratch.eph);

  scratch.groupCount.fill(0);
  for (let i = 0; i < objects.count; i++) {
    if (objects.hitBody[i] !== -1) continue;
    const level = substepLevel({
      bodies,
      kDyn: scratch.kDyn,
      dt,
      x: objects.x[i]!,
      y: objects.y[i]!,
      vx: objects.vx[i]!,
      vy: objects.vy[i]!,
      eph: scratch.eph,
      burning: objects.burning[i]!,
      mass: objects.mass[i]!,
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
      pefrlSubstep({ bodies, objects, idx, n, t: tSubstep, h, eph: scratch.eph });
      evaluateEphemeris(bodies, tSubstep + h, scratch.eph);
      testCollisions({ bodies, objects, idx, n, eph: scratch.eph });
    }
  }
}
