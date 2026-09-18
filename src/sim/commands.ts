// Command log records (docs/domain/simulation-determinism.md rule 6,
// ADR-0005 "Command log"): quantised integers only, so the log is
// independent of any UI floating-point path and replay is exact by
// construction. `applyCommand` is the only way a command touches `Sim`
// state; `advance` (sim.ts) is the only caller.
//
// ADR-0007: a command's `tick` is its ISSUE tick at the post, not necessarily the tick it takes
// effect. `applyCommand` validates and solves the light cone to the command's target (the rail's
// host for a launch, the probe for a burn) at issue time; when the resulting arrival tick equals
// the issue tick (no measurable delay -- the common case for a post placed on a rail's own host,
// ADR-0007 §2), the command's effect happens immediately, exactly as before this unit. Otherwise
// it is queued (sim.ts's `enqueuePendingArrival`) and `materializeArrival` applies it once
// `advance` reaches the arrival tick.

import { dcosOut, dsincos, dsinOut } from './math/kernels.ts';
import { evaluateEphemeris } from './ephemeris/bodies.ts';
import { NEVER_LAUNCHED, railGeometry } from './rails.ts';
import { postPositionAtTime } from './post.ts';
import { segmentBlocked, uplinkArrival } from './lightcone.ts';
import type { LightconeTarget } from './lightcone.ts';
import {
  ARRIVAL_KIND_BURN,
  ARRIVAL_KIND_LAUNCH,
  enqueuePendingArrival,
  pendingLaunchArrivalAt,
} from './arrivals.ts';
import type { PendingArrivals } from './arrivals.ts';
import type { Sim } from './sim.ts';

/** 1/2^32 of a turn (ADR-0006 §4, superseding the 1/65536 unit ADR-0005
 *  originally chose -- docs/issues/2026-09-17-heading-quantum-too-coarse-
 *  for-intercepts.md measured the old quantum's miss against a capture
 *  radius of tens of kilometres). The full range is still < 2*pi and stays
 *  inside dsincos's contractual domain (research §2.2) with no reduction
 *  needed. */
export const HEADING_TURN = 4294967296;
const TWO_PI = 6.283185307179586;
const MM_PER_M = 1000;

export interface LaunchCommand {
  tick: number;
  kind: 'launch';
  /** Rail index (Sim.rails order; GRV-0014 -- the old radial-launch `body`
   *  field is gone, a rail is now the only way to launch). */
  rail: number;
  /** 0..4294967295 (2^32 - 1), 1/2^32 of a turn: the launch's absolute
   *  inertial heading. */
  heading: number;
  /** mm/s, muzzle speed relative to the rail -- added to the host's own
   *  velocity plus its surface rotation velocity (GAME-0001 §4.2). */
  speed: number;
}

export interface BurnCommand {
  tick: number;
  kind: 'burn';
  /** Dynamic object index; must already exist (an earlier or same-tick,
   *  earlier-in-log launch), or reference the probe a same-tick, still-
   *  pending launch will create (ADR-0007 §2, "same issue batch"). */
  probe: number;
  /** Tick the burn should activate on (may be later than `tick`). */
  atTick: number;
  /** mm/s along the frozen inertial-velocity direction at activation. */
  prograde: number;
  /** mm/s along the frozen +90 degree (left of velocity) direction. */
  lateral: number;
}

export type Command = LaunchCommand | BurnCommand;

