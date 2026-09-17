// Fixed contacts (GAME-0001 §4.8, EPIC-04 "planar: longitude only"): a
// contact rides its host's ephemeris exactly, the same way a rail's muzzle
// does, so its position and velocity are an O(1) query of the host's state,
// never independent inputs. `createContactTable` mirrors `createRailTable`'s
// validation style; `contactPoint` is `surfacePoint` (rails.ts) with no
// muzzle term to add -- a contact's whole kinematics.
//
// Mutable per-run outcome (cleared, last impact) is `ContactState`, kept
// separate from this static table exactly as `PendingBurnNodes` is kept
// separate from `RailTable`: the table is derived from `Scenario.contacts`
// alone (sim.ts excludes it from hashSim/serializeSim, like bodies and
// rails); `ContactState` is real `Sim` state (hashed and serialised).

import { dcosOut, dsincos, dsinOut } from './math/kernels.ts';
import { surfacePhase } from './ephemeris/bodies.ts';
import { surfacePoint } from './rails.ts';
import type { SurfacePoint } from './rails.ts';
import type { BodyTable, EphemerisOut } from './ephemeris/bodies.ts';

/** Sentinel for `ContactState.impactTick`: a contact never impacted reads
 *  this rather than an implicit "-1 happens to work" rule, mirroring
 *  rails.ts's NEVER_LAUNCHED. */
export const NO_IMPACT = -1;

export interface FixedContactDef {
  /** Host body index (BodyTable order). */
  host: number;
  /** rad, longitude on the host's equator. */
  longitude: number;
  /** m, impact is caught within this range of the contact. */
  captureRadius: number;
  /** J, kinetic energy an impact needs to clear the contact. */
  minimumImpactEnergy: number;
}

/** Dense arrays, index order = def order (mirrors RailTable's own
 *  convention). */
export interface ContactTable {
  count: number;
  host: Int32Array;
  longitude: Float64Array;
  captureRadius: Float64Array;
  minimumImpactEnergy: Float64Array;
}

export function createContactTable(defs: FixedContactDef[], bodies: BodyTable): ContactTable {
  const count = defs.length;
  const table: ContactTable = {
    count,
    host: new Int32Array(count),
    longitude: new Float64Array(count),
    captureRadius: new Float64Array(count),
    minimumImpactEnergy: new Float64Array(count),
  };

  for (let i = 0; i < count; i++) {
    const def = defs[i]!;
    if (!Number.isInteger(def.host) || def.host < 0 || def.host >= bodies.count)
      throw new Error(`createContactTable: contact ${i} has out-of-range host (${def.host})`);
    if (!Number.isFinite(def.longitude))
      throw new Error(
        `createContactTable: contact ${i} has non-finite longitude (${def.longitude})`,
      );
    if (!Number.isFinite(def.captureRadius) || def.captureRadius <= 0)
      throw new Error(
        `createContactTable: contact ${i} has non-positive or non-finite captureRadius (${def.captureRadius})`,
      );
    if (!Number.isFinite(def.minimumImpactEnergy) || def.minimumImpactEnergy < 0)
      throw new Error(
        `createContactTable: contact ${i} has negative or non-finite minimumImpactEnergy (${def.minimumImpactEnergy})`,
      );

    table.host[i] = def.host;
    table.longitude[i] = def.longitude;
    table.captureRadius[i] = def.captureRadius;
    table.minimumImpactEnergy[i] = def.minimumImpactEnergy;
  }

  return table;
}

/** Position and velocity of contact `c` at time `t`: exactly the host
 *  surface point at the contact's longitude (rails.ts's surfacePoint) -- a
 *  fixed contact has no muzzle term to add. `eph` must already hold the
 *  host's ephemeris state at `t`. */
export function contactPoint({
  bodies,
  contacts,
  contact,
  t,
  eph,
}: {
  bodies: BodyTable;
  contacts: ContactTable;
  contact: number;
  t: number;
  eph: EphemerisOut;
}): SurfacePoint {
  return surfacePoint({
    bodies,
    host: contacts.host[contact]!,
    longitude: contacts.longitude[contact]!,
    t,
    eph,
  });
}

/** Position and velocity of every contact at time `t`, written into `out`
 *  (no allocation): step.ts's hot-path batch form of `contactPoint`, called
 *  once per tick (the ladder's tick-start contact state) and twice per
 *  substep (the impact test's swept-segment endpoints). Mirrors
 *  `surfacePoint`'s formula directly rather than calling it and copying out
 *  of the object it returns, which would allocate once per contact per call
 *  -- exactly the allocation `evaluateEphemeris` itself avoids for bodies.
 *  `hostEph` must already hold every contact's host ephemeris state at
 *  `t`. */
export function evaluateContacts({
  bodies,
  contacts,
  t,
  hostEph,
  out,
}: {
  bodies: BodyTable;
  contacts: ContactTable;
  t: number;
  hostEph: EphemerisOut;
  out: EphemerisOut;
}): void {
  for (let c = 0; c < contacts.count; c++) {
    const host = contacts.host[c]!;
    const phi = surfacePhase(bodies, host, t) + contacts.longitude[c]!;
    dsincos(phi);
    const ux = dcosOut;
    const uy = dsinOut;
    const radius = bodies.radius[host]!;
    const omega = bodies.angularRate[host]!;
    out.x[c] = hostEph.x[host]! + radius * ux;
    out.y[c] = hostEph.y[host]! + radius * uy;
    out.vx[c] = hostEph.vx[host]! + omega * radius * -uy;
    out.vy[c] = hostEph.vy[host]! + omega * radius * ux;
  }
}

/** Mutable outcome per contact, one entry per `Scenario.contacts`: `cleared`
 *  is explicit state, not derived from energy vs minimum after the fact
 *  (only `stepTick`'s impact test ever sets it); `impactTick`/`impactSpeed`/
 *  `impactEnergy` record the *last* impact only (GRV-0015 -- a contact may
 *  be hit more than once before it clears). Hashed and serialised
 *  (sim.ts). */
export interface ContactState {
  cleared: Uint8Array;
  impactTick: Int32Array;
  impactSpeed: Float64Array;
  impactEnergy: Float64Array;
}

export function createContactState(count: number): ContactState {
  const impactTick = new Int32Array(count);
  impactTick.fill(NO_IMPACT);
  return {
    cleared: new Uint8Array(count),
    impactTick,
    impactSpeed: new Float64Array(count),
    impactEnergy: new Float64Array(count),
  };
}
