// Ghost integration (GAME-0001 §4.4-4.6, §7 must-have 3; docs/domain/simulation-determinism.md
// "Ghost invariant"; ADR-0005 "Consequences" -- "the planner re-integrates one ghost and caches
// from the earliest edited node"): the plotted trajectory IS what will happen because it is
// produced by the live simulation's own `createSim`/`advance`, never a separate model. The world
// at `fromTick` is reproduced by replaying the level's already-committed log; the plan is then
// applied on top and integrated to `horizonTick`, sampling the ghost probe's x/y/vx/vy/mass/
// burning per tick plus the events it meets along the way (launch, each node's start/end, closest
// approach per contact, impact, a body hit).
//
// Issuance timing (ADR-0007 §2, GRV-0031): `planToCommands` (plan.ts) issues the launch and every
// node bundled at the SAME tick -- `issueTickFor(rail, launchTick)` -- because the whole plan
// travels as one transmission and a bundled burn's own light-cone check is skipped entirely
// (commands.ts's `resolveBurnProbe`/`checkBurn`, "the launch's own checkLaunch already covers
// occlusion for that transmission"). A DRAFT's own trial log now issues the launch and every node
// the identical way, at the identical tick -- ghost issuance IS commit issuance, one code path, no
// second (lazy, per-node) issuance model to keep in sync with it. This is what resolves the filed
// limitation (docs/issues/2026-09-18-ghost-lazy-issuance-cannot-cross-a-long-blocked-stretch.md):
// a node deep inside a long blocked stretch integrates fine now, because it is never re-validated
// against occlusion at all -- exactly like the committed replay it mirrors.
//
// The cache still checkpoints per node, just at a different moment: since every node's command is
// already queued (sim/commands.ts's `materializeBurn`, sim.ts's own pending-burn-node ring) the
// instant the batch is issued, "the state right before node k's own command applies" is no longer a
// single well-defined tick (every node's command applies at the same issue tick). What a checkpoint
// needs to capture instead is "the state right before node k's own EFFECT could possibly differ" --
// which is exactly `atTick`, the tick it activates (`activateDueBurnNodes`, sim.ts) -- because
// nothing about a still-queued node's own prograde/lateral/atTick can change anything the sim does
// before that instant (sim.pending is state, inert until then). Resuming from such a checkpoint
// does not re-issue anything through the command log either (there is nothing left to issue -- the
// whole batch went out at the very first tick, module header, "the commands are already queued"):
// it swaps the deserialised sim's own still-pending entries for this probe (the cached run's stale
// values) for the current plan's own nodes from the edited one onward, directly, the same insertion
// -sorted-by-atTick shape `commands.ts`'s own `materializeBurn` keeps (duplicated here, in full,
// rather than exported from sim/**, which this unit leaves untouched) -- so a later resume with a
// downstream edit still substitutes cleanly, exactly as lazy issuance's own checkpoint-then-push
// used to.
//
// Amendments (GRV-0031, ADR-0007 §3): a flying probe's plan is amended by issuing new burn commands
// to its already-existing object index, `now` -- there is no launch to (re)issue, and the probe's
// own light-cone check (`checkBurn`) is NOT bundled away this time (the probe already exists), so
// it is the simulation's own last line of defence against a locked or occluded node exactly as a
// live commit would be. The world an amendment plans against is not the true state -- "the post
// plans on what it knows" -- so the amendment ghost starts from the OBSERVED prediction: the
// committed log replayed to the last observation, then continued (same log, nothing new) to `now`,
// the exact replay src/app/observed.ts's own `observedObjects` performs, duplicated here in full
// rather than imported (src/planner depends on neither src/app nor the reverse). An amendment ghost
// is never cached -- a session touches at most a handful of nodes over a short, already-cheap
// horizon, and reusing a checkpoint across an edit would need the very same queue-swap resume logic
// the draft path already carries, for a case that does not need the performance (YAGNI).
import { advance, createSim, deserializeSim, serializeSim } from '../sim/sim.ts';
import type { Command, Sim } from '../sim/sim.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { contactPoint } from '../sim/contacts.ts';
import { issueTickFor } from '../sim/lightcone.ts';
import { sweptSegmentDistance } from '../levels/solve.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import { diffAmendmentNodes, existingNodesForProbe } from './plan.ts';
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
   *  never touching the live game `Sim`) integration -- for an amendment, the probe being amended,
   *  read straight from `amend.probe`, never re-derived. */
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
 *  "Consequences"): the serialised sim right before node `k` itself could activate, plus the
 *  event-pairing cursor and the per-contact running closest-approach state at that instant -- both
 *  of those are ongoing accumulators that a plain `deserializeSim` cannot reconstruct on its own.
 *  `tick` is `plan.nodes[k].atTick` at the time this checkpoint was taken (module header: no longer
 *  an issue tick -- every node's command is already queued well before this). */
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
  /** `checkpoints[i]` = state right before `plan.nodes[i]` itself activates; shorter than
   *  `plan.nodes.length` when integration stopped early before reaching every node. `[]` for an
   *  amendment ghost, which is never cached (module header). */
  checkpoints: Checkpoint[];
  ghost: Ghost;
}

