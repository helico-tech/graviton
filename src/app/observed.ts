// The post's picture of every dynamic object (ADR-0007 §5-6, GAME-0001 §4.6 "information
// horizon", GAME-0002 §4 "dotted, fading tail"): each object's last observation
// (src/sim/telemetry.ts's own downlink) and a prediction from there to now, obtained by replaying
// the already-committed log forward -- "the plan is known, so the prediction is exact until
// something the post does not know happens" (design note; mirrors src/app/predict.ts's own "a
// running probe has already launched and any future burns are already in the committed log, so
// this only needs to keep the same log running, never re-issue anything" -- this is that same
// replay, extended to sample positions rather than only events). `expended` reflects only what
// the observation itself shows -- the post does not know a probe is expended until its own
// telemetry says so, never the live/true state.
//
// Cost: the observation tick advances by ~1 per app tick (the delay changes slowly relative to
// dt), so replaying "up to the observation" from scratch every call would be O(current tick) per
// call, O(n^2) over a flight. Instead, a per-object cache keeps the *serialized* sim state at its
// own last-computed observation tick (mirrors src/planner/ghost.ts's own checkpoint pattern) and
// resumes with a short incremental `advance` -- the delay's own change since the last call,
// normally 0 or 1 tick -- rather than a cold replay from tick 0. A cold replay only happens when
// the committed log grows (a new command) or the observation tick ever moves backward.
import { advance, createSim, deserializeSim, serializeSim } from '../sim/sim.ts';
import type { Command, Sim } from '../sim/sim.ts';
import { observedState } from '../sim/telemetry.ts';
import type { CompiledLevel } from './levels.ts';

