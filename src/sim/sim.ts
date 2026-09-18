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
import { applyCommand, materializeArrival } from './commands.ts';
import type { Command } from './commands.ts';
import { createRailTable, NEVER_LAUNCHED } from './rails.ts';
import type { RailDef, RailTable } from './rails.ts';
import { createContactState, createContactTable } from './contacts.ts';
import type { ContactState, ContactTable, FixedContactDef } from './contacts.ts';
import { createHistoryBuffer, HISTORY_RECORD_BYTES, recordHistory } from './history.ts';
import type { HistoryBuffer } from './history.ts';
import type { PostDef } from './post.ts';
import { createPendingArrivals, removePendingArrival } from './arrivals.ts';
import type { PendingArrivals } from './arrivals.ts';
import { SIM_VERSION } from './version.ts';

// Re-exported so callers building a Scenario only need to import from
// sim.ts, not reach into ephemeris/bodies.ts, rails.ts, contacts.ts or
// post.ts directly.
export type { BodyDef, RailDef, FixedContactDef, PostDef };

// docs/work/GRV-0029: a sanity ceiling on Scenario.historyTicks, mirroring MAX_SCENARIO_ALLOCATION
// below -- a malformed level (or a compiler bug in the ceil(2*maxSeparation/c/dt) bound,
// levels/compile.ts) should fail loudly at load, never allocate gigabytes of ring buffer.
const MAX_HISTORY_TICKS = 65536;