function requireInt(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got ${value}`);
}

function requireRange(value: number, name: string, min: number, max: number): void {
  if (value < min || value > max)
    throw new Error(`${name} must be in [${min}, ${max}], got ${value}`);
}

/** Why a launch would be rejected (GRV-0014, ADR-0007 §4): a discriminated reason rather than a
 *  thrown error, so the planner UI can explain a disabled launch before the player commits to it.
 *  `applyLaunch` is the only caller that turns a non-null result into a throw; format checks
 *  (integer-ness, range) stay there too, since those are the log's own quantisation contract, not
 *  a rail rule.
 *
 *  Reads `sim` but never writes it, so it is safe to call speculatively, at
 *  any tick, without perturbing the simulation -- checked directly
 *  (commands.test.ts: "checkLaunch is pure"). It evaluates the ephemeris
 *  into `sim.scratch.eph`/`sim.scratch.lightconeEph` as scratch work, exactly as `applyLaunch`
 *  itself does; `scratch` is derived, per-run working memory, never part of
 *  `hashSim`/`serializeSim` (sim.ts), so overwriting it here changes
 *  nothing the determinism contract cares about. Assumes `command.rail` is
 *  a valid index into `sim.rails` -- callers (`applyLaunch`, and any
 *  planner UI) validate that first, the same way an out-of-range `probe` on
 *  a burn command is validated before it ever reaches burn logic. */
export type LaunchRejection = 'capacity' | 'reloading' | 'speed' | 'cone' | 'occluded';

/** The tick a launch command issued now would arrive at its rail (ADR-0007 §2: uplink to the
 *  rail's host). Exposed separately from `checkLaunch` so a caller that only wants the arrival
 *  (`applyLaunch`, `issueTickFor`'s own callers) doesn't pay for a second rejection pass, and one
 *  whose plan was already accepted by `checkLaunch` doesn't need to re-derive the light cone
 *  itself (ADR-0007 "Consequences"). */
export function launchArrivalTick({ sim, command }: { sim: Sim; command: LaunchCommand }): number {
  const target: LightconeTarget = { kind: 'rail', rail: command.rail };
  return uplinkArrival({ sim, target, issueTick: command.tick });
}

export function checkLaunch({
  sim,
  command,
}: {
  sim: Sim;
  command: LaunchCommand;
}): LaunchRejection | null {
  if (sim.objects.count >= sim.scenario.capacity) return 'capacity';

  const rails = sim.rails;
  const rail = command.rail;
  const arrivalTick = launchArrivalTick({ sim, command });

  // The reload check and the launch geometry both read the rail's state at the tick the launch
  // actually fires -- the arrival tick, not the issue tick (ADR-0007: "the rail reload check uses
  // the arrival tick, the rail fires when the order arrives").
  const last = sim.railLastLaunchTick[rail]!;
  if (last !== NEVER_LAUNCHED && arrivalTick - last < rails.reloadTicks[rail]!) return 'reloading';

  const speed = command.speed / MM_PER_M;
  if (speed < rails.muzzleSpeedMin[rail]! || speed > rails.muzzleSpeedMax[rail]!) return 'speed';

  const tArrival = arrivalTick * sim.scenario.dt;
  evaluateEphemeris(sim.bodies, tArrival, sim.scratch.eph);
  const { ux, uy } = railGeometry({
    bodies: sim.bodies,
    rails,
    rail,
    t: tArrival,
    eph: sim.scratch.eph,
  });
  dsincos((command.heading * TWO_PI) / HEADING_TURN);
  const dot = dcosOut * ux + dsinOut * uy;
  if (dot < rails.cosHeadingCone[rail]!) return 'cone';

  // Occlusion is a snapshot at issue time (ADR-0007 §4): the segment from the post to the rail as
  // the order is sent, never the (unknowable in advance) path the signal actually threads.
  const tIssue = command.tick * sim.scenario.dt;
  const post = postPositionAtTime({ sim, t: tIssue });
  evaluateEphemeris(sim.bodies, tIssue, sim.scratch.eph);
  const railAtIssue = railGeometry({
    bodies: sim.bodies,
    rails,
    rail,
    t: tIssue,
    eph: sim.scratch.eph,
  });
  if (
    segmentBlocked({
      sim,
      ax: post.x,
      ay: post.y,
      bx: railAtIssue.x,
      by: railAtIssue.y,
      tick: command.tick,
    })
  )
    return 'occluded';

  return null;
}

function materializeLaunch({
  sim,
  arrivalTick,
  rail,
  heading,
  speed,
}: {
  sim: Sim;
  arrivalTick: number;
  rail: number;
  heading: number;
  speed: number;
}): void {
  // Rail state at the tick the launch actually fires (the arrival tick): the same instant
  // checkLaunch's own cone test used.
  const t = arrivalTick * sim.scenario.dt;
  evaluateEphemeris(sim.bodies, t, sim.scratch.eph);
  const geometry = railGeometry({
    bodies: sim.bodies,
    rails: sim.rails,
    rail,
    t,
    eph: sim.scratch.eph,
  });
  dsincos((heading * TWO_PI) / HEADING_TURN);
  const dx = dcosOut;
  const dy = dsinOut;
  const speedMs = speed / MM_PER_M;

  const i = sim.objects.count++;
  sim.objects.x[i] = geometry.x;
  sim.objects.y[i] = geometry.y;
  sim.objects.vx[i] = geometry.vx + dx * speedMs;
  sim.objects.vy[i] = geometry.vy + dy * speedMs;
  sim.objects.hitBody[i] = -1;
  sim.objects.mass[i] = sim.scenario.probe.dryMass + sim.scenario.probe.propellantMass;
  sim.objects.dryMass[i] = sim.scenario.probe.dryMass;
  sim.objects.thrust[i] = sim.scenario.probe.thrust;
  sim.objects.exhaustVelocity[i] = sim.scenario.probe.exhaustVelocity;
  sim.objects.burnNx[i] = 0;
  sim.objects.burnNy[i] = 0;
  sim.objects.burnTarget[i] = 0;
  sim.objects.burnDelivered[i] = 0;
  sim.objects.burning[i] = 0;

  sim.railLastLaunchTick[rail] = arrivalTick;
}

function applyLaunch(sim: Sim, command: LaunchCommand): void {
  requireInt(command.rail, 'rail');
  requireRange(command.rail, 'rail', 0, sim.rails.count - 1);
  requireInt(command.heading, 'heading');
  requireRange(command.heading, 'heading', 0, HEADING_TURN - 1);
  requireInt(command.speed, 'speed');
  requireRange(command.speed, 'speed', 0, Number.MAX_SAFE_INTEGER);

  const reason = checkLaunch({ sim, command });
  if (reason !== null) throw new Error(`launch: rejected (${reason})`);

  const arrivalTick = launchArrivalTick({ sim, command });
  if (arrivalTick === command.tick) {
    materializeLaunch({
      sim,
      arrivalTick,
      rail: command.rail,
      heading: command.heading,
      speed: command.speed,
    });
  } else {
    enqueuePendingArrival({
      pending: sim.pendingArrivals,
      arrivalTick,
      kind: ARRIVAL_KIND_LAUNCH,
      tick: command.tick,
      a: command.rail,
      b: command.heading,
      c: command.speed,
      d: 0,
    });
  }
}

interface ResolvedBurnProbe {
  /** The object index this burn targets, once resolved (existing or bundled-to-be-created). */
  probe: number;
  /** True if `probe` already exists in `sim.objects` right now. */
  exists: boolean;
  /** The arrival tick of a same-tick, still-pending launch that will create `probe`, or -1 if
   *  `probe` neither exists nor is bundled with one (ADR-0007's "same issue batch"). */
  bundledArrivalTick: number;
}

function resolveBurnProbe(sim: Sim, command: BurnCommand): ResolvedBurnProbe {
  if (Number.isInteger(command.probe) && command.probe >= 0 && command.probe < sim.objects.count)
    return { probe: command.probe, exists: true, bundledArrivalTick: -1 };
  const bundledArrivalTick = pendingLaunchArrivalAt({
    pending: sim.pendingArrivals,
    issueTick: command.tick,
  });
  return { probe: command.probe, exists: false, bundledArrivalTick };
}

/** Why a burn would be rejected once its probe reference is known-valid (ADR-0007 §3, §4): a burn
 *  bundled with a same-tick, not-yet-arrived launch (`resolveBurnProbe`'s "bundled" case) is never
 *  rejected here -- the whole plan travels as one transmission, and the launch's own `checkLaunch`
 *  already covers occlusion for that transmission (module header). An unresolvable probe (neither
 *  live nor bundled) is a format error, thrown by `applyBurn` before `checkBurn` is ever called,
 *  mirroring `checkLaunch`'s own split between thrown format errors and returned business
 *  rejections. */
export type BurnRejection = 'locked' | 'occluded';

/** The tick a burn command issued now would arrive at its probe (ADR-0007 §2: uplink to the
 *  probe), or the arrival of the same-tick launch it is bundled with. Throws if the probe is
 *  neither live nor bundled -- callers validate that first (mirrors `launchArrivalTick`'s own
 *  role for launches). */
export function burnArrivalTick({ sim, command }: { sim: Sim; command: BurnCommand }): number {
  const resolved = resolveBurnProbe(sim, command);
  if (resolved.exists) {
    const target: LightconeTarget = { kind: 'object', object: resolved.probe };
    return uplinkArrival({ sim, target, issueTick: command.tick });
  }
  if (resolved.bundledArrivalTick !== -1) return resolved.bundledArrivalTick;
  throw new Error(`burn: no such probe (${command.probe})`);
}

export function checkBurn({
  sim,
  command,
}: {
  sim: Sim;
  command: BurnCommand;
}): BurnRejection | null {
  const resolved = resolveBurnProbe(sim, command);
  if (!resolved.exists) return null; // bundled, or unresolved (applyBurn throws first)

  const target: LightconeTarget = { kind: 'object', object: resolved.probe };
  const arrivalTick = uplinkArrival({ sim, target, issueTick: command.tick });
  if (command.atTick < arrivalTick) return 'locked';

  const post = postPositionAtTime({ sim, t: command.tick * sim.scenario.dt });
  const ox = sim.objects.x[resolved.probe]!;
  const oy = sim.objects.y[resolved.probe]!;
  if (segmentBlocked({ sim, ax: post.x, ay: post.y, bx: ox, by: oy, tick: command.tick }))
    return 'occluded';

  return null;
}

function materializeBurn({
  sim,
  probe,
  atTick,
  prograde,
  lateral,
}: {
  sim: Sim;
  probe: number;
  atTick: number;
  prograde: number;
  lateral: number;
}): void {
  const pending = sim.pending;
  if (pending.count >= pending.object.length)
    throw new Error(`burn: pending burn queue capacity ${pending.object.length} exceeded`);

  // Insertion-sort into place by atTick, so the queue stays sorted and
  // activateDueBurnNodes (sim.ts) never has to guess an order: ties go after
  // every existing entry with the same atTick, which is exactly log order
  // since commands are applied (and so enqueued) in log order.
  let p = pending.count;
  while (p > 0 && pending.atTick[p - 1]! > atTick) {
    pending.object[p] = pending.object[p - 1]!;
    pending.atTick[p] = pending.atTick[p - 1]!;
    pending.prograde[p] = pending.prograde[p - 1]!;
    pending.lateral[p] = pending.lateral[p - 1]!;
    p--;
  }
  pending.object[p] = probe;
  pending.atTick[p] = atTick;
  pending.prograde[p] = prograde;
  pending.lateral[p] = lateral;
  pending.count++;
}

function applyBurn(sim: Sim, command: BurnCommand): void {
  requireInt(command.probe, 'probe');
  requireInt(command.atTick, 'atTick');
  if (command.atTick < command.tick)
    throw new Error(`burn: atTick ${command.atTick} precedes command tick ${command.tick}`);
  requireInt(command.prograde, 'prograde');
  requireRange(command.prograde, 'prograde', -0x7fffffff, 0x7fffffff);
  requireInt(command.lateral, 'lateral');
  requireRange(command.lateral, 'lateral', -0x7fffffff, 0x7fffffff);
  // A zero delta-v target has no burn direction to freeze: startBurn (burn.ts)
  // throws on it, but only once the node comes due, ticks after this command
  // was applied. Reject it here instead, before it ever reaches the queue.
  if (command.prograde === 0 && command.lateral === 0)
    throw new Error('burn: prograde and lateral cannot both be zero');

  const resolved = resolveBurnProbe(sim, command);
  if (!resolved.exists && resolved.bundledArrivalTick === -1)
    throw new Error(`burn: no such probe (${command.probe})`);

  if (resolved.exists) {
    const reason = checkBurn({ sim, command });
    if (reason !== null) throw new Error(`burn: rejected (${reason})`);
  }

  const arrivalTick = resolved.exists
    ? burnArrivalTick({ sim, command })
    : resolved.bundledArrivalTick;

  if (arrivalTick === command.tick) {
    materializeBurn({
      sim,
      probe: resolved.probe,
      atTick: command.atTick,
      prograde: command.prograde,
      lateral: command.lateral,
    });
  } else {
    enqueuePendingArrival({
      pending: sim.pendingArrivals,
      arrivalTick,
      kind: ARRIVAL_KIND_BURN,
      tick: command.tick,
      a: resolved.probe,
      b: command.atTick,
      c: command.prograde,
      d: command.lateral,
    });
  }
}

/** Validates and applies one command. The only way a command touches `Sim`
 *  state; a burn command only enqueues a pending node (sim.ts's
 *  `activateDueBurnNodes` arms it once due and the probe is free). */
export function applyCommand({ sim, command }: { sim: Sim; command: Command }): void {
  requireInt(command.tick, 'tick');
  requireRange(command.tick, 'tick', 0, Number.MAX_SAFE_INTEGER);
  if (command.kind === 'launch') applyLaunch(sim, command);
  else applyBurn(sim, command);
}

/** Applies a command whose light-cone arrival is due now (sim.ts's `applyDueArrivals`): the
 *  counterpart to `applyCommand`'s own immediate-effect branch, for a command that was queued
 *  because its arrival was later than its issue tick. No re-validation -- ADR-0007 §3's "what
 *  arrives late cannot be undone early" means everything was already decided at issue time; this
 *  only ever performs the effect. */
export function materializeArrival({
  sim,
  pending,
  index,
}: {
  sim: Sim;
  pending: PendingArrivals;
  index: number;
}): void {
  const arrivalTick = pending.arrivalTick[index]!;
  if (pending.kind[index] === ARRIVAL_KIND_LAUNCH) {
    materializeLaunch({
      sim,
      arrivalTick,
      rail: pending.a[index]!,
      heading: pending.b[index]!,
      speed: pending.c[index]!,
    });
  } else {
    materializeBurn({
      sim,
      probe: pending.a[index]!,
      atTick: pending.b[index]!,
      prograde: pending.c[index]!,
      lateral: pending.d[index]!,
    });
  }
}
