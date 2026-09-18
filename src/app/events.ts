// Simulation events (GAME-0001 §4.11 "automatic drop to one times on events of interest", GAME-
// 0002 §9's inverted-frame announcement; GRV-0030, ADR-0007 §6 "the player's events are telemetry
// events"): launch, node start/end (burning edges), impact/body hit (hitContact/hitBody newly
// set) and a contact clearing are derived from state deltas between two *observed* tick samples
// (src/app/observed.ts), never the live simulation and never the renderer (determinism rule 11) --
// each carries both `tick` (the simulation tick it happened, from the observation) and
// `arrivalTick` (the tick the post's telemetry actually revealed it). Closest approach is the one
// exception: it stays a prediction event, fed from live positions the same way it always was --
// GAME-0001 §4.6's own planner overlay already treats it as a forecast, not a confirmed telemetry
// fact. Pure and sim-free so it's directly testable; app.ts calls `diffObservedEvents`/
// `sampleClosestApproach` here once per tick it advances, appending whatever lands to its own
// session event log.
export type SimEventKind =
  'launch' | 'nodeStart' | 'nodeEnd' | 'impact' | 'bodyHit' | 'cleared' | 'closestApproach';

export interface SimEvent {
  readonly tick: number;
  readonly kind: SimEventKind;
  readonly probe?: number;
  readonly contact?: number;
  readonly body?: number;
  /** The tick the post's own telemetry revealed this (ADR-0007 §6): present on every telemetry
   *  event (launch, node start/end, impact, body hit, cleared); absent on `closestApproach`, which
   *  is a prediction, never something telemetry itself reports arriving. */
  readonly arrivalTick?: number;
}

/** The live, per-tick state `sampleClosestApproach`'s own caller (app.ts) still needs -- closest
 *  approach stays a prediction event fed from live positions, and skips an already-expended
 *  object or an already-cleared contact the same way it always did. */
export interface EventObjectState {
  readonly burning: boolean;
  /** -1 until a hit is recorded, matching contacts.ts's/objects' own sentinel convention. */
  readonly hitContact: number;
  readonly hitBody: number;
}

export interface EventContactState {
  readonly cleared: boolean;
  /** contacts.ts's NO_IMPACT sentinel until a hit is recorded. */
  readonly impactTick: number;
}

/** The event-relevant fields of one object's observed state at one tick (src/app/observed.ts's
 *  own `ObservedObject`, restated as the minimal shape this module actually reads). */
export interface ObservedEventObject {
  readonly observation: { readonly tick: number } | null;
  readonly burning: boolean;
  readonly hitBody: number;
  readonly hitContact: number;
  readonly contactCleared: boolean;
  /** The sim's own authoritative impact tick for `hitContact`, -1 without one. */
  readonly contactImpactTick: number;
}

/** Edge-detected telemetry events between two observed-view samples, one app tick apart (app.ts
 *  calls this once per tick it advances, never once per frame, so an event is never missed at high
 *  warp): an object newly observed at all (launch confirmation), a burning flag flipping (node
 *  start/end), hitContact/hitBody newly set (impact/body hit), and a contact clearing. `arrivalTick`
 *  is simply `after`'s own app tick (`atTick`, the moment this observation was made). `tick` -- the
 *  simulation tick the event actually happened at -- differs by case: a launch is recorded in
 *  history *at* the object's own creation tick (sim.ts's own "firstWriteTick really is the launch
 *  tick"), so the first-ever observation's own tick already *is* the launch tick, no adjustment
 *  needed; impact/cleared trust the sim's own recorded `contactImpactTick` (an occlusion blackout,
 *  GRV-0030 -- a fixed contact's host rotating the post out of view for a while, a real, observed
 *  case on level 01's own post-impact geometry -- can put many ticks between the last "no hit yet"
 *  observation and the first "hit" one, so the *observation's own* tick would badly overshoot);
 *  node start/end have no such authoritative record (contacts.ts's own sentinel convention doesn't
 *  extend to burning) and stay tagged one tick *before* the sample that first shows them, the
 *  live-state version's own "pre-increment tick" convention -- exact only when observations are
 *  genuinely one tick apart, same limitation the live version always had for a warp-sized step.
 *  An object with no observation yet in `after` has nothing to report. */
export function diffObservedEvents({
  before,
  after,
  atTick,
}: {
  before: readonly ObservedEventObject[];
  after: readonly ObservedEventObject[];
  atTick: number;
}): SimEvent[] {
  const events: SimEvent[] = [];

  for (let i = 0; i < after.length; i++) {
    const a = after[i]!;
    if (!a.observation) continue;
    const b = before[i];
    const wasObserved = b?.observation !== null && b?.observation !== undefined;

    if (!wasObserved) {
      events.push({ tick: a.observation.tick, arrivalTick: atTick, kind: 'launch', probe: i });
      continue; // nothing to diff burning/hit against yet -- this is the object's first sample.
    }
    const tick = a.observation.tick - 1;

    if (!b!.burning && a.burning) {
      events.push({ tick, arrivalTick: atTick, kind: 'nodeStart', probe: i });
    } else if (b!.burning && !a.burning) {
      events.push({ tick, arrivalTick: atTick, kind: 'nodeEnd', probe: i });
    }

    const wasHitContact = b!.hitContact;
    const wasHitBody = b!.hitBody;
    if (wasHitContact === -1 && a.hitContact !== -1) {
      const impactTick = a.contactImpactTick;
      events.push({
        tick: impactTick,
        arrivalTick: atTick,
        kind: 'impact',
        probe: i,
        contact: a.hitContact,
      });
      if (a.contactCleared) {
        events.push({
          tick: impactTick,
          arrivalTick: atTick,
          kind: 'cleared',
          contact: a.hitContact,
        });
      }
    } else if (wasHitBody === -1 && a.hitBody !== -1) {
      events.push({ tick, arrivalTick: atTick, kind: 'bodyHit', probe: i, body: a.hitBody });
    }
  }

  return events;
}

export interface RangeTrend {
  readonly tick: number;
  readonly range: number;
  /** Whether `range` fell arriving at this sample (strictly less than the sample before it) --
   *  `false` for the very first sample of a series, same as a flat or rising step. */
  readonly falling: boolean;
}

/** Feeds one more `(tick, range)` sample into a per-(probe, contact) trend and reports a
 *  closestApproach event exactly when the range stops falling -- the *previous* sample was the
 *  local minimum (GRV-0027 design note: "a per-probe range minimum turning into a rise between
 *  consecutive tick samples"). A monotonically falling series (still closing in) reports nothing
 *  until it turns; a monotonically rising one (never closed in) never fires, since a fresh `prior`
 *  starts with `falling: false`. Pass the returned `trend` back in as `prior` for the next sample;
 *  `prior: null` starts a fresh series (a probe/contact pair seen for the first time). */
export function sampleClosestApproach({
  prior,
  tick,
  probe,
  contact,
  range,
}: {
  prior: RangeTrend | null;
  tick: number;
  probe: number;
  contact: number;
  range: number;
}): { trend: RangeTrend; event: SimEvent | null } {
  if (!prior) return { trend: { tick, range, falling: false }, event: null };

  const falling = range < prior.range;
  const event: SimEvent | null =
    !falling && prior.falling
      ? { tick: prior.tick, kind: 'closestApproach', probe, contact }
      : null;
  return { trend: { tick, range, falling }, event };
}