// A level-load sanity limit against typos (docs/issues/2026-09-18-probe-count-unbounded.md):
// `count: 1000000000` should fail loudly here, not allocate gigabytes. Debris caps later come
// with their own budget, not this one.
const MAX_SCENARIO_ALLOCATION = 4096;
const TWO_PI = 6.283185307179586;

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
  contacts: FixedContactDef[];
  /** The clearance post: a surface point like a rail (post.ts). Orders and telemetry are solved
   *  against it (ADR-0007 §1). */
  post: PostDef;
  /** Ticks of per-object position/velocity history retained (history.ts's ring buffer), sized by
   *  the compiler from the level's largest possible body separation:
   *  `ceil(2 * maxSeparation / c / dt) + 16`, where `maxSeparation` is twice the largest apoapsis
   *  distance from the system primary (the worst case, two bodies each at apoapsis on opposite
   *  sides) -- enough ticks to cover a full light round trip across the whole system, plus margin
   *  (levels/compile.ts). Must be >= 2 (cubic Hermite needs two bracketing samples). */
  historyTicks: number;
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
  /** Derived from `scenario.contacts` alone -- NOT part of hashSim/
   *  serializeSim (mirrors `bodies`/`rails`); `contactState` below is the
   *  mutable state (GRV-0015). */
  contacts: ContactTable;
  contactState: ContactState;
  objects: DynamicObjects;
  /** Derived from `scenario` alone -- NOT part of hashSim/serializeSim,
   *  rebuilt by deserializeSim (research §8.3). */
  scratch: StepScratch;
  /** One row per `scenario.streams` entry, same order. */
  streams: Uint32Array[];
  pending: PendingBurnNodes;
  /** Every issued-but-not-yet-arrived command (ADR-0007 §2, arrivals.ts's own module header, GRV-
   *  0029). `advance` applies whatever is due each tick before `activateDueBurnNodes`. */
  pendingArrivals: PendingArrivals;
  /** Per-object position/velocity ring buffer (history.ts, ADR-0007 §7): written at the end of
   *  every tick for every live object. State: hashed and serialised. */
  history: HistoryBuffer;
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
  if (
    !Number.isInteger(scenario.capacity) ||
    scenario.capacity <= 0 ||
    scenario.capacity > MAX_SCENARIO_ALLOCATION
  )
    throw new Error(
      `validateScenario: capacity must be an integer in (0, ${MAX_SCENARIO_ALLOCATION}] (${scenario.capacity})`,
    );
  if (
    !Number.isInteger(scenario.burnNodeCapacity) ||
    scenario.burnNodeCapacity < 0 ||
    scenario.burnNodeCapacity > MAX_SCENARIO_ALLOCATION
  )
    throw new Error(
      `validateScenario: burnNodeCapacity must be an integer in [0, ${MAX_SCENARIO_ALLOCATION}] (${scenario.burnNodeCapacity})`,
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

  if (
    !Number.isInteger(scenario.post.host) ||
    scenario.post.host < 0 ||
    scenario.post.host >= scenario.bodies.length
  )
    throw new Error(`validateScenario: post has out-of-range host (${scenario.post.host})`);
  if (!Number.isFinite(scenario.post.longitude) || Math.abs(scenario.post.longitude) > TWO_PI)
    throw new Error(
      `validateScenario: post has longitude (${scenario.post.longitude}) outside [-2pi, 2pi]`,
    );

  if (
    !Number.isInteger(scenario.historyTicks) ||
    scenario.historyTicks < 2 ||
    scenario.historyTicks > MAX_HISTORY_TICKS
  )
    throw new Error(
      `validateScenario: historyTicks must be an integer in [2, ${MAX_HISTORY_TICKS}] (${scenario.historyTicks})`,
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
  const contacts = createContactTable(scenario.contacts, bodies);
  return {
    scenario,
    tick: 0,
    seed,
    bodies,
    rails,
    contacts,
    contactState: createContactState(contacts.count),
    objects: createDynamicObjects(scenario.capacity),
    scratch: createStepScratch({ bodies, contacts, dt: scenario.dt, capacity: scenario.capacity }),
    streams: scenario.streams.map((name) => createStream({ seed, name })),
    pending: createPendingBurnNodes(scenario.burnNodeCapacity),
    pendingArrivals: createPendingArrivals(scenario.capacity + scenario.burnNodeCapacity),
    history: createHistoryBuffer({
      objectCapacity: scenario.capacity,
      historyTicks: scenario.historyTicks,
    }),
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
 *  either, so the scan stops there. A due node whose probe is already
 *  expended (hit a body, or hit/cleared a fixed contact -- GRV-0015) is
 *  dropped rather than waited on: an expended probe never becomes free
 *  (see the comment inside), so waiting would stall every node behind it. */
function activateDueBurnNodes(sim: Sim): void {
  const pending = sim.pending;
  let i = 0;
  while (i < pending.count) {
    if (pending.atTick[i]! > sim.tick) break;
    const object = pending.object[i]!;
    // An expended probe is frozen (every kick skips it, research §3.4):
    // arming it would leave `burning` set forever and stall any node still
    // behind it in the queue. Drop the node instead -- removePendingNode's
    // stable shift keeps this deterministic and leaves other probes' nodes
    // alone.
    if (sim.objects.hitBody[object] !== -1 || sim.objects.hitContact[object] !== -1) {
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

/** Materialises every command whose light-cone arrival is due this tick, in queue order (arrival,
 *  then issue -- `PendingArrivals`' own sort, arrivals.ts), before `activateDueBurnNodes`/
 *  `stepTick`: a launch due this tick must exist before a same-tick burn bundled with it can be
 *  armed against it, and before the ladder groups this tick's live objects (ADR-0007 §2, §6). */
function applyDueArrivals(sim: Sim): void {
  const pending = sim.pendingArrivals;
  const i = 0;
  while (i < pending.count && pending.arrivalTick[i]! <= sim.tick) {
    materializeArrival({ sim, pending, index: i });
    removePendingArrival(pending, i);
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
 *  order (a command whose light-cone arrival is later than its issue tick queues itself,
 *  commands.ts), materialise whatever command arrival is due this tick (`applyDueArrivals`),
 *  activate due burn nodes, step, record every live object's history (history.ts), then advance
 *  the clock. */
export function advance({ sim, log, ticks }: AdvanceArgs): void {
  validateLogSorted(log);
  let cursor = findLogStart(log, sim.tick);
  for (let step = 0; step < ticks; step++) {
    const countBeforeArrivals = sim.objects.count;
    while (cursor < log.length && log[cursor]!.tick === sim.tick) {
      applyCommand({ sim, command: log[cursor]! });
      cursor++;
    }
    applyDueArrivals(sim);

    // A launch materialised just now (immediately, or from a queued arrival) has no earlier
    // iteration that could have recorded its history at this tick -- record its creation state
    // here, before stepTick moves it, so history.ts's firstWriteTick really is the launch tick.
    for (let i = countBeforeArrivals; i < sim.objects.count; i++) {
      recordHistory({
        history: sim.history,
        object: i,
        tick: sim.tick,
        x: sim.objects.x[i]!,
        y: sim.objects.y[i]!,
        vx: sim.objects.vx[i]!,
        vy: sim.objects.vy[i]!,
      });
    }

    activateDueBurnNodes(sim);
    stepTick({
      bodies: sim.bodies,
      objects: sim.objects,
      contacts: sim.contacts,
      contactState: sim.contactState,
      tick: sim.tick,
      dt: sim.scenario.dt,
      scratch: sim.scratch,
    });
    sim.tick++;
    // sim.objects now holds the state AT sim.tick (stepTick just integrated it from
    // (sim.tick-1)*dt to sim.tick*dt) -- record it under that same tick, the live-state
    // invariant lightcone.ts's own object-target solve relies on for issueTick === sim.tick.
    for (let i = 0; i < sim.objects.count; i++) {
      recordHistory({
        history: sim.history,
        object: i,
        tick: sim.tick,
        x: sim.objects.x[i]!,
        y: sim.objects.y[i]!,
        vx: sim.objects.vx[i]!,
        vy: sim.objects.vy[i]!,
      });
    }
  }
}

/** Hex digest over tick, seed, count, every live object array prefix
 *  (including hitBody/burning as words), pending nodes, pending light-cone arrivals, every live
 *  object's history ring (GRV-0029), rail last-launch ticks, and stream words -- and, per contact
 *  (GRV-0015), cleared/impactTick/impactSpeed/impactEnergy. Derived scratch, bodies, rails and
 *  contacts (the static tables) are excluded. */
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
    updateWord(state, o.hitContact[i]!);
    updateWord(state, o.burning[i]!);
  }

  updateWord(state, sim.pending.count);
  for (let i = 0; i < sim.pending.count; i++) {
    updateWord(state, sim.pending.object[i]!);
    updateWord(state, sim.pending.atTick[i]!);
    updateWord(state, sim.pending.prograde[i]!);
    updateWord(state, sim.pending.lateral[i]!);
  }

  const pa = sim.pendingArrivals;
  updateWord(state, pa.count);
  for (let i = 0; i < pa.count; i++) {
    updateWord(state, pa.arrivalTick[i]!);
    updateWord(state, pa.kind[i]!);
    updateFloat64(state, pa.tick[i]!);
    updateFloat64(state, pa.a[i]!);
    updateFloat64(state, pa.b[i]!);
    updateFloat64(state, pa.c[i]!);
    updateFloat64(state, pa.d[i]!);
  }

  const hist = sim.history;
  for (let i = 0; i < o.count; i++) {
    updateWord(state, hist.firstWriteTick[i]!);
    updateWord(state, hist.lastTick[i]!);
    const base = i * hist.historyTicks;
    for (let s = 0; s < hist.historyTicks; s++) {
      updateFloat64(state, hist.x[base + s]!);
      updateFloat64(state, hist.y[base + s]!);
      updateFloat64(state, hist.vx[base + s]!);
      updateFloat64(state, hist.vy[base + s]!);
    }
  }

  for (let i = 0; i < sim.rails.count; i++) {
    updateWord(state, sim.railLastLaunchTick[i]!);
  }

  const cs = sim.contactState;
  for (let i = 0; i < sim.contacts.count; i++) {
    updateWord(state, cs.cleared[i]!);
    updateWord(state, cs.impactTick[i]!);
    updateFloat64(state, cs.impactSpeed[i]!);
    updateFloat64(state, cs.impactEnergy[i]!);
  }

  for (const stream of sim.streams) {
    updateWord(state, stream[0]!);
    updateWord(state, stream[1]!);
    updateWord(state, stream[2]!);
    updateWord(state, stream[3]!);
  }

  return digest(state);
}

// GRV-0015 adds hitContact to the object record and a contact-state record
// (cleared, impactTick, impactSpeed, impactEnergy per contact) to the
// layout.
// 4 (GRV-0029): the light-cone pending-arrivals queue and every live object's position/velocity
// history ring join the layout (ADR-0007 §7).
const FORMAT_VERSION = 4;
const HEADER_BYTES = 4 + 4; // formatVersion, simVersion
const BODY_HEADER_BYTES = 4 + 4 + 4; // tick, seed, count
// x y vx vy mass dryMass thrust exhaustVelocity burnNx burnNy burnTarget
// burnDelivered (float64) + hitBody + hitContact + burning (int32, for
// DataView-uniform access -- burning only ever needs 1 byte, but the file
// has no hot-path reason to bit-pack it).
const OBJECT_RECORD_BYTES = 12 * 8 + 4 + 4 + 4;
const PENDING_RECORD_BYTES = 4 * 4; // object, atTick, prograde, lateral
// arrivalTick + kind (int32, for DataView-uniform access, mirroring `burning` above) + tick, a, b,
// c, d (float64 -- arrivals.ts's own PendingArrivals doc: a launch's speed field exceeds Int32
// range).
const PENDING_ARRIVAL_RECORD_BYTES = 4 + 4 + 5 * 8;
// firstWriteTick + lastTick (int32) per live object, then historyTicks * (x y vx vy, float64).
const HISTORY_META_BYTES = 4 + 4;
const RAIL_RECORD_BYTES = 4; // lastLaunchTick (int32)
// cleared + impactTick (int32) + impactSpeed + impactEnergy (float64).
const CONTACT_RECORD_BYTES = 4 + 4 + 8 + 8;
const STREAM_RECORD_BYTES = 4 * 4; // four uint32 words

/** `Uint8Array` (binary, doubles as raw bits): a little header (format
 *  version, SIM_VERSION), then tick/seed/count, then the live object
 *  prefix, pending nodes, rail last-launch ticks, contact state and stream
 *  words -- the same fields hashSim reads, in the same order. No
 *  TextEncoder, no platform globals: DataView and typed arrays only
 *  (ADR-0002). `scenario` and `scratch` are not written; deserializeSim
 *  rebuilds them from the scenario it is given (research §8.3: nothing
 *  derived belongs in the state). Rail and contact counts are not stored
 *  either -- like `streams.length`, they are fixed by `scenario.rails`/
 *  `scenario.contacts` and deserializeSim reads exactly that many. */
export function serializeSim(sim: Sim): Uint8Array {
  const o = sim.objects;
  const byteLength =
    HEADER_BYTES +
    BODY_HEADER_BYTES +
    o.count * OBJECT_RECORD_BYTES +
    4 +
    sim.pending.count * PENDING_RECORD_BYTES +
    4 +
    sim.pendingArrivals.count * PENDING_ARRIVAL_RECORD_BYTES +
    o.count * (HISTORY_META_BYTES + sim.history.historyTicks * HISTORY_RECORD_BYTES) +
    sim.rails.count * RAIL_RECORD_BYTES +
    sim.contacts.count * CONTACT_RECORD_BYTES +
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
    putI32(o.hitContact[i]!);
    putI32(o.burning[i]!);
  }

  putI32(sim.pending.count);
  for (let i = 0; i < sim.pending.count; i++) {
    putI32(sim.pending.object[i]!);
    putI32(sim.pending.atTick[i]!);
    putI32(sim.pending.prograde[i]!);
    putI32(sim.pending.lateral[i]!);
  }

  const pa = sim.pendingArrivals;
  putI32(pa.count);
  for (let i = 0; i < pa.count; i++) {
    putI32(pa.arrivalTick[i]!);
    putI32(pa.kind[i]!);
    putF64(pa.tick[i]!);
    putF64(pa.a[i]!);
    putF64(pa.b[i]!);
    putF64(pa.c[i]!);
    putF64(pa.d[i]!);
  }

  const hist = sim.history;
  for (let i = 0; i < o.count; i++) {
    putI32(hist.firstWriteTick[i]!);
    putI32(hist.lastTick[i]!);
    const base = i * hist.historyTicks;
    for (let s = 0; s < hist.historyTicks; s++) {
      putF64(hist.x[base + s]!);
      putF64(hist.y[base + s]!);
      putF64(hist.vx[base + s]!);
      putF64(hist.vy[base + s]!);
    }
  }

  for (let i = 0; i < sim.rails.count; i++) {
    putI32(sim.railLastLaunchTick[i]!);
  }

  const cs = sim.contactState;
  for (let i = 0; i < sim.contacts.count; i++) {
    putI32(cs.cleared[i]!);
    putI32(cs.impactTick[i]!);
    putF64(cs.impactSpeed[i]!);
    putF64(cs.impactEnergy[i]!);
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
  const contacts = createContactTable(scenario.contacts, bodies);
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
    objects.hitContact[i] = getI32();
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

  const pendingArrivals = createPendingArrivals(scenario.capacity + scenario.burnNodeCapacity);
  const pendingArrivalCount = getI32();
  if (pendingArrivalCount < 0 || pendingArrivalCount > pendingArrivals.arrivalTick.length)
    throw new Error(
      `deserializeSim: pending arrival count ${pendingArrivalCount} exceeds capacity ${pendingArrivals.arrivalTick.length}`,
    );
  pendingArrivals.count = pendingArrivalCount;
  for (let i = 0; i < pendingArrivalCount; i++) {
    pendingArrivals.arrivalTick[i] = getI32();
    pendingArrivals.kind[i] = getI32();
    pendingArrivals.tick[i] = getF64();
    pendingArrivals.a[i] = getF64();
    pendingArrivals.b[i] = getF64();
    pendingArrivals.c[i] = getF64();
    pendingArrivals.d[i] = getF64();
  }

  const history = createHistoryBuffer({
    objectCapacity: scenario.capacity,
    historyTicks: scenario.historyTicks,
  });
  for (let i = 0; i < count; i++) {
    history.firstWriteTick[i] = getI32();
    history.lastTick[i] = getI32();
    const base = i * history.historyTicks;
    for (let s = 0; s < history.historyTicks; s++) {
      history.x[base + s] = getF64();
      history.y[base + s] = getF64();
      history.vx[base + s] = getF64();
      history.vy[base + s] = getF64();
    }
  }

  const railLastLaunchTick = new Int32Array(rails.count);
  for (let i = 0; i < rails.count; i++) railLastLaunchTick[i] = getI32();

  const contactState = createContactState(contacts.count);
  for (let i = 0; i < contacts.count; i++) {
    contactState.cleared[i] = getI32();
    contactState.impactTick[i] = getI32();
    contactState.impactSpeed[i] = getF64();
    contactState.impactEnergy[i] = getF64();
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
    rails,
    contacts,
    contactState,
    objects,
    scratch: createStepScratch({ bodies, contacts, dt: scenario.dt, capacity: scenario.capacity }),
    streams,
    pending,
    pendingArrivals,
    history,
    railLastLaunchTick,
  };
}

export type { BurnRejection, Command, LaunchRejection } from './commands.ts';
export { checkBurn, checkLaunch } from './commands.ts';
export type { EphemerisOut };
