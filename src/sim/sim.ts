// The simulation as plain data plus functions (docs/work/GRV-0008): a
// `Scenario` (level definition) plus a seed plus an ordered command log is
// everything a run needs (docs/domain/simulation-determinism.md rule 8).
// `Sim` is the mutable state that `advance` steps forward; `hashSim` and
// `serializeSim`/`deserializeSim` are the state's two required views.

import type { BodyDef, BodyTable, EphemerisOut } from './ephemeris/bodies.ts';
import { createBodyTable } from './ephemeris/bodies.ts';
import { createDynamicObjects, createStepScratch, stepTick } from './dynamics/step.ts';
import type { DynamicObjects, StepScratch } from './dynamics/step.ts';
import { startBurn } from './dynamics/burn.ts';
import { createStream } from './state/rng.ts';
import { createHash, digest, updateFloat64, updateWord } from './state/hash.ts';
import { selfCheck } from './selfcheck.ts';
import { applyCommand } from './commands.ts';
import type { Command } from './commands.ts';
import { createRailTable, NEVER_LAUNCHED } from './rails.ts';
import type { RailDef, RailTable } from './rails.ts';
import { SIM_VERSION } from './version.ts';

// Re-exported so callers building a Scenario only need to import from
// sim.ts, not reach into ephemeris/bodies.ts or rails.ts directly.
export type { BodyDef, RailDef };

export interface ProbeDef {
  dryMass: number;
  propellantMass: number;
  exhaustVelocity: number;
  thrust: number;
}

export interface Scenario {
  /** Seconds; constant for the whole run (determinism rule 2). */
  dt: number;
  /** Maximum simultaneous dynamic objects. */
  capacity: number;
  /** Maximum simultaneous pending (not-yet-armed) burn nodes, independent of
   *  `capacity`: a flight plan carries several nodes per probe (GAME-0001
   *  §4.4), so the queue is sized on its own rather than bounded by object
   *  count. */
  burnNodeCapacity: number;
  bodies: BodyDef[];
  rails: RailDef[];
  probe: ProbeDef;
  /** Named random streams to create, e.g. ['debris_ejection']. Order fixes
   *  both creation and serialisation order. */
  streams: string[];
}

/** Dense, explicit-count pending burn nodes, kept sorted by `atTick` (ties
 *  broken by insertion order): a burn command schedules one of these rather
 *  than arming the burn immediately, because the node may need to wait for
 *  an earlier burn on the same probe to finish (see `advance`). Enqueueing
 *  (commands.ts's `applyBurn`) inserts in sorted position; activating
 *  (`activateDueBurnNodes` below) removes with a stable shift, so among
 *  several due nodes waiting on the same probe the earliest `atTick` always
 *  fires first, ties by log order -- never by removal history. mm/s,
 *  matching the command log's own quantisation. */
export interface PendingBurnNodes {
  object: Int32Array;
  atTick: Int32Array;
  prograde: Int32Array;
  lateral: Int32Array;
  count: number;
}

export interface Sim {
  scenario: Scenario;
  /** The only clock (determinism rule 1). */
  tick: number;
  seed: number;
  bodies: BodyTable;
  /** Derived from `scenario.rails` alone -- NOT part of hashSim/serializeSim
   *  (mirrors `bodies`); `railLastLaunchTick` below is the mutable state. */
  rails: RailTable;
  objects: DynamicObjects;
  /** Derived from `scenario` alone -- NOT part of hashSim/serializeSim,
   *  rebuilt by deserializeSim (research §8.3). */
  scratch: StepScratch;
  /** One row per `scenario.streams` entry, same order. */
  streams: Uint32Array[];
  pending: PendingBurnNodes;
  /** Tick of each rail's last launch, NEVER_LAUNCHED (-1) until it has
   *  fired (docs/work/GRV-0014). One entry per `scenario.rails`, same
   *  order. Mutable Sim state: hashed and serialised. */
  railLastLaunchTick: Int32Array;
}

