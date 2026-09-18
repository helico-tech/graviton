// What telemetry has actually confirmed about a contact or a probe (ADR-0007 §5-6, GRV-0030,
// GAME-0001 §4.6 "the post plans on what it knows"): pure over `SimEvent[]` (app.ts's own
// append-only log, which by construction holds only events whose `arrivalTick` has already
// passed -- see events.ts's own module doc) and, for a probe, its `ObservedObject`. No `Sim` here
// at all, so `src/render/frame.ts` and `src/app/selection.ts` can call these without themselves
// becoming readers of `sim.contactState`/`sim.objects` (src/app/premise.test.ts's own guard) --
// the one shared place `describeContact`, `describeProbe`, `captureFrame`'s contacts loop and
// `timelineData`'s impact mark all read from, so the four can no longer drift apart the way
// GRV-0032's own issue found them doing.
import type { SimEvent } from './events.ts';
import type { ObservedObject } from './observed.ts';

/** A contact's outcome as telemetry has confirmed it: `'uncleared'` before any confirmed impact
 *  at all (the sim.ts default, contactState.impactTick === NO_IMPACT, read out through an event
 *  instead of the field directly); otherwise the *last* confirmed impact's own tick, the tick its
 *  telemetry arrived, and the speed/energy that impact carried (contacts.ts's own "record the
 *  last impact only", GRV-0015) -- `cleared` is `true` once any confirmed `cleared` event has
 *  landed for this contact (a one-way flag in the sim, never unset once true). */
export type ConfirmedContactState =
  | {
      readonly cleared: boolean;
      readonly impactTick: number;
      readonly arrivalTick: number;
      readonly closingSpeed: number;
      readonly impactEnergy: number;
    }
  | 'uncleared';

export function confirmedContactState({
  eventLog,
  contact,
}: {
  eventLog: readonly SimEvent[];
  contact: number;
}): ConfirmedContactState {
  let lastImpact: SimEvent | null = null;
  let cleared = false;
  for (const event of eventLog) {
    if (event.contact !== contact) continue;
    if (event.kind === 'impact') lastImpact = event;
    else if (event.kind === 'cleared') cleared = true;
  }
  if (!lastImpact) return 'uncleared';
  return {
    cleared,
    impactTick: lastImpact.tick,
    arrivalTick: lastImpact.arrivalTick!,
    closingSpeed: lastImpact.closingSpeed!,
    impactEnergy: lastImpact.impactEnergy!,
  };
}

/** A probe's outcome as telemetry has confirmed it: `'unobserved'` before the post has any
 *  observation of it at all (nothing to read a state off of, `describeProbe`'s own `—` row);
 *  `'flying'` once observed but with no confirmed `impact`/`bodyHit` event yet -- `describeProbe`
 *  itself distinguishes BURNING from this using `observed.burning` (already gated the same way,
 *  observed.ts's own boundary), since burning isn't an "expended" edge this module tracks; or the
 *  event tick and the tick telemetry actually confirmed it, for whichever of `impact`/`bodyHit`
 *  landed last (an object expends at most once, so there is at most one). */
export type ConfirmedProbeState =
  'unobserved' | 'flying' | { readonly expendedTick: number; readonly confirmedTick: number };

export function confirmedProbeState({
  eventLog,
  observed,
  probe,
}: {
  eventLog: readonly SimEvent[];
  observed: ObservedObject | null;
  probe: number;
}): ConfirmedProbeState {
  if (!observed?.observation) return 'unobserved';

  for (let i = eventLog.length - 1; i >= 0; i--) {
    const event = eventLog[i]!;
    if (event.probe !== probe) continue;
    if (event.kind === 'impact' || event.kind === 'bodyHit') {
      return { expendedTick: event.tick, confirmedTick: event.arrivalTick! };
    }
  }
  return 'flying';
}
