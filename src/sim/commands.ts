// Command log records (docs/domain/simulation-determinism.md rule 6,
// ADR-0005 "Command log"): quantised integers only, so the log is
// independent of any UI floating-point path and replay is exact by
// construction. `applyCommand` is the only way a command touches `Sim`
// state; `advance` (sim.ts) is the only caller.

import { dcosOut, dsincos, dsinOut } from './math/kernels.ts';
import { evaluateEphemeris } from './ephemeris/bodies.ts';
import { NEVER_LAUNCHED, railGeometry } from './rails.ts';
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
   *  earlier-in-log launch). */
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

/** Why a launch would be rejected (GRV-0014): a discriminated reason rather
 *  than a thrown error, so the planner UI can explain a disabled launch
 *  before the player commits to it. `applyLaunch` is the only caller that
 *  turns a non-null result into a throw; format checks (integer-ness,
 *  range) stay there too, since those are the log's own quantisation
 *  contract, not a rail rule.
 *
 *  Reads `sim` but never writes it, so it is safe to call speculatively, at
 *  any tick, without perturbing the simulation -- checked directly
 *  (commands.test.ts: "checkLaunch is pure"). It evaluates the ephemeris
 *  into `sim.scratch.eph` as scratch work, exactly as `applyLaunch` itself
 *  does; `scratch` is derived, per-run working memory, never part of
 *  `hashSim`/`serializeSim` (sim.ts), so overwriting it here changes
 *  nothing the determinism contract cares about. Assumes `command.rail` is
 *  a valid index into `sim.rails` -- callers (`applyLaunch`, and any
 *  planner UI) validate that first, the same way an out-of-range `probe` on
 *  a burn command is validated before it ever reaches burn logic. */
export type LaunchRejection = 'capacity' | 'reloading' | 'speed' | 'cone';

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
  const last = sim.railLastLaunchTick[rail]!;
  if (last !== NEVER_LAUNCHED && command.tick - last < rails.reloadTicks[rail]!) return 'reloading';

  const speed = command.speed / MM_PER_M;
  if (speed < rails.muzzleSpeedMin[rail]! || speed > rails.muzzleSpeedMax[rail]!) return 'speed';

  const t = command.tick * sim.scenario.dt;
  evaluateEphemeris(sim.bodies, t, sim.scratch.eph);
  const { ux, uy } = railGeometry({ bodies: sim.bodies, rails, rail, t, eph: sim.scratch.eph });
  dsincos((command.heading * TWO_PI) / HEADING_TURN);
  const dot = dcosOut * ux + dsinOut * uy;
  if (dot < rails.cosHeadingCone[rail]!) return 'cone';

  return null;
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

  // Rail state at this tick's start, the same instant stepTick will use for
  // this same tick (sim.ts's advance calls commands before stepTick).
  const t = command.tick * sim.scenario.dt;
  evaluateEphemeris(sim.bodies, t, sim.scratch.eph);
  const geometry = railGeometry({
    bodies: sim.bodies,
    rails: sim.rails,
    rail: command.rail,
    t,
    eph: sim.scratch.eph,
  });
  dsincos((command.heading * TWO_PI) / HEADING_TURN);
  const dx = dcosOut;
  const dy = dsinOut;
  const speed = command.speed / MM_PER_M;

  const i = sim.objects.count++;
  sim.objects.x[i] = geometry.x;
  sim.objects.y[i] = geometry.y;
  sim.objects.vx[i] = geometry.vx + dx * speed;
  sim.objects.vy[i] = geometry.vy + dy * speed;
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

  sim.railLastLaunchTick[command.rail] = command.tick;
}

function applyBurn(sim: Sim, command: BurnCommand): void {
  requireInt(command.probe, 'probe');
  requireRange(command.probe, 'probe', 0, sim.objects.count - 1);
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

  const pending = sim.pending;
  if (pending.count >= pending.object.length)
    throw new Error(`burn: pending burn queue capacity ${pending.object.length} exceeded`);

  // Insertion-sort into place by atTick, so the queue stays sorted and
  // activateDueBurnNodes (sim.ts) never has to guess an order: ties go after
  // every existing entry with the same atTick, which is exactly log order
  // since commands are applied (and so enqueued) in log order.
  let p = pending.count;
  while (p > 0 && pending.atTick[p - 1]! > command.atTick) {
    pending.object[p] = pending.object[p - 1]!;
    pending.atTick[p] = pending.atTick[p - 1]!;
    pending.prograde[p] = pending.prograde[p - 1]!;
    pending.lateral[p] = pending.lateral[p - 1]!;
    p--;
  }
  pending.object[p] = command.probe;
  pending.atTick[p] = command.atTick;
  pending.prograde[p] = command.prograde;
  pending.lateral[p] = command.lateral;
  pending.count++;
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
