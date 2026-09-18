// Simulation events (GAME-0001 §4.11 "automatic drop to one times on events of interest", GAME-
// 0002 §9's inverted-frame announcement): derived from state deltas between two tick samples,
// never from the renderer (determinism rule 11) -- launch (object count rises), node start/end
// (burning edges), impact/body hit (hitContact/hitBody newly set), a contact clearing, and each
// uncleared contact's closest approach (its range to a probe turning from falling to rising).
// Pure and sim-free so it's directly testable; app.ts samples the live Sim once per tick
// (extending trails.ts's own per-tick sampling point rather than adding a second loop) and calls
// `diffEvents`/`sampleClosestApproach` here, appending whatever lands to its own session event log.
export type SimEventKind =
  'launch' | 'nodeStart' | 'nodeEnd' | 'impact' | 'bodyHit' | 'cleared' | 'closestApproach';

export interface SimEvent {
  readonly tick: number;
  readonly kind: SimEventKind;
  readonly probe?: number;
  readonly contact?: number;
  readonly body?: number;
}

export interface EventObjectState {
  readonly burning: boolean;
  /** -1 until a hit is recorded, matching contacts.ts's/objects' own sentinel convention. */
  readonly hitContact: number;
  readonly hitBody: number;
}

export interface EventContactState {
  readonly cleared: boolean;
  /** contacts.ts's NO_IMPACT sentinel until a hit is recorded -- the authoritative tick for an
   *  impact/cleared event, preferred over a derived one the same way src/planner/ghost.ts trusts
   *  `sim.contactState.impactTick` directly. */
  readonly impactTick: number;
}

export interface EventSnapshot {
  readonly tick: number;
  readonly objects: readonly EventObjectState[];
  readonly contacts: readonly EventContactState[];
}

/** Edge-detected events between two adjacent tick samples: an object newly existing (launch), a
 *  burning flag flipping (node start/end), hitContact/hitBody newly set (impact/body hit), and a
 *  contact's cleared flag flipping. `before`/`after` must be exactly one tick apart -- app.ts calls
 *  this once per tick it advances, never once per frame, so an event is never missed at high warp.
 *  Every edge here lands during the *same* physics step that advanced `before.tick` to `after.tick`
 *  (sim.ts's `advance`: apply commands, activate nodes, step, *then* increment the clock), so it is
 *  tagged at the pre-increment tick (`after.tick - 1`) -- except impact/cleared, which trust the
 *  sim's own recorded `impactTick` instead. Closest approach isn't here: it needs a third point
 *  (the trend arriving at `before`), see `sampleClosestApproach`. */
export function diffEvents({
  before,
  after,
}: {
  before: EventSnapshot;
  after: EventSnapshot;
}): SimEvent[] {
  const events: SimEvent[] = [];
  const priorTick = after.tick - 1;

  for (let i = before.objects.length; i < after.objects.length; i++) {
    events.push({ tick: priorTick, kind: 'launch', probe: i });
  }

  const objectCount = Math.min(before.objects.length, after.objects.length);
  for (let i = 0; i < objectCount; i++) {
    const b = before.objects[i]!;
    const a = after.objects[i]!;
    if (!b.burning && a.burning) events.push({ tick: priorTick, kind: 'nodeStart', probe: i });
    else if (b.burning && !a.burning) events.push({ tick: priorTick, kind: 'nodeEnd', probe: i });

    if (b.hitContact === -1 && a.hitContact !== -1) {
      const contact = after.contacts[a.hitContact];
      events.push({
        tick: contact?.impactTick ?? priorTick,
        kind: 'impact',
        probe: i,
        contact: a.hitContact,
      });
    } else if (b.hitBody === -1 && a.hitBody !== -1) {
      events.push({ tick: priorTick, kind: 'bodyHit', probe: i, body: a.hitBody });
    }
  }

  const contactCount = Math.min(before.contacts.length, after.contacts.length);
  for (let c = 0; c < contactCount; c++) {
    if (!before.contacts[c]!.cleared && after.contacts[c]!.cleared) {
      events.push({ tick: after.contacts[c]!.impactTick, kind: 'cleared', contact: c });
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