/** A flying probe's plan is amended by issuing its new/changed nodes now, to its own already-
 *  existing object index (module header) -- never a relaunch. `observationTick` is the last
 *  observation the amendment plans against (src/app/observed.ts's own emission tick at the moment
 *  amendment mode was entered), fixed for the whole session like a draft's own `launchTick`. */
export interface AmendContext {
  probe: number;
  observationTick: number;
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

function sampleProbeInto(
  samples: MutableSamples,
  index: number,
  sim: Sim,
  probeIndex: number,
): void {
  samples.x[index] = sim.objects.x[probeIndex]!;
  samples.y[index] = sim.objects.y[probeIndex]!;
  samples.vx[index] = sim.objects.vx[probeIndex]!;
  samples.vy[index] = sim.objects.vy[probeIndex]!;
  samples.mass[index] = sim.objects.mass[probeIndex]!;
  samples.burning[index] = sim.objects.burning[probeIndex]!;
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

function initialContactBest(sim: Sim): ContactBest[] {
  return sim.contacts.count > 0
    ? Array.from({ length: sim.contacts.count }, () => ({ distance: Infinity, tick: -1 }))
    : [];
}

/** The committed `log` plus the plan's own launch and every node, all issued at
 *  `issueTickFor(rail, launchTick)` (the latest tick that still arrives exactly at `launchTick` --
 *  ADR-0007 §2): sorted by tick, launch first (module header -- "ghost issuance is commit
 *  issuance"). `advance`'s cursor skips anything already behind `sim.tick`, so this same array is
 *  correct whether integration starts cold at `fromTick` or resumes from a node's own checkpoint
 *  (by then every command in it has tick < sim.tick and nothing here is re-applied -- what resuming
 *  actually needs is already in the deserialised sim's own state, module header). */
function buildTrialLog({
  sim,
  log,
  plan,
  probeIndex,
}: {
  sim: Sim;
  log: readonly Command[];
  plan: FlightPlan;
  probeIndex: number;
}): Command[] {
  const issueTick = issueTickFor({
    sim,
    target: { kind: 'rail', rail: plan.rail },
    atTick: plan.launchTick,
  });
  const commands: Command[] = [
    { tick: issueTick, kind: 'launch', rail: plan.rail, heading: plan.heading, speed: plan.speed },
  ];
  for (const node of plan.nodes) {
    commands.push({
      tick: issueTick,
      kind: 'burn',
      probe: probeIndex,
      atTick: node.atTick,
      prograde: node.prograde,
      lateral: node.lateral,
    });
  }
  return [...log, ...commands].sort((a, b) => a.tick - b.tick);
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
 *  was ever tracked) or the edited node's own `atTick` would require running backwards in time
 *  (earlier than the checkpoint's own tick, which is exactly `atTick` now -- module header). */
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

/** Mirrors commands.ts's `materializeBurn` insertion-sort exactly (src/sim/** is off limits this
 *  unit, so this duplicates the small, atTick-sorted insertion rather than exporting a new sim
 *  query for it) -- ghost.ts already reaches into a `Sim`'s own typed arrays directly elsewhere
 *  (`sim.objects.x` and friends); this is the same boundary, just on `sim.pending`. */
function insertPendingBurn(
  sim: Sim,
  node: { object: number; atTick: number; prograde: number; lateral: number },
): void {
  const pending = sim.pending;
  if (pending.count >= pending.object.length) {
    throw new Error(`ghost: pending burn queue capacity ${pending.object.length} exceeded`);
  }
  let p = pending.count;
  while (p > 0 && pending.atTick[p - 1]! > node.atTick) {
    pending.object[p] = pending.object[p - 1]!;
    pending.atTick[p] = pending.atTick[p - 1]!;
    pending.prograde[p] = pending.prograde[p - 1]!;
    pending.lateral[p] = pending.lateral[p - 1]!;
    p--;
  }
  pending.object[p] = node.object;
  pending.atTick[p] = node.atTick;
  pending.prograde[p] = node.prograde;
  pending.lateral[p] = node.lateral;
  pending.count++;
}

/** Removes every not-yet-fired pending entry for `probeIndex` at or after `fromAtTick` -- exactly
 *  the stale suffix a resumed checkpoint's own `sim.pending` carries over from the cached (pre-edit)
 *  plan (module header, "the commands are already queued"): everything strictly before `fromAtTick`
 *  either already fired (removed from the queue by `activateDueBurnNodes`, sim.ts) or -- the one
 *  case this does not chase, a node still waiting past its own `atTick` because the probe was busy
 *  finishing an earlier burn -- is untouched by this edit and left exactly where it is. */
function clearStalePendingBurns(sim: Sim, probeIndex: number, fromAtTick: number): void {
  const pending = sim.pending;
  let write = 0;
  for (let read = 0; read < pending.count; read++) {
    const stale = pending.object[read] === probeIndex && pending.atTick[read]! >= fromAtTick;
    if (!stale) {
      if (write !== read) {
        pending.object[write] = pending.object[read]!;
        pending.atTick[write] = pending.atTick[read]!;
        pending.prograde[write] = pending.prograde[read]!;
        pending.lateral[write] = pending.lateral[read]!;
      }
      write++;
    }
  }
  pending.count = write;
}

interface RunLoopArgs {
  sim: Sim;
  level: CompiledLevel;
  probeIndex: number;
  trialLog: Command[];
  fromTick: number;
  horizonTick: number;
  startIndex: number;
  samples: MutableSamples;
  events: GhostEvent[];
  checkpoints: Checkpoint[];
  contactBest: ContactBest[];
  nodeCursor: number;
  /** The nodes to checkpoint against, in atTick order -- `plan.nodes` for a draft (every node was
   *  batch-issued at the very start, module header) or `[]` for an amendment (never cached). Cursor
   *  starts at `checkpointCursor`, decoupled from `nodeCursor` (the event-labelling cursor, which
   *  always walks `plan.nodes` in full order regardless of caching). */
  trackedNodes: readonly BurnNode[];
  checkpointCursor: number;
}

/** Advances `sim` one tick at a time from `startIndex` (already sampled -- either the fresh base
 *  state or a checkpoint's own instant) to `horizonTick`, writing every further sample and event
 *  and checkpointing right before each of `trackedNodes` reaches its own `atTick` (module header).
 *  Stops early on an impact or a body hit (ADR-0005 "Burns": an expended object never moves
 *  again). */
function runLoop({
  sim,
  level,
  probeIndex,
  trialLog,
  fromTick,
  horizonTick,
  startIndex,
  samples,
  events,
  checkpoints,
  contactBest,
  nodeCursor,
  trackedNodes,
  checkpointCursor,
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
  let nextCheckpointIndex = checkpointCursor;

  const maybeCheckpoint = (): void => {
    while (
      nextCheckpointIndex < trackedNodes.length &&
      trackedNodes[nextCheckpointIndex]!.atTick <= sim.tick
    ) {
      checkpoints.push({
        tick: sim.tick,
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

    sampleProbeInto(samples, index, sim, probeIndex);

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
function integrateDraftGhost({
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
  let checkpointCursor: number;

  if (resume.kind === 'resume') {
    const checkpoint = resume.checkpoint;
    sim = deserializeSim({ scenario: level.scenario, bytes: checkpoint.bytes });
    probeIndex = checkpoint.probeIndex;
    startIndex = checkpoint.tick - fromTick;
    samples = cloneSamples(cache!.ghost.samples);
    events = cache!.ghost.events.filter(
      (e) => e.kind !== 'launch' && e.kind !== 'closestApproach' && e.tick < checkpoint.tick,
    );
    // checkpoint itself is `resume.nodeIndex`'s own checkpoint -- taken right before that node
    // could activate (module header), so its own (possibly stale) value is still sitting in
    // sim.pending: swap it, and everything after it, for the current plan's own nodes.
    checkpoints = cache!.checkpoints.slice(0, resume.nodeIndex);
    contactBest = checkpoint.contactBest.map((b) => ({ ...b }));
    nodeCursor = checkpoint.nodeCursor;
    checkpointCursor = resume.nodeIndex;
    clearStalePendingBurns(sim, probeIndex, checkpoint.tick);
    for (const node of plan.nodes.slice(resume.nodeIndex)) {
      insertPendingBurn(sim, {
        object: probeIndex,
        atTick: node.atTick,
        prograde: node.prograde,
        lateral: node.lateral,
      });
    }
  } else {
    sim = createSim({ scenario: level.scenario, seed: level.seed });
    advance({ sim, log, ticks: fromTick });
    probeIndex = sim.objects.count;
    startIndex = 0;
    samples = createSamples(totalLength);
    sampleProbeInto(samples, 0, sim, probeIndex);
    events = [];
    checkpoints = [];
    contactBest = initialContactBest(sim);
    nodeCursor = 0;
    checkpointCursor = 0;
  }

  events.push({ kind: 'launch', tick: plan.launchTick });

  const trialLog = buildTrialLog({ sim, log, plan, probeIndex });

  const { ticksIntegrated, finalIndex } = runLoop({
    sim,
    level,
    probeIndex,
    trialLog,
    fromTick,
    horizonTick,
    startIndex,
    samples,
    events,
    checkpoints,
    contactBest,
    nodeCursor,
    trackedNodes: plan.nodes,
    checkpointCursor,
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

/** An amendment's own ghost (module header): starts from the OBSERVED prediction, not the true
 *  state -- the committed log replayed to `amend.observationTick` (the last real telemetry), then
 *  continued with the same log (nothing new to apply) to `fromTick` ("now"), duplicating src/app/
 *  observed.ts's own two-stage replay rather than importing it (src/planner imports neither
 *  src/app nor the reverse). `diffAmendmentNodes` (plan.ts) picks exactly the nodes this amendment
 *  actually needs to transmit -- an untouched existing node is never re-issued, so this never
 *  double-queues a burn already sitting in the replayed sim's own pending-node ring. Never cached
 *  (module header). */
function integrateAmendGhost({
  level,
  log,
  plan,
  fromTick,
  horizonTick,
  amend,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  plan: FlightPlan;
  fromTick: number;
  horizonTick: number;
  amend: AmendContext;
}): { ghost: Ghost; cache: GhostCache } {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  advance({ sim, log, ticks: amend.observationTick });
  if (fromTick > amend.observationTick) {
    advance({ sim, log, ticks: fromTick - amend.observationTick });
  }

  const probeIndex = amend.probe;
  const totalLength = horizonTick - fromTick + 1;
  const samples = createSamples(totalLength);
  sampleProbeInto(samples, 0, sim, probeIndex);
  const events: GhostEvent[] = [];
  const contactBest = initialContactBest(sim);

  const existing = existingNodesForProbe({ log, probe: probeIndex });
  const toIssue = diffAmendmentNodes({ existing, nodes: plan.nodes });
  const trialLog: Command[] = [
    ...log,
    ...toIssue.map((node): Command => ({
      tick: fromTick,
      kind: 'burn',
      probe: probeIndex,
      atTick: node.atTick,
      prograde: node.prograde,
      lateral: node.lateral,
    })),
  ].sort((a, b) => a.tick - b.tick);

  const { ticksIntegrated, finalIndex } = runLoop({
    sim,
    level,
    probeIndex,
    trialLog,
    fromTick,
    horizonTick,
    startIndex: 0,
    samples,
    events,
    checkpoints: [],
    contactBest,
    nodeCursor: 0,
    trackedNodes: [],
    checkpointCursor: 0,
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

  // Never reused (module header): the returned cache carries no checkpoints, so a future call
  // that (mistakenly) passed it back in would simply find nothing to resume from -- harmless, but
  // integrateGhost's own amend branch never even looks at an incoming cache, so this is never read.
  const cache: GhostCache = { level, log, fromTick, horizonTick, plan, checkpoints: [], ghost };
  return { ghost, cache };
}

export function integrateGhost({
  level,
  log,
  plan,
  fromTick,
  horizonTick,
  cache,
  amend,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  plan: FlightPlan;
  fromTick: number;
  horizonTick: number;
  cache?: GhostCache;
  amend?: AmendContext;
}): { ghost: Ghost; cache: GhostCache } {
  if (amend) return integrateAmendGhost({ level, log, plan, fromTick, horizonTick, amend });
  return integrateDraftGhost({ level, log, plan, fromTick, horizonTick, cache });
}
