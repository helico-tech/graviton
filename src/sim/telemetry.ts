// The post's picture of a dynamic object (ADR-0007 §5-6, docs/domain/signal-delay-and-
// uncertainty.md §2): the downlink emission the observation at a given tick came from, and the
// object's state then -- `null` before the object's first light has reached the post, or while
// the path was blocked. Every telemetry query the app makes goes through this, one level above
// lightcone.ts's own "every command and every telemetry query goes through this module" contract.
import { downlinkEmission, segmentBlocked } from './lightcone.ts';
import { postPositionAtTime } from './post.ts';
import { sampleState } from './history.ts';
import type { Sim } from './sim.ts';

export interface ObservedState {
  /** The tick the observed light left `object` (downlinkEmission's own floor-quantised result,
   *  ADR-0007 §5). */
  emissionTick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** How stale this observation is at `atTick`, in seconds: `(atTick - emissionTick) * dt`. */
  delaySeconds: number;
}

/** The post's observation of `object` at `atTick`: the emission tick and state `downlinkEmission`
 *  finds, or `null` before the object's first light has reached the post (no retained history
 *  yet, or the emission would predate the object's launch) or while the path from the object's
 *  emission position to the post's position at that same instant was blocked (ADR-0007 §4) -- a
 *  single-snapshot approximation, exactly `segmentBlocked`'s own one (both endpoints evaluated at
 *  the emission tick, not at their own separate emission/reception instants): the object's own
 *  emission-time position is what a body could plausibly stand in front of, and by the time the
 *  post's own position has moved on (a fraction of a tick's arc at most, since the post is a
 *  surface point, never faster than the body it rides), re-evaluating the post there instead
 *  would not change which body -- if any -- sat on the line. */
export function observedState({
  sim,
  object,
  atTick,
}: {
  sim: Sim;
  object: number;
  atTick: number;
}): ObservedState | null {
  const emissionTick = downlinkEmission({ sim, object, receiveTick: atTick });
  if (emissionTick === -1) return null;

  const dt = sim.scenario.dt;
  const state = sampleState({ history: sim.history, object, t: emissionTick * dt, dt });
  const post = postPositionAtTime({ sim, t: emissionTick * dt });
  // Post first, mirroring every command-side call (commands.ts's checkLaunch/checkBurn): the post
  // is always a surface point sitting exactly on its own host's occlusion sphere, and
  // segmentBlocked's own grazing tolerance (lightcone.ts's OCCLUSION_EPSILON) only guards the
  // first ("ax,ay") endpoint against that -- see docs/issues/2026-09-18-segmentblocked-false-
  // positive-on-distant-target-graze.md.
  const blocked = segmentBlocked({
    sim,
    ax: post.x,
    ay: post.y,
    bx: state.x,
    by: state.y,
    tick: emissionTick,
  });
  if (blocked) return null;

  return {
    emissionTick,
    x: state.x,
    y: state.y,
    vx: state.vx,
    vy: state.vy,
    delaySeconds: (atTick - emissionTick) * dt,
  };
}
