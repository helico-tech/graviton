// A read-only snapshot of the simulation the renderer draws from (GRV-0022 acceptance, ADR-0002
// guard-rail 6, docs/domain/simulation-determinism.md rule 10: "the renderer reads simulation
// state... it never mutates state"). `captureFrame` is the one place outside `src/sim` that reads
// a live `Sim` for drawing purposes; everything downstream of it (`src/render/plot.ts`,
// `src/render/bodies.ts`) only ever sees this plain, `readonly`-typed object -- values copied by
// number, arrays copied fresh, never the sim's own typed-array storage.
import { evaluateEphemeris, surfacePhase } from '../sim/ephemeris/bodies.ts';
import type { BodyTable, EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { railGeometry } from '../sim/rails.ts';
import { contactPoint } from '../sim/contacts.ts';
import type { Sim } from '../sim/sim.ts';
import { BODY_CLASS_STYLES } from './palette.ts';
import type { BodyClass } from './palette.ts';

export interface FrameOrbit {
  readonly centreX: number;
  readonly centreY: number;
  readonly semiMajorAxis: number;
  readonly semiMinorAxis: number;
  /** Radians from the world +x axis to the ellipse's own major axis. */
  readonly rotation: number;
}

export interface FrameBody {
  readonly id: string;
  readonly name: string;
  readonly klass: BodyClass;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly surfacePhase: number;
  /** Unit vector from this body toward the system primary, `(0, 0)` for the primary itself
   *  (GAME-0002 §5: bodies are "lit from the system primary"). */
  readonly directionToPrimaryX: number;
  readonly directionToPrimaryY: number;
  /** `null` for the system primary, which has no orbit of its own. */
  readonly orbit: FrameOrbit | null;
}

export interface FrameRail {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** Local-vertical unit vector at the muzzle point -- the rail's current surface angle. */
  readonly ux: number;
  readonly uy: number;
}

export interface FrameContact {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly cleared: boolean;
}

export interface FrameObject {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Hit a body, or hit/cleared a fixed contact (dynamics/step.ts's own "expended"). */
  readonly expended: boolean;
}

export interface Frame {
  readonly tick: number;
  readonly dt: number;
  readonly bodies: readonly FrameBody[];
  readonly rails: readonly FrameRail[];
  readonly contacts: readonly FrameContact[];
  readonly objects: readonly FrameObject[];
  /** `largestOrbitApoapsis` below, carried on the frame so a caller that only ever sees `Frame`
   *  objects (src/ui/plot.ts's camera, which has no `BodyTable` of its own) can still size a
   *  default view and zoom bounds (camera.ts) without reaching back into the sim. */
  readonly systemExtent: number;
}

/** The names and classes a `CompiledLevel` carries (src/levels/compile.ts, restated in
 *  src/app/levels.ts for the bundle-isolation boundary): declared structurally here rather than
 *  imported from either, so `src/render` depends on neither `src/levels` nor `src/app`. */
export interface FrameLevelNames {
  readonly bodyIds: readonly string[];
  readonly railIds: readonly string[];
  readonly contactIds: readonly string[];
  readonly bodyClasses: readonly string[];
  readonly names: {
    readonly bodies: readonly string[];
    readonly rails: readonly string[];
    readonly contacts: readonly string[];
  };
}

const FALLBACK_CLASS: BodyClass = 'rock';

function isBodyClass(value: string | undefined): value is BodyClass {
  return value !== undefined && Object.hasOwn(BODY_CLASS_STYLES, value);
}

function bodyClassAt(level: FrameLevelNames, index: number): BodyClass {
  const raw = level.bodyClasses[index];
  return isBodyClass(raw) ? raw : FALLBACK_CLASS;
}

function nameAt(
  ids: readonly string[],
  names: readonly string[],
  index: number,
  kind: string,
): {
  id: string;
  name: string;
} {
  const id = ids[index] ?? `${kind}-${index}`;
  return { id, name: names[index] ?? id };
}

function makeEphemerisOut(count: number): EphemerisOut {
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
  };
}

/** The ellipse a body's orbit traces in the world frame at the current instant: the parent sits
 *  at one focus (always true of a Kepler orbit), so the ellipse's own centre is offset from the
 *  parent's position by `a*e` along the periapsis direction, away from periapsis -- the same
 *  geometry `evaluateEphemeris` (ephemeris/bodies.ts) evaluates a point on, stated here as the
 *  curve rather than a single point. */
function bodyOrbit(bodies: BodyTable, index: number, parent: { x: number; y: number }): FrameOrbit {
  const a = bodies.a[index]!;
  const e = bodies.e[index]!;
  const cosArg = bodies.cosArgPeriapsis[index]!;
  const sinArg = bodies.sinArgPeriapsis[index]!;
  return {
    centreX: parent.x - a * e * cosArg,
    centreY: parent.y - a * e * sinArg,
    semiMajorAxis: a,
    semiMinorAxis: bodies.semiMinorAxis[index]!,
    rotation: bodies.argPeriapsis[index]!,
  };
}

/** Sum of `a*(1+e)` up a body's parent chain to the primary (planar, no inclination term):
 *  the largest such sum over every body is a crude but honest upper bound on the system's extent,
 *  used to size the default view and the zoom's outer bound (camera.ts). Mirrors
 *  src/levels/compile.ts's `apoapsisBoundFromPrimary`, restated over a `BodyTable` rather than
 *  `BodyDef[]` so `src/render` does not import `src/levels` (research §A.7's separation). */
export function largestOrbitApoapsis(bodies: BodyTable): number {
  let max = 0;
  for (let i = 1; i < bodies.count; i++) {
    let radius = 0;
    for (let node = i; node !== 0; node = bodies.parent[node]!) {
      radius += bodies.a[node]! * (1 + bodies.e[node]!);
    }
    if (radius > max) max = radius;
  }
  return max;
}

/** Builds a `Frame` from the live `Sim` at its current tick -- reads only, no allocation kept
 *  past the call, and every array here is this call's own copy (never `sim.objects.x` etc.
 *  itself). Ephemeris is evaluated fresh at `sim.tick * sim.scenario.dt` rather than reused from
 *  `sim.scratch.tickStartEph`, which lags the sim's own clock by one tick right after `advance`
 *  returns (and is never populated before the first tick) -- exactly the staleness a render must
 *  not show. */
export function captureFrame({ sim, level }: { sim: Sim; level: FrameLevelNames }): Frame {
  const t = sim.tick * sim.scenario.dt;
  const eph = makeEphemerisOut(sim.bodies.count);
  evaluateEphemeris(sim.bodies, t, eph);

  const bodies: FrameBody[] = [];
  for (let i = 0; i < sim.bodies.count; i++) {
    const x = eph.x[i]!;
    const y = eph.y[i]!;
    const parent = sim.bodies.parent[i]!;
    const dirLength = Math.sqrt(x * x + y * y);
    const { id, name } = nameAt(level.bodyIds, level.names.bodies, i, 'body');
    bodies.push({
      id,
      name,
      klass: bodyClassAt(level, i),
      x,
      y,
      radius: sim.bodies.radius[i]!,
      surfacePhase: surfacePhase(sim.bodies, i, t),
      directionToPrimaryX: dirLength > 0 ? -x / dirLength : 0,
      directionToPrimaryY: dirLength > 0 ? -y / dirLength : 0,
      orbit:
        parent === -1 ? null : bodyOrbit(sim.bodies, i, { x: eph.x[parent]!, y: eph.y[parent]! }),
    });
  }

  const rails: FrameRail[] = [];
  for (let i = 0; i < sim.rails.count; i++) {
    const geometry = railGeometry({ bodies: sim.bodies, rails: sim.rails, rail: i, t, eph });
    const { id, name } = nameAt(level.railIds, level.names.rails, i, 'rail');
    rails.push({ id, name, x: geometry.x, y: geometry.y, ux: geometry.ux, uy: geometry.uy });
  }

  const contacts: FrameContact[] = [];
  for (let i = 0; i < sim.contacts.count; i++) {
    const point = contactPoint({ bodies: sim.bodies, contacts: sim.contacts, contact: i, t, eph });
    const { id, name } = nameAt(level.contactIds, level.names.contacts, i, 'contact');
    contacts.push({ id, name, x: point.x, y: point.y, cleared: sim.contactState.cleared[i] !== 0 });
  }

  const objects: FrameObject[] = [];
  const o = sim.objects;
  for (let i = 0; i < o.count; i++) {
    objects.push({
      x: o.x[i]!,
      y: o.y[i]!,
      vx: o.vx[i]!,
      vy: o.vy[i]!,
      expended: o.hitBody[i]! !== -1 || o.hitContact[i]! !== -1,
    });
  }

  return {
    tick: sim.tick,
    dt: sim.scenario.dt,
    bodies,
    rails,
    contacts,
    objects,
    systemExtent: largestOrbitApoapsis(sim.bodies),
  };
}
