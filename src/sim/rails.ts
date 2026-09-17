// Launch rails (docs/work/GRV-0014-body-spin-and-launch-rails.md, GAME-0001
// §4.2): a rail rides its host's spin and orbital velocity, so a probe's
// launch position and velocity are geometric consequences of the host's
// state, not independent inputs. Planar simulation (EPIC-04): a rail sits
// at a longitude on its host's equator, no latitude.

import { dcos, dcosOut, dsincos, dsinOut } from './math/kernels.ts';
import { surfacePhase } from './ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from './ephemeris/bodies.ts';

const PI = 3.141592653589793;

export interface RailDef {
  /** Host body index (BodyTable order). */
  host: number;
  /** rad, longitude on the host's equator. */
  longitude: number;
  /** m/s, muzzle speed band (inclusive). */
  muzzleSpeedMin: number;
  muzzleSpeedMax: number;
  /** rad, half-angle of the cone the rail can fire into about the local
   *  vertical, in (0, pi]. */
  headingCone: number;
  /** Ticks the rail needs between launches. */
  reloadTicks: number;
}

/** Dense arrays, index order = def order (mirrors BodyTable's own
 *  convention). `cosHeadingCone` is precomputed with the sim's own `dcos`
 *  so checkLaunch's cone test (commands.ts) never calls trig itself. */
export interface RailTable {
  count: number;
  host: Int32Array;
  longitude: Float64Array;
  muzzleSpeedMin: Float64Array;
  muzzleSpeedMax: Float64Array;
  headingCone: Float64Array;
  cosHeadingCone: Float64Array;
  reloadTicks: Int32Array;
}

/** Sentinel for `Sim.railLastLaunchTick`: a rail that has never fired reads
 *  this rather than an implicit "no reload check below tick 0" rule, so the
 *  reload check in commands.ts's `checkLaunch` can skip explicitly instead
 *  of relying on arithmetic that happens to work out for tick >= 0. */
export const NEVER_LAUNCHED = -1;

export function createRailTable(defs: RailDef[], bodies: BodyTable): RailTable {
  const count = defs.length;
  const table: RailTable = {
    count,
    host: new Int32Array(count),
    longitude: new Float64Array(count),
    muzzleSpeedMin: new Float64Array(count),
    muzzleSpeedMax: new Float64Array(count),
    headingCone: new Float64Array(count),
    cosHeadingCone: new Float64Array(count),
    reloadTicks: new Int32Array(count),
  };

  for (let i = 0; i < count; i++) {
    const def = defs[i]!;
    if (!Number.isInteger(def.host) || def.host < 0 || def.host >= bodies.count)
      throw new Error(`createRailTable: rail ${i} has out-of-range host (${def.host})`);
    if (!Number.isFinite(def.longitude))
      throw new Error(`createRailTable: rail ${i} has non-finite longitude (${def.longitude})`);
    if (!Number.isFinite(def.muzzleSpeedMin) || def.muzzleSpeedMin <= 0)
      throw new Error(
        `createRailTable: rail ${i} has non-positive or non-finite muzzleSpeedMin (${def.muzzleSpeedMin})`,
      );
    if (!Number.isFinite(def.muzzleSpeedMax) || def.muzzleSpeedMax < def.muzzleSpeedMin)
      throw new Error(
        `createRailTable: rail ${i} has muzzleSpeedMax (${def.muzzleSpeedMax}) below muzzleSpeedMin (${def.muzzleSpeedMin})`,
      );
    if (!Number.isFinite(def.headingCone) || def.headingCone <= 0 || def.headingCone > PI)
      throw new Error(
        `createRailTable: rail ${i} has headingCone (${def.headingCone}) outside (0, pi]`,
      );
    if (!Number.isInteger(def.reloadTicks) || def.reloadTicks < 0)
      throw new Error(
        `createRailTable: rail ${i} has non-integer or negative reloadTicks (${def.reloadTicks})`,
      );

    table.host[i] = def.host;
    table.longitude[i] = def.longitude;
    table.muzzleSpeedMin[i] = def.muzzleSpeedMin;
    table.muzzleSpeedMax[i] = def.muzzleSpeedMax;
    table.headingCone[i] = def.headingCone;
    table.cosHeadingCone[i] = dcos(def.headingCone);
    table.reloadTicks[i] = def.reloadTicks;
  }

  return table;
}

export interface RailGeometry {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Local vertical unit vector at the rail (the cone test's reference
   *  direction). */
  ux: number;
  uy: number;
}

/** Position and host-plus-rotation velocity of a rail's muzzle at time `t`
 *  (GAME-0001 §4.2): exactly on the host's surface, at the host's own
 *  velocity plus the surface's own rotation velocity. The muzzle term
 *  (`speed` along the command's own heading) is not included here -- it is
 *  the one term that is not purely geometric, and is the caller's to add.
 *  `eph` must already hold the host's ephemeris state at `t`. */
export function railGeometry({
  bodies,
  rails,
  rail,
  t,
  eph,
}: {
  bodies: BodyTable;
  rails: RailTable;
  rail: number;
  t: number;
  eph: EphemerisOut;
}): RailGeometry {
  const host = rails.host[rail]!;
  const phi = surfacePhase(bodies, host, t) + rails.longitude[rail]!;
  dsincos(phi);
  const ux = dcosOut;
  const uy = dsinOut;
  const radius = bodies.radius[host]!;
  const omega = bodies.angularRate[host]!;

  return {
    x: eph.x[host]! + radius * ux,
    y: eph.y[host]! + radius * uy,
    vx: eph.vx[host]! + omega * radius * -uy,
    vy: eph.vy[host]! + omega * radius * ux,
    ux,
    uy,
  };
}
