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
  /** The predicted present (GRV-0030, GAME-0001 §4.6 "information horizon"): a replay of the
   *  committed log from the object's last observation to now, never the true live state -- `x`/
   *  `y`/`vx`/`vy` are meaningless (zero) when `observed` is false. */
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Whether the observation itself -- not the live or predicted state -- already shows the
   *  object expended (hit a body, or hit/cleared a fixed contact): the post does not know a probe
   *  is expended until its own telemetry says so. */
  readonly expended: boolean;
  /** Whether the post has ever observed this object yet -- false before its first light reaches
   *  the post, or while the path is occluded at every tick since (GRV-0030); nothing is drawn for
   *  an unobserved object (the plot never shows the true state, and there is no predicted one
   *  without an observation to predict from). */
  readonly observed: boolean;
}

/** The subset of `src/app/observed.ts`'s `ObservedObject` this module reads, restated
 *  structurally rather than imported so `src/render` still depends on neither `src/app` nor
 *  `src/ui` (this module's own header, research §A.7's separation) -- mirrors `FrameLevelNames`'s
 *  own relationship to `CompiledLevel`. */
export interface FrameObservation {
  readonly predicted: {
    readonly x: number;
    readonly y: number;
    readonly vx: number;
    readonly vy: number;
  } | null;
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
 *  not show.
 *
 *  `t`, if given, overrides the instant bodies/rails/contacts are read at (GRV-0026's horizon
 *  scrub, GAME-0001 §4.6: "bodies are exact from the ephemeris" at the scrubbed tick) -- tier one
 *  is an O(1) closed-form query at any time (docs/domain/simulation-determinism.md's two-tier
 *  model), so this needs no stepping. `objects` (probes) are never affected by it: a dynamic
 *  object has no analytic position away from `sim`'s own current tick, so they -- and `Frame.tick`
 *  itself -- always read the simulation's real "now".
 *
 *  `observed`, one entry per `sim.objects` index (GRV-0030): the post's own picture of each
 *  object (src/app/observed.ts), never `sim.objects` itself -- rule 12/GAME-0001 §4.7's whole
 *  point is that the post never sees the true, live state of a dynamic object, only what its own
 *  telemetry has confirmed plus a prediction from there. A missing or `null`-predicted entry
 *  draws nothing for that object (`FrameObject.observed` false) -- there is no true state to fall
 *  back to. */
export function captureFrame({
  sim,
  level,
  observed,
  t: tOverride,
}: {
  sim: Sim;
  level: FrameLevelNames;
  observed: readonly FrameObservation[];
  t?: number;
}): Frame {
  const t = tOverride ?? sim.tick * sim.scenario.dt;
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
  for (let i = 0; i < sim.objects.count; i++) {
    const view = observed[i];
    const predicted = view?.predicted;
    objects.push(
      predicted
        ? {
            x: predicted.x,
            y: predicted.y,
            vx: predicted.vx,
            vy: predicted.vy,
            expended: view.expended,
            observed: true,
          }
        : { x: 0, y: 0, vx: 0, vy: 0, expended: false, observed: false },
    );
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
