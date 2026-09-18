// Solves the light cone both ways (ADR-0007 §2, §5, §8; ADR-0005 "Light cone"; research §5) and
// tests a signal path for occlusion (ADR-0007 §4, research §5.5). Every command and every
// telemetry query in the simulation goes through this module rather than re-deriving the geometry.

import { evaluateEphemeris } from './ephemeris/bodies.ts';
import { railGeometry } from './rails.ts';
import { postPositionAtTime } from './post.ts';
import { firstAvailableTick, sampleState } from './history.ts';
import type { Sim } from './sim.ts';

/** m/s, exact (SI definition of the metre). */
export const C = 299792458;

const NEWTON_ITERATIONS = 3;
// Generous enough to step back through a several-tick blocked stretch from a spinning or orbiting
// post (module doc) while staying a small, fixed, deterministic bound.
const ISSUE_TICK_FOR_MAX_STEPS = 64;
// segmentBlocked's own "is an endpoint inside this body" test needs slack: a post or a rail is
// itself a surface point (rails.ts's surfacePoint), computed by trig from world-scale coordinates
// (~1e11 m for an outer-system body), so its own distance from its own host's centre lands a few
// ULPs short of that host's exact radius -- without slack every launch/post query would read as
// occluded by its own host. Relative to r^2, comfortably above that rounding error and far below
// any real occlusion margin.
const OCCLUSION_EPSILON = 1e-9;

export type LightconeTarget = { kind: 'rail'; rail: number } | { kind: 'object'; object: number };

interface MovingPoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** `target`'s state at continuous time `t` seconds. A rail is a host surface point, analytic at
 *  any `t` past or future -- exactly like the post. A dynamic object's *future* position cannot be
 *  known without integrating gravity, which the light-cone solvers deliberately do not do (ADR-
 *  0007's decision): its state is instead the object's CURRENT (live, `sim.tick`) position and
 *  velocity, extrapolated ballistically (constant velocity) to `t`. The error this introduces is
 *  `1/2 * a * tau^2` with `tau = t - sim.tick*dt`; by construction every caller here only ever asks
 *  for `t` within one light delay of `sim.tick` (`uplinkArrival`/`downlinkEmission`'s own Newton
 *  loop converges on an arrival/emission a delay away from "now", and `issueTickFor`'s search is
 *  anchored at the same "now") so `tau` never exceeds a delay's worth of seconds and the bound
 *  research §5's worked example gives (~3 km at 40 light-minutes and 1e-3 m/s^2, under one tick of
 *  light) applies directly. There is no way to know the true future without integrating, and the
 *  result is quantised to a tick regardless. */
