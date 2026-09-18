// Ghost integration (GAME-0001 §4.4-4.6, §7 must-have 3; docs/domain/simulation-determinism.md
// "Ghost invariant"; ADR-0005 "Consequences" -- "the planner re-integrates one ghost and caches
// from the earliest edited node"): the plotted trajectory IS what will happen because it is
// produced by the live simulation's own `createSim`/`advance`, never a separate model. The world
// at `fromTick` is reproduced by replaying the level's already-committed log; the plan is then
// applied on top and integrated to `horizonTick`, sampling the ghost probe's x/y/vx/vy/mass/
// burning per tick plus the events it meets along the way (launch, each node's start/end, closest
// approach per contact, impact, a body hit).
//
// Issuance timing: `planToCommands` (plan.ts) issues every burn command at the plan's launch tick,
// because that is when a probe's onboard computer is actually loaded (GAME-0001 §4.4) -- the
// commit path (appending to the permanent log) always uses it. This module's own *internal*
// trial log instead issues each node's burn command at its own `atTick` ("lazy" issuance). The two
// are physically equivalent: `activateDueBurnNodes` (sim.ts) only ever cares whether a pending
// node's `atTick` has arrived and the probe is free, never how long the node sat in the queue
// first, so the resulting x/y/vx/vy/mass/burning trajectory is bit-identical either way (proven by
// the ghost invariant test below, which compares against a live sim advanced with the *committed*
// (all-at-launch) commands). Lazy issuance is what makes the cache possible: with all-at-launch
// issuance every node is already committed to the sim's pending queue on the very first tick, so a
// checkpoint taken mid-flight cannot cleanly swap out an edited downstream node -- with lazy
// issuance, nothing beyond an unfired node exists in the sim yet, so resuming from a checkpoint and
// issuing a fresh (possibly edited) command for it is exactly what a fresh command log entry does.
import { advance, createSim, deserializeSim, serializeSim } from '../sim/sim.ts';
import type { Command, Sim } from '../sim/sim.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { contactPoint } from '../sim/contacts.ts';
import { sweptSegmentDistance } from '../levels/solve.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import type { BurnNode, FlightPlan } from './plan.ts';

export interface GhostSamples {
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  mass: Float64Array;
  burning: Uint8Array;
  /** Ticks actually written, index 0 = `fromTick` (<= every array's own length; less than the full
   *  span when integration stopped early on an impact or a body hit). */
  count: number;
}

export type GhostEvent =
  | { kind: 'launch'; tick: number }
  | { kind: 'nodeStart'; tick: number; node: number }
  | { kind: 'nodeEnd'; tick: number; node: number }
  | { kind: 'closestApproach'; tick: number; contact: number; distance: number }
  | { kind: 'impact'; tick: number; contact: number }
  | { kind: 'bodyHit'; tick: number; body: number };

export interface GhostContactOutcome {
  cleared: boolean;
  /** contacts.ts's NO_IMPACT (-1) if the ghost never hit this contact. */
  impactTick: number;
  impactSpeed: number;
  impactEnergy: number;
}

export interface Ghost {
  fromTick: number;
  horizonTick: number;
  /** The dynamic-object index the ghost probe occupies in its own (isolated-from-the-caller,
   *  never touching the live game `Sim`) integration. */
  probeIndex: number;
  samples: GhostSamples;
  events: GhostEvent[];
  /** One entry per `level.contactIds`, the ghost's own final contact state. */
  contacts: GhostContactOutcome[];
  /** Ticks this specific `integrateGhost` call advanced the simulation by -- 0 when the cache hit
   *  needed no work, far less than the full span when it resumed from a node's checkpoint. */
  ticksIntegrated: number;
}

interface ContactBest {
  distance: number;
  tick: number;
}

/** Enough to resume node `k`'s own integration without re-running nodes before it (ADR-0005
 *  "Consequences"): the serialised sim right before node `k`'s command would be applied, plus the
 *  event-pairing cursor and the per-contact running closest-approach state at that instant -- both
 *  of those are ongoing accumulators that a plain `deserializeSim` cannot reconstruct on its own. */
interface Checkpoint {
  tick: number;
  probeIndex: number;
  nodeCursor: number;
  bytes: Uint8Array;
  contactBest: ContactBest[];
}

export interface GhostCache {
  level: CompiledLevel;
  log: readonly Command[];
  fromTick: number;
  horizonTick: number;
  plan: FlightPlan;
  /** `checkpoints[i]` = state right before `plan.nodes[i]`'s command applies; shorter than
   *  `plan.nodes.length` when integration stopped early before reaching every node. */
  checkpoints: Checkpoint[];
  ghost: Ghost;
}

type MutableSamples = Omit<GhostSamples, 'count'>;

