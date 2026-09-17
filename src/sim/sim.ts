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
import { SIM_VERSION } from './version.ts';

// Re-exported so callers building a Scenario only need to import from
// sim.ts, not reach into ephemeris/bodies.ts directly.
export type { BodyDef };

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
  bodies: BodyDef[];
  probe: ProbeDef;
  /** Named random streams to create, e.g. ['debris_ejection']. Order fixes
   *  both creation and serialisation order. */
  streams: string[];
}

/** Dense, explicit-count pending burn nodes: a burn command schedules one of
 *  these rather than arming the burn immediately, because the node may need
 *  to wait for an earlier burn on the same probe to finish (see `advance`).
 *  mm/s, matching the command log's own quantisation. */
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
  objects: DynamicObjects;
  /** Derived from `scenario` alone -- NOT part of hashSim/serializeSim,
   *  rebuilt by deserializeSim (research §8.3). */
  scratch: StepScratch;
  /** One row per `scenario.streams` entry, same order. */
  streams: Uint32Array[];
  pending: PendingBurnNodes;
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
  const bodies = createBodyTable(scenario.bodies);
  return {
    scenario,
    tick: 0,
    seed,
    bodies,
    objects: createDynamicObjects(scenario.capacity),
    scratch: createStepScratch({ bodies, dt: scenario.dt, capacity: scenario.capacity }),
    streams: scenario.streams.map((name) => createStream({ seed, name })),
    // Bounded by object capacity: a burn node is scheduled for exactly one
    // object, so there can never be more useful pending nodes than objects.
    pending: createPendingBurnNodes(scenario.capacity),
  };
}

/** A node due while its probe is already burning waits: only one burn can be
 *  active on an object at a time, and re-arming a burning object would
 *  silently discard its current target, so the node stays pending and is
 *  re-checked every tick until the probe is free (state-driven, therefore
 *  deterministic). Swap-removes activated nodes; iteration order among the
 *  remaining pending nodes never matters because each only ever touches its
 *  own object. */
function activateDueBurnNodes(sim: Sim): void {
  const pending = sim.pending;
  for (let i = 0; i < pending.count; i++) {
    if (pending.atTick[i]! > sim.tick) continue;
    const object = pending.object[i]!;
    if (sim.objects.burning[object]) continue;

    startBurn({
      objects: sim.objects,
      index: object,
      prograde: pending.prograde[i]! / 1000,
      lateral: pending.lateral[i]! / 1000,
    });

    pending.count--;
    pending.object[i] = pending.object[pending.count]!;
    pending.atTick[i] = pending.atTick[pending.count]!;
    pending.prograde[i] = pending.prograde[pending.count]!;
    pending.lateral[i] = pending.lateral[pending.count]!;
    i--;
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
 *  (including hitBody/burning as words), pending nodes, and stream words.
 *  Derived scratch is excluded. */
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

  for (const stream of sim.streams) {
    updateWord(state, stream[0]!);
    updateWord(state, stream[1]!);
    updateWord(state, stream[2]!);
    updateWord(state, stream[3]!);
  }

  return digest(state);
}

const FORMAT_VERSION = 1;
const HEADER_BYTES = 4 + 4; // formatVersion, simVersion
const BODY_HEADER_BYTES = 4 + 4 + 4; // tick, seed, count
// x y vx vy mass dryMass thrust exhaustVelocity burnNx burnNy burnTarget
// burnDelivered (float64) + hitBody + burning (int32, for DataView-uniform
// access -- burning only ever needs 1 byte, but the file has no hot-path
// reason to bit-pack it).
const OBJECT_RECORD_BYTES = 12 * 8 + 4 + 4;
const PENDING_RECORD_BYTES = 4 * 4; // object, atTick, prograde, lateral
const STREAM_RECORD_BYTES = 4 * 4; // four uint32 words

/** `Uint8Array` (binary, doubles as raw bits): a little header (format
 *  version, SIM_VERSION), then tick/seed/count, then the live object
 *  prefix, pending nodes and stream words -- the same fields hashSim reads,
 *  in the same order. No TextEncoder, no platform globals: DataView and
 *  typed arrays only (ADR-0002). `scenario` and `scratch` are not written;
 *  deserializeSim rebuilds them from the scenario it is given (research
 *  §8.3: nothing derived belongs in the state). */
export function serializeSim(sim: Sim): Uint8Array {
  const o = sim.objects;
  const byteLength =
    HEADER_BYTES +
    BODY_HEADER_BYTES +
    o.count * OBJECT_RECORD_BYTES +
    4 +
    sim.pending.count * PENDING_RECORD_BYTES +
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

  const pending = createPendingBurnNodes(scenario.capacity);
  const pendingCount = getI32();
  if (pendingCount < 0 || pendingCount > scenario.capacity)
    throw new Error(`deserializeSim: pending count ${pendingCount} exceeds capacity`);
  pending.count = pendingCount;
  for (let i = 0; i < pendingCount; i++) {
    pending.object[i] = getI32();
    pending.atTick[i] = getI32();
    pending.prograde[i] = getI32();
    pending.lateral[i] = getI32();
  }

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
    objects,
    scratch: createStepScratch({ bodies, dt: scenario.dt, capacity: scenario.capacity }),
    streams,
    pending,
  };
}

export type { Command } from './commands.ts';
export type { EphemerisOut };