function targetStateAt({
  sim,
  target,
  t,
}: {
  sim: Sim;
  target: LightconeTarget;
  t: number;
}): MovingPoint {
  if (target.kind === 'rail') {
    evaluateEphemeris(sim.bodies, t, sim.scratch.lightconeEph);
    const g = railGeometry({
      bodies: sim.bodies,
      rails: sim.rails,
      rail: target.rail,
      t,
      eph: sim.scratch.lightconeEph,
    });
    return { x: g.x, y: g.y, vx: g.vx, vy: g.vy };
  }
  const i = target.object;
  const vx = sim.objects.vx[i]!;
  const vy = sim.objects.vy[i]!;
  const tau = t - sim.tick * sim.scenario.dt;
  return { x: sim.objects.x[i]! + vx * tau, y: sim.objects.y[i]! + vy * tau, vx, vy };
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Emission at `issueTick` from the post; finds the arrival tick at `target` (ADR-0007 §8's
 *  uplink equation, `ceil`-quantised). Exactly three Newton iterations from the geometric-delay
 *  starter (research §5.2-5.3): the derivative `u.v_M -/+ c` never vanishes and never changes
 *  sign since every velocity here is far below `c`, so Newton is unconditionally well conditioned
 *  and converges to the double-precision fixed point in two passes; the third is insurance against
 *  an unusually fast contact, not a tolerance check (no tolerance branch, ever -- determinism rule
 *  7). */
export function uplinkArrival({
  sim,
  target,
  issueTick,
}: {
  sim: Sim;
  target: LightconeTarget;
  issueTick: number;
}): number {
  const dt = sim.scenario.dt;
  const te = issueTick * dt;
  const post = postPositionAtTime({ sim, t: te });
  const qx = post.x;
  const qy = post.y;

  const starter = targetStateAt({ sim, target, t: te });
  let t = te + distance(qx, qy, starter.x, starter.y) / C;

  for (let iter = 0; iter < NEWTON_ITERATIONS; iter++) {
    const m = targetStateAt({ sim, target, t });
    const dx = m.x - qx;
    const dy = m.y - qy;
    const d = Math.sqrt(dx * dx + dy * dy);
    // The post placed exactly on the target (a rail, or an object still at the post at issue
    // time -- e.g. the very tick it launched): d is exactly 0, g'(s)'s own u.v_M term is 0/0, but
    // g is already exactly 0 too (the root), so there is nothing to correct -- diving through
    // would only divide by zero.
    if (d === 0) break;
    const g = d - C * (t - te);
    const gp = (dx * m.vx + dy * m.vy) / d - C;
    t = t - g / gp;
  }

  return Math.ceil(t / dt);
}

/** Reception at `receiveTick` at the post; finds the emission tick from `object` (ADR-0007 §8's
 *  downlink equation, `floor`-quantised). Unlike `uplinkArrival`, this genuinely looks into the
 *  past: `object`'s state at the (unknown, being solved for) emission instant is sampled from its
 *  retained history via cubic Hermite (history.ts), not extrapolated, because the past is known
 *  exactly. Returns -1 (contacts.ts's NO_IMPACT convention) if the starter already falls before
 *  the object existed or outside the retained window -- the caller has no observation to show. */
export function downlinkEmission({
  sim,
  object,
  receiveTick,
}: {
  sim: Sim;
  object: number;
  receiveTick: number;
}): number {
  const dt = sim.scenario.dt;
  const tr = receiveTick * dt;
  const post = postPositionAtTime({ sim, t: tr });
  const qx = post.x;
  const qy = post.y;

  const first = firstAvailableTick(sim.history, object);
  const last = sim.history.lastTick[object]!;
  if (first === -1) return -1;
  const lowerBoundT = first * dt;
  const upperBoundT = last * dt;

  const sampleClamped = (t: number) => sampleState({ history: sim.history, object, t, dt });

  // Starter: the geometric delay evaluated at the known endpoint (receiveTick), sampling the
  // object as close to the true emission instant as the retained window allows.
  const probe = tr < upperBoundT ? tr : upperBoundT;
  if (probe < lowerBoundT) return -1;
  const starter = sampleClamped(probe);
  let t = tr - distance(qx, qy, starter.x, starter.y) / C;

  for (let iter = 0; iter < NEWTON_ITERATIONS; iter++) {
    if (t < lowerBoundT || t > upperBoundT) return -1;
    const m = sampleClamped(t);
    const dx = m.x - qx;
    const dy = m.y - qy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d === 0) break; // the object sits exactly on the post: g is already exactly 0, the root.
    const g = d - C * (tr - t);
    const gp = (dx * m.vx + dy * m.vy) / d + C;
    t = t - g / gp;
  }

  if (t < lowerBoundT || t > upperBoundT) return -1;
  return Math.floor(t / dt);
}