function createSamples(length: number): MutableSamples {
  return {
    x: new Float64Array(length),
    y: new Float64Array(length),
    vx: new Float64Array(length),
    vy: new Float64Array(length),
    mass: new Float64Array(length),
    burning: new Uint8Array(length),
  };
}

function cloneSamples(samples: GhostSamples): MutableSamples {
  return {
    x: samples.x.slice(),
    y: samples.y.slice(),
    vx: samples.vx.slice(),
    vy: samples.vy.slice(),
    mass: samples.mass.slice(),
    burning: samples.burning.slice(),
  };
}

function makeEph(n: number): EphemerisOut {
  return {
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
  };
}

function captureContactOutcomes(sim: Sim): GhostContactOutcome[] {
  const outcomes: GhostContactOutcome[] = [];
  for (let c = 0; c < sim.contacts.count; c++) {
    outcomes.push({
      cleared: sim.contactState.cleared[c] !== 0,
      impactTick: sim.contactState.impactTick[c]!,
      impactSpeed: sim.contactState.impactSpeed[c]!,
      impactEnergy: sim.contactState.impactEnergy[c]!,
    });
  }
  return outcomes;
}

/** Every command the ghost's own integration needs, sorted by tick: the committed `log` first,
 *  the launch, then one burn command per node issued lazily at its own `atTick` (see the module
 *  header). `advance`'s cursor skips anything already behind `sim.tick`, so this same array is
 *  correct whether integration starts cold at `fromTick` or resumes from a mid-flight checkpoint. */
function buildTrialLog({
  log,
  plan,
  probeIndex,
}: {
  log: readonly Command[];
  plan: FlightPlan;
  probeIndex: number;
}): Command[] {
  const launch: Command = {
    tick: plan.launchTick,
    kind: 'launch',
    rail: plan.rail,
    heading: plan.heading,
    speed: plan.speed,
  };
  const burns: Command[] = plan.nodes.map((node) => ({
    tick: node.atTick,
    kind: 'burn',
    probe: probeIndex,
    atTick: node.atTick,
    prograde: node.prograde,
    lateral: node.lateral,
  }));
  return [...log, launch, ...burns].sort((a, b) => a.tick - b.tick);
}

function nodesEqual(a: BurnNode, b: BurnNode): boolean {
  return a.atTick === b.atTick && a.prograde === b.prograde && a.lateral === b.lateral;
}

/** The first node index where `oldNodes` and `newNodes` diverge (by value, not just length); null
 *  if every node matches (including both being the same length). */
function firstDifferingNodeIndex(
  oldNodes: readonly BurnNode[],
  newNodes: readonly BurnNode[],
): number | null {
  const shorter = Math.min(oldNodes.length, newNodes.length);
  for (let i = 0; i < shorter; i++) {
    if (!nodesEqual(oldNodes[i]!, newNodes[i]!)) return i;
  }
  return oldNodes.length === newNodes.length ? null : shorter;
}

type ResumePlan =
  | { kind: 'cold' }
  | { kind: 'unchanged' }
  | { kind: 'resume'; nodeIndex: number; checkpoint: Checkpoint };

/** Decides how much of `cache` (if any) this call can reuse. Anything about the world or the
 *  launch itself changing invalidates the whole cache (`cold`); otherwise the first node that
 *  differs from the cached plan picks a checkpoint to resume from, falling back to `cold` when no
 *  checkpoint reaches that far (the cached run stopped early, or a node was appended beyond what
 *  was ever tracked) or the edited node's own `atTick` would require running backwards in time. */
function planResume({
  cache,
  level,
  log,
  plan,
  fromTick,
  horizonTick,
}: {
  cache: GhostCache | undefined;
  level: CompiledLevel;
  log: readonly Command[];
  plan: FlightPlan;
  fromTick: number;
  horizonTick: number;
}): ResumePlan {
  if (!cache) return { kind: 'cold' };
  if (
    cache.level !== level ||
    cache.log !== log ||
    cache.fromTick !== fromTick ||
    cache.horizonTick !== horizonTick ||
    cache.plan.rail !== plan.rail ||
    cache.plan.launchTick !== plan.launchTick ||
    cache.plan.heading !== plan.heading ||
    cache.plan.speed !== plan.speed
  ) {
    return { kind: 'cold' };
  }

  const k = firstDifferingNodeIndex(cache.plan.nodes, plan.nodes);
  if (k === null) return { kind: 'unchanged' };
  if (k === 0 || k >= cache.checkpoints.length) return { kind: 'cold' };

  const checkpoint = cache.checkpoints[k]!;
  if (plan.nodes[k]!.atTick < checkpoint.tick) return { kind: 'cold' };
  return { kind: 'resume', nodeIndex: k, checkpoint };
}

