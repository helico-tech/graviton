// Command log records (docs/domain/simulation-determinism.md rule 6,
// ADR-0005 "Command log"): quantised integers only, so the log is
// independent of any UI floating-point path and replay is exact by
// construction. `applyCommand` is the only way a command touches `Sim`
// state; `advance` (sim.ts) is the only caller.

import { dcosOut, dsincos, dsinOut } from './math/kernels.ts';
import { evaluateEphemeris } from './ephemeris/bodies.ts';
import type { Sim } from './sim.ts';

/** 1/65536 of a turn, so the full range is < 2*pi and stays inside dsincos's
 *  contractual domain (research §2.2) with no reduction needed. */
export const HEADING_TURN = 65536;
const TWO_PI = 6.283185307179586;
const MM_PER_M = 1000;
/** How far above a body's surface a launched probe starts, m -- placeholder
 *  clearance until launch rails exist (GAME-0001 §4.2). */
const LAUNCH_CLEARANCE_M = 1000;

export interface LaunchCommand {
  tick: number;
  kind: 'launch';
  /** Body index to launch from. */
  body: number;
  /** 0..65535, 1/65536 of a turn. */
  heading: number;
  /** mm/s, relative to the launch body. */
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

function applyLaunch(sim: Sim, command: LaunchCommand): void {
  requireInt(command.body, 'body');
  requireRange(command.body, 'body', 0, sim.bodies.count - 1);
  requireInt(command.heading, 'heading');
  requireRange(command.heading, 'heading', 0, HEADING_TURN - 1);
  requireInt(command.speed, 'speed');
  requireRange(command.speed, 'speed', 0, Number.MAX_SAFE_INTEGER);
  if (sim.objects.count >= sim.scenario.capacity)
    throw new Error(`launch: object capacity ${sim.scenario.capacity} exceeded`);

  // Body state at this tick's start, the same instant stepTick will use for
  // this same tick (sim.ts's advance calls commands before stepTick).
  evaluateEphemeris(sim.bodies, sim.tick * sim.scenario.dt, sim.scratch.eph);
  dsincos((command.heading * TWO_PI) / HEADING_TURN);
  const nx = dcosOut;
  const ny = dsinOut;
  const speed = command.speed / MM_PER_M;
  const offset = sim.bodies.radius[command.body]! + LAUNCH_CLEARANCE_M;

  // Radial launch from the host body's surface: a placeholder geometry until
  // launch rails exist (GAME-0001 §4.2) -- position and velocity share the
  // same direction because there is no rail to set them independently.
  const i = sim.objects.count++;
  sim.objects.x[i] = sim.scratch.eph.x[command.body]! + nx * offset;
  sim.objects.y[i] = sim.scratch.eph.y[command.body]! + ny * offset;
  sim.objects.vx[i] = sim.scratch.eph.vx[command.body]! + nx * speed;
  sim.objects.vy[i] = sim.scratch.eph.vy[command.body]! + ny * speed;
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