/** Mirrors createBodyTable's validation style (body validation itself stays
 *  there): a malformed scenario must fail here, at load, never silently
 *  mid-run (docs/issues/2026-09-17-scenario-probe-and-body-radius-
 *  unvalidated.md) -- thrust: 0 arms a burn that never ends, exhaustVelocity:
 *  0 makes mdot infinite and dumps the whole tank in one kick. */
function validateScenario(scenario: Scenario): void {
  if (!Number.isFinite(scenario.dt) || scenario.dt <= 0)
    throw new Error(`validateScenario: non-positive or non-finite dt (${scenario.dt})`);
  if (!Number.isInteger(scenario.capacity) || scenario.capacity <= 0)
    throw new Error(
      `validateScenario: non-integer or non-positive capacity (${scenario.capacity})`,
    );
  if (!Number.isInteger(scenario.burnNodeCapacity) || scenario.burnNodeCapacity < 0)
    throw new Error(
      `validateScenario: non-integer or negative burnNodeCapacity (${scenario.burnNodeCapacity})`,
    );

  const probe = scenario.probe;
  if (!Number.isFinite(probe.dryMass) || probe.dryMass <= 0)
    throw new Error(
      `validateScenario: probe has non-positive or non-finite dryMass (${probe.dryMass})`,
    );
  if (!Number.isFinite(probe.propellantMass) || probe.propellantMass < 0)
    throw new Error(
      `validateScenario: probe has negative or non-finite propellantMass (${probe.propellantMass})`,
    );
  if (!Number.isFinite(probe.thrust) || probe.thrust <= 0)
    throw new Error(
      `validateScenario: probe has non-positive or non-finite thrust (${probe.thrust})`,
    );
  if (!Number.isFinite(probe.exhaustVelocity) || probe.exhaustVelocity <= 0)
    throw new Error(
      `validateScenario: probe has non-positive or non-finite exhaustVelocity (${probe.exhaustVelocity})`,
    );
}

function createPendingBurnNodes(capacity: number): PendingBurnNodes {
  return {
    object: new Int32Array(capacity),
    atTick: new Int32Array(capacity),
    prograde: new Int32Array(capacity),
    lateral: new Int32Array(capacity),
    count: 0,
  };
}

export function createSim({ scenario, seed }: { scenario: Scenario; seed: number }): Sim {
  selfCheck();
  validateScenario(scenario);
  const bodies = createBodyTable(scenario.bodies);
  const rails = createRailTable(scenario.rails, bodies);
  return {
    scenario,
    tick: 0,
    seed,
    bodies,
    rails,
    objects: createDynamicObjects(scenario.capacity),
    scratch: createStepScratch({ bodies, dt: scenario.dt, capacity: scenario.capacity }),
    streams: scenario.streams.map((name) => createStream({ seed, name })),
    pending: createPendingBurnNodes(scenario.burnNodeCapacity),
    railLastLaunchTick: new Int32Array(rails.count).fill(NEVER_LAUNCHED),
  };
}

/** Removes the pending node at `index` with a stable shift (every later
 *  entry moves down by one), not a swap-with-last: that's what keeps the
 *  queue's remaining entries sorted by `atTick` after a removal. */
function removePendingNode(pending: PendingBurnNodes, index: number): void {
  pending.count--;
  for (let j = index; j < pending.count; j++) {
    pending.object[j] = pending.object[j + 1]!;
    pending.atTick[j] = pending.atTick[j + 1]!;
    pending.prograde[j] = pending.prograde[j + 1]!;
    pending.lateral[j] = pending.lateral[j + 1]!;
  }
}

/** A node due while its probe is already burning waits: only one burn can be
 *  active on an object at a time, and re-arming a burning object would
 *  silently discard its current target, so the node stays pending and is
 *  re-checked every tick until the probe is free (state-driven, therefore
 *  deterministic). The queue is sorted by `atTick` (ties by insertion order,
 *  see `PendingBurnNodes`), so among several nodes due on the same free
 *  probe the earliest `atTick` always fires first; skipped (still-waiting)
 *  nodes are left in place, never reordered, so a later node can never fire
 *  ahead of an earlier one it happened to be checked after. Once a node's
 *  `atTick` is in the future nothing further in the (sorted) queue is due
 *  either, so the scan stops there. A due node whose probe has already hit
 *  a body is dropped rather than waited on: a hit probe never becomes free
 *  (see the comment inside), so waiting would stall every node behind it. */