interface RunLoopArgs {
  sim: Sim;
  level: CompiledLevel;
  probeIndex: number;
  trialLog: Command[];
  plan: FlightPlan;
  fromTick: number;
  horizonTick: number;
  startIndex: number;
  samples: MutableSamples;
  events: GhostEvent[];
  checkpoints: Checkpoint[];
  contactBest: ContactBest[];
  nodeCursor: number;
  checkpointNodeCursor: number;
}

/** Advances `sim` one tick at a time from `startIndex` (already sampled -- either the fresh base
 *  state or a checkpoint's own instant) to `horizonTick`, writing every further sample and event
 *  and appending a checkpoint each time a still-unfired node's `atTick` is reached. Stops early on
 *  an impact or a body hit (ADR-0005 "Burns": an expended object never moves again). */
function runLoop({
  sim,
  level,
  probeIndex,
  trialLog,
  plan,
  fromTick,
  horizonTick,
  startIndex,
  samples,
  events,
  checkpoints,
  contactBest,
  nodeCursor,
  checkpointNodeCursor,
}: RunLoopArgs): { ticksIntegrated: number; finalIndex: number } {
  const contactCount = sim.contacts.count;
  const eph = makeEph(sim.bodies.count);
  let contactPrev: { x: number; y: number }[] = new Array(contactCount);
  let contactCur: { x: number; y: number }[] = new Array(contactCount);

  const sampleContacts = (tick: number, out: { x: number; y: number }[]): void => {
    if (contactCount === 0) return;
    const t = tick * level.scenario.dt;
    evaluateEphemeris(sim.bodies, t, eph);
    for (let c = 0; c < contactCount; c++) {
      out[c] = contactPoint({ bodies: sim.bodies, contacts: sim.contacts, contact: c, t, eph });
    }
  };

  let index = startIndex;
  sampleContacts(fromTick + index, contactPrev);
  let existedPrev = probeIndex < sim.objects.count;

  let nextPairIndex = nodeCursor;
  let nextCheckpointIndex = checkpointNodeCursor;

  const maybeCheckpoint = (): void => {
    const currentTick = fromTick + index;
    while (
      nextCheckpointIndex < plan.nodes.length &&
      plan.nodes[nextCheckpointIndex]!.atTick === currentTick
    ) {
      checkpoints.push({
        tick: currentTick,
        probeIndex,
        nodeCursor: nextPairIndex,
        bytes: serializeSim(sim),
        contactBest: contactBest.map((b) => ({ ...b })),
      });
      nextCheckpointIndex++;
    }
  };
  maybeCheckpoint();

  let ticksIntegrated = 0;

  while (fromTick + index < horizonTick) {
    advance({ sim, log: trialLog, ticks: 1 });
    index++;
    ticksIntegrated++;
    const tick = fromTick + index;
    // stepTick (dynamics/step.ts) records an event's tick as the *pre*-increment `sim.tick` it
    // was called with -- contactState.impactTick's own convention -- one less than `tick` above,
    // which is `sim.tick` *after* this call's increment (the sample's own "now").
    const eventTick = tick - 1;

    samples.x[index] = sim.objects.x[probeIndex]!;
    samples.y[index] = sim.objects.y[probeIndex]!;
    samples.vx[index] = sim.objects.vx[probeIndex]!;
    samples.vy[index] = sim.objects.vy[probeIndex]!;
    samples.mass[index] = sim.objects.mass[probeIndex]!;
    samples.burning[index] = sim.objects.burning[probeIndex]!;

    if (samples.burning[index - 1] === 0 && samples.burning[index] === 1) {
      events.push({ kind: 'nodeStart', tick: eventTick, node: nextPairIndex });
    } else if (samples.burning[index - 1] === 1 && samples.burning[index] === 0) {
      events.push({ kind: 'nodeEnd', tick: eventTick, node: nextPairIndex });
      nextPairIndex++;
    }

    const existedNow = probeIndex < sim.objects.count;
    sampleContacts(tick, contactCur);
    if (existedPrev && existedNow) {
      for (let c = 0; c < contactCount; c++) {
        const distance = sweptSegmentDistance({
          probeStart: { x: samples.x[index - 1]!, y: samples.y[index - 1]! },
          probeEnd: { x: samples.x[index]!, y: samples.y[index]! },
          contactStart: contactPrev[c]!,
          contactEnd: contactCur[c]!,
        });
        if (distance < contactBest[c]!.distance) contactBest[c] = { distance, tick };
      }
    }
    [contactPrev, contactCur] = [contactCur, contactPrev];
    existedPrev = existedNow;

    const hitContact = sim.objects.hitContact[probeIndex]!;
    const hitBody = sim.objects.hitBody[probeIndex]!;
    let stopped = false;
    if (hitContact !== -1) {
      // sim.contactState.impactTick is the authoritative tick (read directly rather than trusting
      // eventTick's own derivation to agree in every case).
      events.push({
        kind: 'impact',
        tick: sim.contactState.impactTick[hitContact]!,
        contact: hitContact,
      });
      stopped = true;
    } else if (hitBody !== -1) {
      events.push({ kind: 'bodyHit', tick: eventTick, body: hitBody });
      stopped = true;
    }
    if (stopped) break;

    maybeCheckpoint();
  }

  return { ticksIntegrated, finalIndex: index };
}