export interface ObservedSample {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

export interface ObservedObservation extends ObservedSample {
  readonly tick: number;
}

export interface ObservedObject {
  /** The last observation's tick and state; `null` before the object's first light has reached
   *  the post. */
  readonly observation: ObservedObservation | null;
  /** The predicted present -- the last sample of `tail`, or the observation itself when there is
   *  nothing to predict (the object is already expended as observed); `null` without an
   *  observation. */
  readonly predicted: ObservedSample | null;
  /** Every predicted sample strictly after the observation, oldest first -- the dotted fading
   *  tail (GAME-0002 §4); `[]` without an observation, or once the object is expended as
   *  observed. */
  readonly tail: readonly ObservedSample[];
  /** How stale `observation` is, in seconds; `NaN` without an observation. */
  readonly delaySeconds: number;
  /** Whether the observation itself -- not the live or predicted state -- already shows the
   *  object expended. */
  readonly expended: boolean;
  /** Whether the observation itself shows the object burning -- src/app/events.ts's own
   *  node-start/node-end detection reads this (GRV-0030: events are telemetry events too). `false`
   *  without an observation. */
  readonly burning: boolean;
  /** The body/contact the observation shows the object having hit, -1 if neither (contacts.ts's
   *  own sentinel convention); `-1` without an observation. */
  readonly hitBody: number;
  readonly hitContact: number;
  /** Whether `hitContact` (if any) reads cleared *as observed*, at the same tick -- an impact and
   *  the clearing it causes are the same physics step, so this is read from the same replay
   *  rather than needing a second one. `false` without a `hitContact`. */
  readonly contactCleared: boolean;
  /** The sim's own authoritative impact tick for `hitContact` (contactState.impactTick), -1
   *  without one -- src/app/events.ts trusts this rather than deriving a tick from two observation
   *  samples, which can be far more than one tick apart across an occlusion blackout. */
  readonly contactImpactTick: number;
}

interface ObjectCache {
  logLength: number;
  observationTick: number;
  bytes: Uint8Array;
}

export interface ObservedCache {
  readonly perObject: Map<number, ObjectCache>;
}

/** One cache per loaded session, reused for its whole lifetime (app.ts owns it alongside its
 *  trail set and event log). */
export function createObservedCache(): ObservedCache {
  return { perObject: new Map() };
}

function sampleObject(sim: Sim, object: number): ObservedSample {
  return {
    x: sim.objects.x[object]!,
    y: sim.objects.y[object]!,
    vx: sim.objects.vx[object]!,
    vy: sim.objects.vy[object]!,
  };
}

function isExpended(sim: Sim, object: number): boolean {
  return sim.objects.hitBody[object]! !== -1 || sim.objects.hitContact[object]! !== -1;
}

/** The event-relevant fields of `object`'s state in `sim`, as observed (src/app/events.ts's own
 *  edge detection reads these, one call apart). `contactImpactTick` is the sim's own authoritative
 *  record (contactState.impactTick), not derived -- an impact revealed right after a long
 *  occlusion blackout (a real case, GRV-0030: a fixed contact's host rotating the post out of view
 *  for a while) would otherwise have no way to recover which tick it actually happened at, the
 *  same reasoning the pre-telemetry `diffEvents` already applied ("trust the sim's own recorded
 *  impactTick instead"). */
function observedEventState(
  sim: Sim,
  object: number,
): {
  burning: boolean;
  hitBody: number;
  hitContact: number;
  contactCleared: boolean;
  contactImpactTick: number;
} {
  const hitBody = sim.objects.hitBody[object]!;
  const hitContact = sim.objects.hitContact[object]!;
  return {
    burning: sim.objects.burning[object]! !== 0,
    hitBody,
    hitContact,
    contactCleared: hitContact !== -1 && sim.contactState.cleared[hitContact]! !== 0,
    contactImpactTick: hitContact !== -1 ? sim.contactState.impactTick[hitContact]! : -1,
  };
}

/** The sim replayed to exactly `observationTick`, resuming from `cache` when it's still usable
 *  (same log length, observation tick hasn't moved backward) rather than rebuilding from tick 0.
 *  `ticksIntegrated` is the incremental delta on a warm resume (0 on an exact cache hit), or the
 *  full `observationTick` on a cold rebuild. */
function simAtObservation({
  level,
  log,
  cache,
  observationTick,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  cache: ObjectCache | undefined;
  observationTick: number;
}): { sim: Sim; ticksIntegrated: number } {
  if (cache && cache.logLength === log.length && observationTick >= cache.observationTick) {
    const sim = deserializeSim({ scenario: level.scenario, bytes: cache.bytes });
    const delta = observationTick - cache.observationTick;
    if (delta > 0) advance({ sim, log, ticks: delta });
    return { sim, ticksIntegrated: delta };
  }
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  advance({ sim, log, ticks: observationTick });
  return { sim, ticksIntegrated: observationTick };
}

const EMPTY_VIEW: ObservedObject = {
  observation: null,
  predicted: null,
  tail: [],
  delaySeconds: NaN,
  expended: false,
  burning: false,
  hitBody: -1,
  hitContact: -1,
  contactCleared: false,
  contactImpactTick: -1,
};

/** One object's observed view at `sim`'s current tick ("now"); `cache.perObject` is updated in
 *  place with this call's own replayed-to-observation state, for the next call to resume from. */
function observedObject({
  level,
  log,
  sim,
  object,
  cache,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  sim: Sim;
  object: number;
  cache: ObservedCache;
}): { view: ObservedObject; ticksIntegrated: number } {
  const atTick = sim.tick;
  const observed = observedState({ sim, object, atTick });
  if (!observed) return { view: EMPTY_VIEW, ticksIntegrated: 0 };

  const { sim: atObservation, ticksIntegrated: resumeTicks } = simAtObservation({
    level,
    log,
    cache: cache.perObject.get(object),
    observationTick: observed.emissionTick,
  });

  cache.perObject.set(object, {
    logLength: log.length,
    observationTick: observed.emissionTick,
    bytes: serializeSim(atObservation),
  });

  const eventState = observedEventState(atObservation, object);
  const expended = eventState.hitBody !== -1 || eventState.hitContact !== -1;
  const tail: ObservedSample[] = [];
  let tailTicks = 0;
  if (!expended) {
    while (atObservation.tick < atTick) {
      advance({ sim: atObservation, log, ticks: 1 });
      tailTicks++;
      tail.push(sampleObject(atObservation, object));
      if (isExpended(atObservation, object)) break;
    }
  }

  const predicted = tail.length > 0 ? tail[tail.length - 1]! : sampleObject(atObservation, object);

  return {
    view: {
      observation: {
        tick: observed.emissionTick,
        x: observed.x,
        y: observed.y,
        vx: observed.vx,
        vy: observed.vy,
      },
      predicted,
      tail,
      delaySeconds: observed.delaySeconds,
      expended,
      ...eventState,
    },
    ticksIntegrated: resumeTicks + tailTicks,
  };
}

/** Every dynamic object's observed view at `sim`'s current tick, refreshed once per tick advance
 *  (app.ts's `step`, the same sampling point as trails/events) -- `cache`'s own per-object resume
 *  state persists across calls; create one with `createObservedCache()` and reuse it for the
 *  loaded session's lifetime. `ticksIntegrated` is this call's own total replay cost, across every
 *  object -- diagnostic only (docs/evidence/GRV-0030/README.md reports it), not read by callers. */
export function observedObjects({
  level,
  log,
  sim,
  cache,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  sim: Sim;
  cache: ObservedCache;
}): { views: ObservedObject[]; ticksIntegrated: number } {
  const views: ObservedObject[] = [];
  let ticksIntegrated = 0;
  for (let i = 0; i < sim.objects.count; i++) {
    const { view, ticksIntegrated: t } = observedObject({ level, log, sim, object: i, cache });
    views.push(view);
    ticksIntegrated += t;
  }
  return { views, ticksIntegrated };
}