function activateDueBurnNodes(sim: Sim): void {
  const pending = sim.pending;
  let i = 0;
  while (i < pending.count) {
    if (pending.atTick[i]! > sim.tick) break;
    const object = pending.object[i]!;
    // A hit probe is frozen (every kick skips it, research §3.4): arming it
    // would leave `burning` set forever and stall any node still behind it
    // in the queue. Drop the node instead -- removePendingNode's stable
    // shift keeps this deterministic and leaves other probes' nodes alone.
    if (sim.objects.hitBody[object] !== -1) {
      removePendingNode(pending, i);
      continue;
    }
    if (sim.objects.burning[object]) {
      i++;
      continue;
    }

    startBurn({
      objects: sim.objects,
      index: object,
      prograde: pending.prograde[i]! / 1000,
      lateral: pending.lateral[i]! / 1000,
    });
    removePendingNode(pending, i); // the node now at i is the next candidate
  }
}

function validateLogSorted(log: readonly Command[]): void {
  for (let i = 1; i < log.length; i++) {
    if (log[i]!.tick < log[i - 1]!.tick)
      throw new Error(`command log not sorted by tick at index ${i}`);
  }
}

/** First index with log[index].tick >= fromTick, by binary search (log is
 *  sorted). Lets `advance` walk the log with a local cursor instead of
 *  rescanning it from zero every tick. */
