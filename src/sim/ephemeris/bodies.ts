// Tier one of the two-tier model (docs/domain/simulation-determinism.md):
// analytic Keplerian ephemerides in a parent-relative frame, composed into
// primary-centred state vectors in one forward pass over a topologically
// ordered body table (research §1.3-1.4). 2D, elliptical orbits only.

import { dcosOut, dsincos, dsinOut } from '../math/kernels.ts';
import { kepCos, kepSin, solveKepler } from './kepler.ts';

const TWO_PI = 6.283185307179586;
const MAX_ECCENTRICITY = 0.8;

export interface PrimaryBodyDef {
  parent: -1;
  mu: number;
  radius: number;
  /** Seconds, > 0: rotation period (GAME-0001 §4.2). Spin is always
   *  prograde -- counter-clockwise, the same sense as the orbits. */
  rotationPeriod: number;
  /** rad, surface phase at t=0. Rail launch windows read off this. */
  axialPhaseAtEpoch: number;
  /** m, >= 0, default 0: grazing margin added to `radius` for occlusion only (lightcone.ts's
   *  `segmentBlocked`, research §5.5) -- an uncollidable buffer for atmosphere/plasma, never used
   *  by the surface-collision test (step.ts), which stays exactly `radius`. */
  atmosphereMargin?: number;
}

export interface OrbitingBodyDef {
  parent: number;
  mu: number;
  radius: number;
  a: number;
  e: number;
  argPeriapsis: number;
  meanAnomaly0: number;
  rotationPeriod: number;
  axialPhaseAtEpoch: number;
  atmosphereMargin?: number;
}

export type BodyDef = PrimaryBodyDef | OrbitingBodyDef;

/** Dense arrays, index order = evaluation order (parent[i] < i always).
 *  a/e/argPeriapsis/meanAnomaly0 are the raw orbital elements; meanMotion,
 *  semiMinorAxis, g, cosArgPeriapsis and sinArgPeriapsis are per-body
 *  constants derived from them once here, never recomputed per query
 *  (research §1.3). All zero for the primary at index 0. */
export interface BodyTable {
  count: number;
  parent: Int32Array;
  mu: Float64Array;
  radius: Float64Array;
  /** m, >= 0: `radius` plus the grazing margin (occlusion-only, PrimaryBodyDef/OrbitingBodyDef's
   *  own doc). Precomputed here so lightcone.ts's `segmentBlocked` never adds it per call. */
  occlusionRadius: Float64Array;
  a: Float64Array;
  e: Float64Array;
  argPeriapsis: Float64Array;
  meanAnomaly0: Float64Array;
  meanMotion: Float64Array;
  semiMinorAxis: Float64Array;
  g: Float64Array;
  cosArgPeriapsis: Float64Array;
  sinArgPeriapsis: Float64Array;
  rotationPeriod: Float64Array;
  axialPhaseAtEpoch: Float64Array;
  /** 2*pi / rotationPeriod, precomputed once here (research §2.2: never
   *  recompute a per-body constant per query). Used for a rail's surface
   *  rotation velocity (rails.ts). */
  angularRate: Float64Array;
}