/** The latest issue tick `i <= atTick` whose uplink arrival is at or before `atTick` (ADR-0007
 *  §2's "solves the uplink" and its `issueTickFor` consequence): starts from a geometric estimate
 *  of the delay *at* `atTick` (the target's state there -- analytic for a rail, the same live-
 *  state ballistic extrapolation `uplinkArrival` itself uses for an object, so both agree), then
 *  steps down a bounded number of times until the arrival actually fits AND the path is clear at
 *  that instant (ADR-0007 §4: occlusion blocks, so an issue tick this function hands back must
 *  itself be usable) -- correcting whatever the one-shot estimate got wrong. A rotating or orbiting
 *  post can sweep in and out of view every few ticks (a spinning host, or an orbiting one), so
 *  hitting a blocked instant on the way down is ordinary, not exceptional -- the loop keeps
 *  stepping through it rather than stopping at the first tick that merely arrives in time. Never
 *  loops until convergence (determinism rule 7): a fixed maximum of steps, and if it is ever
 *  exhausted the loop simply stops at whatever `i` it reached rather than search further -- a
 *  caller applying that tick for real still runs its own occlusion check (commands.ts) and
 *  rejects it if this bound wasn't enough to clear a long blocked stretch. */
export function issueTickFor({
  sim,
  target,
  atTick,
}: {
  sim: Sim;
  target: LightconeTarget;
  atTick: number;
}): number {
  const dt = sim.scenario.dt;
  const tAt = atTick * dt;
  const post = postPositionAtTime({ sim, t: tAt });
  const there = targetStateAt({ sim, target, t: tAt });
  const roughDelay = distance(post.x, post.y, there.x, there.y) / C;

  let i = atTick - Math.ceil(roughDelay / dt);
  if (i < 0) i = 0;

  for (let step = 0; step < ISSUE_TICK_FOR_MAX_STEPS && i < atTick; step++) {
    const arrival = uplinkArrival({ sim, target, issueTick: i });
    if (arrival <= atTick) {
      const postAtI = postPositionAtTime({ sim, t: i * dt });
      const targetAtI = targetStateAt({ sim, target, t: i * dt });
      const blocked = segmentBlocked({
        sim,
        ax: postAtI.x,
        ay: postAtI.y,
        bx: targetAtI.x,
        by: targetAtI.y,
        tick: i,
      });
      if (!blocked) break;
    }
    i--;
    if (i < 0) {
      i = 0;
      break;
    }
  }

  return i;
}

/** Segment `(ax,ay)-(bx,by)` against every body's occlusion sphere (radius plus its grazing
 *  margin) at `tick` (ADR-0007 §4, research §5.5): the simplification is a single snapshot -- both
 *  endpoints evaluated at the same tick, never per the signal's own emission/reception times -- so
 *  occlusion is a cheap, deterministic pre-check rather than a second light-cone solve. Iterates
 *  bodies by index and stops at the first block (determinism rule 5: the result is a boolean, so
 *  iteration order can't change the value, but a fixed order keeps the profile stable anyway). */
export function segmentBlocked({
  sim,
  ax,
  ay,
  bx,
  by,
  tick,
}: {
  sim: Sim;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  tick: number;
}): boolean {
  const t = tick * sim.scenario.dt;
  evaluateEphemeris(sim.bodies, t, sim.scratch.lightconeEph);
  const eph = sim.scratch.lightconeEph;

  const dx = bx - ax;
  const dy = by - ay;
  const dd = dx * dx + dy * dy;

  for (let b = 0; b < sim.bodies.count; b++) {
    const cx = eph.x[b]!;
    const cy = eph.y[b]!;
    const r = sim.bodies.occlusionRadius[b]!;

    const fx = ax - cx;
    const fy = ay - cy;
    const b2 = fx * dx + fy * dy;
    const c2 = fx * fx + fy * fy - r * r;
    const insideTolerance = OCCLUSION_EPSILON * r * r;
    if (c2 > -insideTolerance && b2 > 0) continue; // both endpoints outside, moving away from it
    if (c2 < -insideTolerance) return true; // an endpoint is inside this body's occlusion sphere
    if (dd === 0) continue; // zero-length segment, on or outside the sphere: no crossing

    const disc = b2 * b2 - dd * c2;
    if (disc < 0) continue;
    const t1 = (-b2 - Math.sqrt(disc)) / dd;
    if (t1 >= 0 && t1 <= 1) return true;
  }

  return false;
}
