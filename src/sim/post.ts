// The clearance post (ADR-0007 §1): a surface point like a rail (rails.ts's `surfacePoint`), so
// its position is analytic and exact at any tick -- no history needed, unlike a dynamic object.

import { surfacePoint } from './rails.ts';
import type { SurfacePoint } from './rails.ts';
import { evaluateEphemeris } from './ephemeris/bodies.ts';
import type { Sim } from './sim.ts';

export interface PostDef {
  /** Host body index (BodyTable order). */
  host: number;
  /** rad, longitude on the host's equator. */
  longitude: number;
}

/** The post's position/velocity at continuous time `t` seconds -- the light-cone solvers
 *  (lightcone.ts) need this at the non-integer instants their Newton iterations converge on, not
 *  just at tick boundaries. Reuses `sim.scratch.lightconeEph` (never `sim.scratch.eph`, which the
 *  tick loop owns) -- derived, per-call scratch, excluded from hashSim/serializeSim exactly like
 *  the tick loop's own ephemeris scratch (sim.ts). */
export function postPositionAtTime({ sim, t }: { sim: Sim; t: number }): SurfacePoint {
  evaluateEphemeris(sim.bodies, t, sim.scratch.lightconeEph);
  return surfacePoint({
    bodies: sim.bodies,
    host: sim.scenario.post.host,
    longitude: sim.scenario.post.longitude,
    t,
    eph: sim.scratch.lightconeEph,
  });
}

/** The post's position/velocity at tick `tick` (debug-api.ts's `state()`, GRV-0029 acceptance). */
export function postPosition({ sim, tick }: { sim: Sim; tick: number }): SurfacePoint {
  return postPositionAtTime({ sim, t: tick * sim.scenario.dt });
}