export function createBodyTable(defs: BodyDef[]): BodyTable {
  const count = defs.length;
  const table: BodyTable = {
    count,
    parent: new Int32Array(count),
    mu: new Float64Array(count),
    radius: new Float64Array(count),
    occlusionRadius: new Float64Array(count),
    a: new Float64Array(count),
    e: new Float64Array(count),
    argPeriapsis: new Float64Array(count),
    meanAnomaly0: new Float64Array(count),
    meanMotion: new Float64Array(count),
    semiMinorAxis: new Float64Array(count),
    g: new Float64Array(count),
    cosArgPeriapsis: new Float64Array(count),
    sinArgPeriapsis: new Float64Array(count),
    rotationPeriod: new Float64Array(count),
    axialPhaseAtEpoch: new Float64Array(count),
    angularRate: new Float64Array(count),
  };

  for (let i = 0; i < count; i++) {
    const def = defs[i]!;
    if (!Number.isFinite(def.mu) || def.mu <= 0)
      throw new Error(`createBodyTable: body ${i} has non-positive or non-finite mu (${def.mu})`);
    if (!Number.isFinite(def.radius) || def.radius <= 0)
      throw new Error(
        `createBodyTable: body ${i} has non-positive or non-finite radius (${def.radius})`,
      );
    if (!Number.isFinite(def.rotationPeriod) || def.rotationPeriod <= 0)
      throw new Error(
        `createBodyTable: body ${i} has non-positive or non-finite rotationPeriod (${def.rotationPeriod})`,
      );
    const atmosphereMargin = def.atmosphereMargin ?? 0;
    if (!Number.isFinite(atmosphereMargin) || atmosphereMargin < 0)
      throw new Error(
        `createBodyTable: body ${i} has a negative or non-finite atmosphereMargin (${atmosphereMargin})`,
      );
    table.occlusionRadius[i] = def.radius + atmosphereMargin;
    // docs/issues/2026-09-18-unbounded-angles-reach-trig-kernel.md: [-2pi, 2pi] is the accepted
    // range (both endpoints included), independent of the compiler's own [0, 2pi) normalisation
    // -- a body table built directly (not through compile.ts) gets the same protection.
    if (!Number.isFinite(def.axialPhaseAtEpoch) || Math.abs(def.axialPhaseAtEpoch) > TWO_PI)
      throw new Error(
        `createBodyTable: body ${i} has axialPhaseAtEpoch (${def.axialPhaseAtEpoch}) outside [-2pi, 2pi]`,
      );
    table.rotationPeriod[i] = def.rotationPeriod;
    table.axialPhaseAtEpoch[i] = def.axialPhaseAtEpoch;
    table.angularRate[i] = TWO_PI / def.rotationPeriod;

    // `'a' in def` rather than `def.parent === -1`: OrbitingBodyDef's
    // `parent` is typed `number`, not a literal, so it isn't a usable
    // discriminant for TS's control-flow narrowing; presence of `a` is.
    if (!('a' in def)) {
      if (i !== 0)
        throw new Error(`createBodyTable: body ${i} has parent -1, only body 0 may be the primary`);
      table.parent[i] = -1;
      table.mu[i] = def.mu;
      table.radius[i] = def.radius;
      continue;
    }
    if (i === 0) throw new Error('createBodyTable: body 0 must be the primary (parent -1)');
    if (def.parent < 0 || def.parent >= i)
      throw new Error(
        `createBodyTable: body ${i} has parent ${def.parent}, must satisfy 0 <= parent < ${i}`,
      );
    if (!Number.isFinite(def.e) || def.e < 0 || def.e > MAX_ECCENTRICITY)
      throw new Error(
        `createBodyTable: body ${i} has eccentricity ${def.e}, must be in [0, ${MAX_ECCENTRICITY}]`,
      );
    if (!Number.isFinite(def.a) || def.a <= 0)
      throw new Error(
        `createBodyTable: body ${i} has non-positive or non-finite semi-major axis (${def.a})`,
      );
    if (!Number.isFinite(def.argPeriapsis) || Math.abs(def.argPeriapsis) > TWO_PI)
      throw new Error(
        `createBodyTable: body ${i} has argPeriapsis (${def.argPeriapsis}) outside [-2pi, 2pi]`,
      );
    if (!Number.isFinite(def.meanAnomaly0) || Math.abs(def.meanAnomaly0) > TWO_PI)
      throw new Error(
        `createBodyTable: body ${i} has meanAnomaly0 (${def.meanAnomaly0}) outside [-2pi, 2pi]`,
      );

    table.parent[i] = def.parent;
    table.mu[i] = def.mu;
    table.radius[i] = def.radius;
    table.a[i] = def.a;
    table.e[i] = def.e;
    table.argPeriapsis[i] = def.argPeriapsis;
    table.meanAnomaly0[i] = def.meanAnomaly0;

    const muParent = table.mu[def.parent]!;
    table.meanMotion[i] = Math.sqrt(muParent / (def.a * def.a * def.a));
    table.semiMinorAxis[i] = def.a * Math.sqrt(1 - def.e * def.e);
    table.g[i] = Math.sqrt(muParent * def.a);
    dsincos(def.argPeriapsis);
    table.sinArgPeriapsis[i] = dsinOut;
    table.cosArgPeriapsis[i] = dcosOut;
  }

  return table;
}

export interface EphemerisOut {
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
}

/** Primary-centred position and velocity for every body at time t, in one
 *  forward pass: parent[i] < i always, so each body's parent state is
 *  already written by the time it is used (research §1.4). No allocation. */
export function evaluateEphemeris(table: BodyTable, t: number, out: EphemerisOut): void {
  out.x[0] = 0;
  out.y[0] = 0;
  out.vx[0] = 0;
  out.vy[0] = 0;

  for (let i = 1; i < table.count; i++) {
    let M = table.meanAnomaly0[i]! + table.meanMotion[i]! * t;
    M = M - TWO_PI * Math.floor(M / TWO_PI);
    solveKepler(M, table.e[i]!);

    const sE = kepSin;
    const cE = kepCos;
    const a = table.a[i]!;
    const b = table.semiMinorAxis[i]!;
    const e = table.e[i]!;
    const px = a * (cE - e);
    const py = b * sE;
    const r = a * (1 - e * cE);
    const f = table.g[i]! / r;
    const pvx = -f * sE;
    const pvy = (b / a) * f * cE;

    const p = table.parent[i]!;
    const C = table.cosArgPeriapsis[i]!;
    const S = table.sinArgPeriapsis[i]!;
    out.x[i] = out.x[p]! + px * C - py * S;
    out.y[i] = out.y[p]! + px * S + py * C;
    out.vx[i] = out.vx[p]! + pvx * C - pvy * S;
    out.vy[i] = out.vy[p]! + pvx * S + pvy * C;
  }
}

/** Rotation phase of `body`'s surface at time `t` (GAME-0001 §4.2, docs/
 *  work/GRV-0014): the fraction of a turn since epoch is taken *before* the
 *  2*pi multiply, so the value stays small -- and inside dsincos's domain
 *  -- for any t, however large (research §2.2's reduce-before-trig rule).
 *  Spin is always prograde: `axialPhaseAtEpoch` increases monotonically
 *  with t because `rotationPeriod` is validated > 0. */
export function surfacePhase(table: BodyTable, body: number, t: number): number {
  const cycles = t / table.rotationPeriod[body]!;
  const frac = cycles - Math.floor(cycles);
  return table.axialPhaseAtEpoch[body]! + TWO_PI * frac;
}