/** Runs the live simulation's own step function over `plan` from `fromTick` to `horizonTick`
 *  (docs/work/GRV-0025-flight-plan-and-ghost.md, GAME-0001 §4.6 "the planner's forward integration
 *  is the live simulation's code path"). `log` is every command already committed to the level's
 *  real game log ("everything already committed"); it is replayed first to reproduce the world at
 *  `fromTick`, exactly once, before the plan is ever applied. Pass back the returned `cache` on the
 *  next call (after editing `plan`) to reuse everything up to the earliest node that changed. */
export function integrateGhost({
  level,
  log,
  plan,
  fromTick,
  horizonTick,
  cache,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  plan: FlightPlan;
  fromTick: number;
  horizonTick: number;
  cache?: GhostCache;
}): { ghost: Ghost; cache: GhostCache } {
  const resume = planResume({ cache, level, log, plan, fromTick, horizonTick });

  if (resume.kind === 'unchanged') {
    const reused = cache!;
    return { ghost: { ...reused.ghost, ticksIntegrated: 0 }, cache: reused };
  }

  const totalLength = horizonTick - fromTick + 1;
  let sim: Sim;
  let probeIndex: number;
  let startIndex: number;
  let samples: MutableSamples;
  let events: GhostEvent[];
  let checkpoints: Checkpoint[];
  let contactBest: ContactBest[];
  let nodeCursor: number;
  let checkpointNodeCursor: number;

  if (resume.kind === 'resume') {
    const checkpoint = resume.checkpoint;
    sim = deserializeSim({ scenario: level.scenario, bytes: checkpoint.bytes });
    probeIndex = checkpoint.probeIndex;
    startIndex = checkpoint.tick - fromTick;
    samples = cloneSamples(cache!.ghost.samples);
    events = cache!.ghost.events.filter(
      (e) => e.kind !== 'launch' && e.kind !== 'closestApproach' && e.tick < checkpoint.tick,
    );
    checkpoints = cache!.checkpoints.slice(0, resume.nodeIndex + 1);
    contactBest = checkpoint.contactBest.map((b) => ({ ...b }));
    nodeCursor = checkpoint.nodeCursor;
    checkpointNodeCursor = resume.nodeIndex + 1;
  } else {
    sim = createSim({ scenario: level.scenario, seed: level.seed });
    advance({ sim, log, ticks: fromTick });
    probeIndex = sim.objects.count;
    startIndex = 0;
    samples = createSamples(totalLength);
    samples.x[0] = sim.objects.x[probeIndex]!;
    samples.y[0] = sim.objects.y[probeIndex]!;
    samples.vx[0] = sim.objects.vx[probeIndex]!;
    samples.vy[0] = sim.objects.vy[probeIndex]!;
    samples.mass[0] = sim.objects.mass[probeIndex]!;
    samples.burning[0] = sim.objects.burning[probeIndex]!;
    events = [];
    checkpoints = [];
    contactBest =
      sim.contacts.count > 0
        ? Array.from({ length: sim.contacts.count }, () => ({ distance: Infinity, tick: -1 }))
        : [];
    nodeCursor = 0;
    checkpointNodeCursor = 0;
  }

  events.push({ kind: 'launch', tick: plan.launchTick });

  const trialLog = buildTrialLog({ log, plan, probeIndex });

  const { ticksIntegrated, finalIndex } = runLoop({
    sim,
    level,
    probeIndex,
    trialLog,
    plan,
    fromTick,
    horizonTick,
    startIndex,
    samples,
    events,
    checkpoints,
    contactBest,
    nodeCursor,
    checkpointNodeCursor,
  });

  for (let c = 0; c < contactBest.length; c++) {
    const best = contactBest[c]!;
    if (best.tick !== -1)
      events.push({
        kind: 'closestApproach',
        tick: best.tick,
        contact: c,
        distance: best.distance,
      });
  }

  const ghost: Ghost = {
    fromTick,
    horizonTick,
    probeIndex,
    samples: { ...samples, count: finalIndex + 1 },
    events,
    contacts: captureContactOutcomes(sim),
    ticksIntegrated,
  };

  const newCache: GhostCache = { level, log, fromTick, horizonTick, plan, checkpoints, ghost };

  return { ghost, cache: newCache };
}