function findLogStart(log: readonly Command[], fromTick: number): number {
  let lo = 0;
  let hi = log.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (log[mid]!.tick < fromTick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface AdvanceArgs {
  sim: Sim;
  log: readonly Command[];
  ticks: number;
}

/** Advances `sim` by `ticks` ticks. Warp is just a bigger `ticks` -- `dt`
 *  never changes (determinism rule 3). Each tick: apply due commands in log
 *  order, activate due burn nodes, step, then advance the clock. */
export function advance({ sim, log, ticks }: AdvanceArgs): void {
  validateLogSorted(log);
  let cursor = findLogStart(log, sim.tick);
  for (let step = 0; step < ticks; step++) {
    while (cursor < log.length && log[cursor]!.tick === sim.tick) {
      applyCommand({ sim, command: log[cursor]! });
      cursor++;
    }
    activateDueBurnNodes(sim);
    stepTick({
      bodies: sim.bodies,
      objects: sim.objects,
      tick: sim.tick,
      dt: sim.scenario.dt,
      scratch: sim.scratch,
    });
    sim.tick++;
  }
}

/** Hex digest over tick, seed, count, every live object array prefix
 *  (including hitBody/burning as words), pending nodes, rail last-launch
 *  ticks, and stream words. Derived scratch, bodies and rails (the static
 *  tables) are excluded. */
export function hashSim(sim: Sim): string {
  const state = createHash();
  updateWord(state, sim.tick);
  updateWord(state, sim.seed);
  updateWord(state, sim.objects.count);

  const o = sim.objects;
  for (let i = 0; i < o.count; i++) {
    updateFloat64(state, o.x[i]!);
    updateFloat64(state, o.y[i]!);
    updateFloat64(state, o.vx[i]!);
    updateFloat64(state, o.vy[i]!);
    updateFloat64(state, o.mass[i]!);
    updateFloat64(state, o.dryMass[i]!);
    updateFloat64(state, o.thrust[i]!);
    updateFloat64(state, o.exhaustVelocity[i]!);
    updateFloat64(state, o.burnNx[i]!);
    updateFloat64(state, o.burnNy[i]!);
    updateFloat64(state, o.burnTarget[i]!);
    updateFloat64(state, o.burnDelivered[i]!);
    updateWord(state, o.hitBody[i]!);
    updateWord(state, o.burning[i]!);
  }

  updateWord(state, sim.pending.count);
  for (let i = 0; i < sim.pending.count; i++) {
    updateWord(state, sim.pending.object[i]!);
    updateWord(state, sim.pending.atTick[i]!);
    updateWord(state, sim.pending.prograde[i]!);
    updateWord(state, sim.pending.lateral[i]!);
  }

  for (let i = 0; i < sim.rails.count; i++) {
    updateWord(state, sim.railLastLaunchTick[i]!);
  }

  for (const stream of sim.streams) {
    updateWord(state, stream[0]!);
    updateWord(state, stream[1]!);
    updateWord(state, stream[2]!);
    updateWord(state, stream[3]!);
  }

  return digest(state);
}

// GRV-0014 adds a rail-state record (railLastLaunchTick) to the layout.
const FORMAT_VERSION = 2;
const HEADER_BYTES = 4 + 4; // formatVersion, simVersion
const BODY_HEADER_BYTES = 4 + 4 + 4; // tick, seed, count
// x y vx vy mass dryMass thrust exhaustVelocity burnNx burnNy burnTarget
// burnDelivered (float64) + hitBody + burning (int32, for DataView-uniform
// access -- burning only ever needs 1 byte, but the file has no hot-path
// reason to bit-pack it).
const OBJECT_RECORD_BYTES = 12 * 8 + 4 + 4;
const PENDING_RECORD_BYTES = 4 * 4; // object, atTick, prograde, lateral
const RAIL_RECORD_BYTES = 4; // lastLaunchTick (int32)
const STREAM_RECORD_BYTES = 4 * 4; // four uint32 words

/** `Uint8Array` (binary, doubles as raw bits): a little header (format
 *  version, SIM_VERSION), then tick/seed/count, then the live object
 *  prefix, pending nodes, rail last-launch ticks and stream words -- the
 *  same fields hashSim reads, in the same order. No TextEncoder, no
 *  platform globals: DataView and typed arrays only (ADR-0002). `scenario`
 *  and `scratch` are not written; deserializeSim rebuilds them from the
 *  scenario it is given (research §8.3: nothing derived belongs in the
 *  state). Rail count is not stored either -- like `streams.length`, it is
 *  fixed by `scenario.rails` and deserializeSim reads exactly that many. */
export function serializeSim(sim: Sim): Uint8Array {
  const o = sim.objects;
  const byteLength =
    HEADER_BYTES +
    BODY_HEADER_BYTES +
    o.count * OBJECT_RECORD_BYTES +
    4 +
    sim.pending.count * PENDING_RECORD_BYTES +
    sim.rails.count * RAIL_RECORD_BYTES +
    sim.streams.length * STREAM_RECORD_BYTES;

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  let off = 0;
  const putU32 = (v: number) => {
    view.setUint32(off, v >>> 0, true);
    off += 4;
  };
  const putI32 = (v: number) => {
    view.setInt32(off, v, true);
    off += 4;
  };
  const putF64 = (v: number) => {
    view.setFloat64(off, v, true);
    off += 8;
  };

  putU32(FORMAT_VERSION);
  putU32(SIM_VERSION);
  putI32(sim.tick);
  putU32(sim.seed);
  putI32(o.count);

  for (let i = 0; i < o.count; i++) {
    putF64(o.x[i]!);
    putF64(o.y[i]!);
    putF64(o.vx[i]!);
    putF64(o.vy[i]!);
    putF64(o.mass[i]!);
    putF64(o.dryMass[i]!);
    putF64(o.thrust[i]!);
    putF64(o.exhaustVelocity[i]!);
    putF64(o.burnNx[i]!);
    putF64(o.burnNy[i]!);
    putF64(o.burnTarget[i]!);
    putF64(o.burnDelivered[i]!);
    putI32(o.hitBody[i]!);
    putI32(o.burning[i]!);
  }

  putI32(sim.pending.count);
  for (let i = 0; i < sim.pending.count; i++) {
    putI32(sim.pending.object[i]!);
    putI32(sim.pending.atTick[i]!);
    putI32(sim.pending.prograde[i]!);
    putI32(sim.pending.lateral[i]!);
  }

  for (let i = 0; i < sim.rails.count; i++) {
    putI32(sim.railLastLaunchTick[i]!);
  }

  for (const stream of sim.streams) {
    putU32(stream[0]!);
    putU32(stream[1]!);
    putU32(stream[2]!);
    putU32(stream[3]!);
  }

  return new Uint8Array(buffer);
}

export function deserializeSim({
  scenario,
  bytes,
}: {
  scenario: Scenario;
  bytes: Uint8Array;
}): Sim {
  selfCheck();
  validateScenario(scenario);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const getU32 = () => {
    const v = view.getUint32(off, true);
    off += 4;
    return v;
  };
  const getI32 = () => {
    const v = view.getInt32(off, true);
    off += 4;
    return v;
  };
  const getF64 = () => {
    const v = view.getFloat64(off, true);
    off += 8;
    return v;
  };

  const formatVersion = getU32();
  const simVersion = getU32();
  if (formatVersion !== FORMAT_VERSION)
    throw new Error(`deserializeSim: format version ${formatVersion}, expected ${FORMAT_VERSION}`);
  if (simVersion !== SIM_VERSION)
    throw new Error(`deserializeSim: sim version ${simVersion}, expected ${SIM_VERSION}`);

  const tick = getI32();
  const seed = getU32();
  const count = getI32();
  if (count < 0 || count > scenario.capacity)
    throw new Error(`deserializeSim: object count ${count} exceeds capacity ${scenario.capacity}`);

  const bodies = createBodyTable(scenario.bodies);
  const rails = createRailTable(scenario.rails, bodies);
  const objects = createDynamicObjects(scenario.capacity);
  objects.count = count;
  for (let i = 0; i < count; i++) {
    objects.x[i] = getF64();
    objects.y[i] = getF64();
    objects.vx[i] = getF64();
    objects.vy[i] = getF64();
    objects.mass[i] = getF64();
    objects.dryMass[i] = getF64();
    objects.thrust[i] = getF64();
    objects.exhaustVelocity[i] = getF64();
    objects.burnNx[i] = getF64();
    objects.burnNy[i] = getF64();
    objects.burnTarget[i] = getF64();
    objects.burnDelivered[i] = getF64();
    objects.hitBody[i] = getI32();
    objects.burning[i] = getI32();
  }

  const pending = createPendingBurnNodes(scenario.burnNodeCapacity);
  const pendingCount = getI32();
  if (pendingCount < 0 || pendingCount > scenario.burnNodeCapacity)
    throw new Error(
      `deserializeSim: pending count ${pendingCount} exceeds burn node capacity ${scenario.burnNodeCapacity}`,
    );
  pending.count = pendingCount;
  for (let i = 0; i < pendingCount; i++) {
    pending.object[i] = getI32();
    pending.atTick[i] = getI32();
    pending.prograde[i] = getI32();
    pending.lateral[i] = getI32();
  }

  const railLastLaunchTick = new Int32Array(rails.count);
  for (let i = 0; i < rails.count; i++) railLastLaunchTick[i] = getI32();

  const streams: Uint32Array[] = [];
  for (let s = 0; s < scenario.streams.length; s++) {
    const stream = new Uint32Array(4);
    stream[0] = getU32();
    stream[1] = getU32();
    stream[2] = getU32();
    stream[3] = getU32();
    streams.push(stream);
  }

  return {
    scenario,
    tick,
    seed,
    bodies,
    rails,
    objects,
    scratch: createStepScratch({ bodies, dt: scenario.dt, capacity: scenario.capacity }),
    streams,
    pending,
    railLastLaunchTick,
  };
}

export type { Command, LaunchRejection } from './commands.ts';
export { checkLaunch } from './commands.ts';
export type { EphemerisOut };
