// The app's core state (GRV-0021): one loaded Sim (via a DebugSession, GRV-0011) plus the level
// metadata and warp state the status bar and plot region read from. DOM-free by design, like
// loop.ts and warp.ts, so it's directly testable in Node; main.ts's `onChange` callback is the
// only place that touches the real DOM, and the debug API (debug-api.ts) drives this exact same
// App so a headless driver and a human see identical state (ADR-0004 §1-2,
// docs/domain/simulation-determinism.md rule 10: this never writes simulation state itself,
// `advance` does -- it only reads what the session already computed).
import { createDebugSession } from './debug-api.ts';
import type { LoadArgs, RunArgs, RunResult, StateSnapshot } from './debug-api.ts';
import { diffObservedEvents, sampleClosestApproach } from './events.ts';
import type { ObservedEventObject, RangeTrend, SimEvent } from './events.ts';
import { getLevel, levelIds } from './levels.ts';
import type { CompiledLevel } from './levels.ts';
import { effectiveTicksThisFrame } from './loop.ts';
import { createObservedCache } from './observed.ts';
import type { ObservedCache, ObservedObject } from './observed.ts';
import { predictProbe } from './predict.ts';
import {
  GHOST_HORIZON_TICKS,
  addNode as plannerAddNode,
  beginLaunchDrag as plannerBeginLaunchDrag,
  beginNodeDrag as plannerBeginNodeDrag,
  createPlannerState,
  discardDraft as plannerDiscardDraft,
  endDrag as plannerEndDrag,
  reintegrate as plannerReintegrate,
  removeNode as plannerRemoveNode,
  selectNode as plannerSelectNode,
  setHorizon as plannerSetHorizon,
  setPlan as plannerSetPlan,
  updateLaunchDrag as plannerUpdateLaunchDrag,
  updateNodeDrag as plannerUpdateNodeDrag,
} from './planner.ts';
import type { Drag, PlannerState } from './planner.ts';
import { selectionName as selectionNameOf } from './selection.ts';
import type { ReadoutRow, Selection } from './selection.ts';
import { getSolution } from './solutions.ts';
import type { CompiledSolution } from './solutions.ts';
import { formatSimTime } from './time.ts';
import { createTrailSet, resetTrailSet, sampleObservedTrailSet, trailPoints } from './trails.ts';
import type { TrailSet } from './trails.ts';
import {
  WARP_LADDER,
  clampRung,
  stepRung,
  ticksPerFrame,
  togglePause as togglePauseRung,
} from './warp.ts';
import type { WarpRung } from './warp.ts';
import { NO_IMPACT } from '../sim/contacts.ts';
import type { Command } from '../sim/sim.ts';
import type { Frame, FrameLevelNames } from '../render/frame.ts';
import type { FlightPlan } from '../planner/plan.ts';
import type { Ghost } from '../planner/ghost.ts';
import { solutionReadout } from '../planner/readout.ts';
import type { SolutionReadout } from '../planner/readout.ts';
import { formatDuration } from '../ui/format.ts';

const EMPTY_LEVEL_NAMES: FrameLevelNames = {
  bodyIds: [],
  railIds: [],
  contactIds: [],
  bodyClasses: [],
  names: { bodies: [], rails: [], contacts: [] },
};

export interface StatusValues {
  time: string;
  warp: string;
  warpEffective: string;
  post: string;
  delay: string;
  /** The last landed event's terse text (GAME-0002 §9's inverted-frame announcement, GRV-0027) --
   *  `'—'` before anything has happened. */
  event: string;
}

export interface PlotError {
  id: string;
  knownIds: string[];
}

export interface Brief {
  name: string;
  text: string;
}

export interface TimelineMark {
  readonly key: string;
  readonly tick: number;
  readonly label: string;
  /** Set only on the unified `event.<n>` marks (GRV-0027): `true` for a real, already-landed event
   *  from `events()` (drawn full), `false` for a predicted upcoming one (drawn dim). `undefined` on
   *  every pre-existing mark (launch/impact/ghost.*), which keeps its own unmarked look. */
  readonly past?: boolean;
}

export interface TimelineData {
  readonly marks: readonly TimelineMark[];
  readonly cursor: { readonly tick: number; readonly label: string };
  readonly rangeTicks: number;
}

export interface AppChange {
  status: StatusValues;
  plotError: PlotError | null;
  brief: Brief | null;
  /** True only for the change emitted by `loadLevel`/`load` -- main.ts uses it to tell "a fresh
   *  run started, reset the plot's camera to the level's default view" apart from an ordinary
   *  `step`/`setWarp` update, which must never move the camera on its own (GAME-0002 §9). */
  justLoaded: boolean;
}

export interface App {
  loadLevel(id: string): StateSnapshot | undefined;
  load(args: LoadArgs): StateSnapshot;
  command(cmd: Command): void;
  step(ticks: number): StateSnapshot;
  warpTo(tick: number): StateSnapshot;
  setWarp(rung: number): void;
  togglePause(): void;
  stepWarpRung(direction: 1 | -1): void;
  warpRung(): WarpRung;
  hash(): string;
  state(): StateSnapshot;
  run(args: RunArgs): RunResult;
  /** Every event landed so far this session (GRV-0027, src/app/events.ts), oldest first -- a copy,
   *  like `view()`'s own contract. */
  events(): readonly SimEvent[];
  /** The earliest known future event tick (GRV-0027 design note), the minimum over: committed log
   *  commands with tick > now, the draft ghost's own events, and a prediction of each running
   *  probe's remaining flight (src/app/predict.ts) -- `null` when nothing is known to be coming. */
  nextEventTick(): number | null;
  /** Arms `warpToEvent`: jumps the rung to the top of the ladder and records `nextEventTick()` as
   *  the target `step` clamps to -- a no-op if there is no known upcoming event. Does *not* itself
   *  drain the warp; the real rAF loop's own per-frame `step` calls drain it a budget at a time
   *  (never a single giant advance that freezes the page), and the debug API's own `warpToEvent`
   *  wraps this with a synchronous drain loop (main.ts). */
  warpToEvent(): void;
  /** The tick `warpToEvent` last armed, `null` once reached (or if never armed) -- lets a caller
   *  drive a synchronous drain loop without reaching into app internals. */
  warpTargetTick(): number | null;
  /** True exactly once per landed automatic drop (GAME-0002 §9's single inverted status-bar frame):
   *  the first call after `step`/`warpToEvent` drops the rung returns `true` and clears the flag,
   *  every call after that (until the next drop) returns `false` -- main.ts calls this once per
   *  rendered frame (the real rAF loop, and the debug API's own `render()`) to toggle the class for
   *  exactly one frame. */
  takePendingInvert(): boolean;
  /** A read-only render snapshot of the loaded session at its current tick (src/render/frame.ts);
   *  throws if nothing is loaded, like `state()`/`hash()`. */
  frame(): Frame;
  /** Every dynamic object's *observed* trail so far, keyed by object index (src/app/trails.ts) --
   *  positions at emission ticks up to the object's last observation (GRV-0030, GAME-0002 §4
   *  "Solid, one pixel | Observed"), sampled once per tick `step`/`warpTo` actually advanced,
   *  never the live trajectory. */
  trails(): ReadonlyMap<number, readonly { x: number; y: number }[]>;
  /** Every dynamic object's dotted, fading predicted tail (GRV-0030, GAME-0002 §4 "Extrapolated
   *  from a stale observation"): `[observation, ...tail]`, oldest first, the same current-tick
   *  data `observed()` already carries -- an object with no observation, or nothing predicted
   *  beyond it, is simply absent (the render/plot.ts convention `trails()` already follows). */
  predictedTails(): ReadonlyMap<number, readonly { x: number; y: number }[]>;
  /** `index`'s own observed view as of the current tick (GRV-0030, src/app/observed.ts) -- `null`
   *  for an out-of-range index or nothing loaded. */
  observed(index: number): ObservedObject | null;
  /** One-way delay to `selection`, in seconds (GAME-0002 §8's status bar `DELAY`, GRV-0030) --
   *  `null` for a body, no selection, or nothing loaded. */
  delay(selection: Selection): number | null;
  /** Sets the app's selection state (GRV-0023): the renderer only ever reads it back through
   *  `frame()`'s sibling, the plot controller's own selection arg -- the app owns it. */
  select(selection: Selection): void;
  selection(): Selection;
  /** Every selection-panel field for the current selection, read straight from the loaded session
   *  (src/app/selection.ts's `describeSelection`, never from `frame()` -- rule 11). `[]` before
   *  anything is loaded or selected. */
  selectionReadouts(): ReadoutRow[];
  /** The emphasis-size id/name line for the current selection (GAME-0002 §8) -- `''` when nothing
   *  is selected. */
  selectionName(): string;
  /** Applies the loaded level's committed solution log (src/app/solutions.ts), the same log
   *  `?solution=1` applies -- a no-op before a level is loaded or if it has no committed solution. */
  loadSolution(): void;
  /** The solution `loadSolution()` last applied, for the timeline strip's launch marks and its
   *  default tick range; `null` until `loadSolution()` succeeds. */
  solution(): CompiledSolution | null;
  /** The timeline strip's marks (a launch per command in the loaded solution, an impact per
   *  contact once `state().contacts[i].impactTick` records one), present-time cursor and axis
   *  range -- `null` before anything is loaded, like `state()`/`hash()`. */
  timelineData(): TimelineData | null;

  // -- Planner (GRV-0026, GAME-0001 §4.4-4.6) -------------------------------------------------
  // Every mutator here reintegrates the ghost synchronously before returning (src/app/planner.ts's
  // `reintegrate`) -- the debug API and real pointer/keyboard input drive it identically; the UI
  // layer is responsible for not calling the drag updaters more than once per animation frame
  // (design note), not this module for debouncing them itself.
  plan(): FlightPlan | null;
  /** Replaces the draft outright (debug API's own `setPlan`) -- clears any in-progress drag and
   *  selection, then reintegrates. */
  setPlan(plan: FlightPlan): void;
  discardDraft(): void;
  beginLaunchDrag(args: { rail: number; worldX: number; worldY: number }): void;
  updateLaunchDrag(args: { worldX: number; worldY: number; metresPerPixel: number }): void;
  beginNodeDrag(args: {
    index: number;
    handle: 'prograde' | 'lateral';
    worldX: number;
    worldY: number;
  }): void;
  updateNodeDrag(args: { worldX: number; worldY: number; metresPerPixel: number }): void;
  endDrag(): void;
  selectNode(index: number | null): void;
  selectedNode(): number | null;
  drag(): Drag | null;
  addNode(args: { tick: number }): void;
  removeNode(args: { index: number }): void;
  ghost(): Ghost | null;
  /** The ghost's own solution readout (src/planner/readout.ts) -- distinct from `solution()`
   *  above, which is the level's *committed campaign* solution log; this one is what the current
   *  draft's ghost would do. `null` without a draft or a ghost (an infeasible launch draws no
   *  ghost -- see `planIssues`). */
  planSolution(): SolutionReadout | null;
  /** Every reason the current draft integrates to no ghost (`reintegrate`'s own `issues`, src/
   *  app/planner.ts, GRV-0028): validatePlan's own shape issues (plan.ts: node budget,
   *  sortedness, integer-ness, a node no longer later than the launch), checked before the draft
   *  ever reaches the sim, or, if the shape is fine, a human-readable line naming checkLaunch's
   *  own rejection reason -- the PLAN panel's Commit button reads this to decide whether it is
   *  disabled and why (design note). `[]` when the draft is valid or there is none. */
  planIssues(): string[];
  /** `null` is "the present"; otherwise the tick `frame()` reads bodies/rails/contacts at (GAME-
   *  0001 §4.6 "horizon scrub"). Nothing in the simulation moves because of this. */
  setHorizon(tick: number | null): void;
  horizon(): number | null;
  /** Re-snaps and revalidates the draft first (`reintegratePlan`, GRV-0028), exactly like every
   *  other planner mutator, then appends `planToCommands` (plan.ts, via `session.commitPlan` --
   *  GRV-0029: solving the launch's own light-cone issue tick needs the loaded `Sim`, which never
   *  leaves debug-api.ts) to the session log and clears the draft -- what commits is exactly what
   *  the ghost most recently showed. Never throws: with no draft, or one that is still invalid
   *  after re-snapping (`planIssues()` non-empty), returns the issues instead of committing
   *  anything, so a caller (main.ts's Commit handler) can show them rather than let an uncaught
   *  error reach the console. */
  commitPlan(): { committed: true } | { committed: false; issues: string[] };
}

/** A raw `{ scenario, seed }` load (the parity-spec path) carries no compiled level, but the
 *  planner needs *some* `CompiledLevel` to hand `validatePlan`/`integrateGhost`/`checkLaunch` --
 *  mirrors src/planner/ghost.test.ts's own `wrapAsLevel`: placeholder names/ids, the caller's own
 *  scenario and seed, nothing else read by the planner. */
function wrapScenarioAsLevel({ scenario, seed }: LoadArgs): CompiledLevel {
  return {
    schema: 1,
    id: '',
    name: '',
    brief: '',
    debrief: '',
    seed,
    names: { bodies: [], rails: [], contacts: [] },
    bodyIds: [],
    railIds: [],
    contactIds: [],
    bodyClasses: [],
    scenario,
  };
}

const DASH = '—';
const NO_STATE: StatusValues = {
  time: DASH,
  warp: DASH,
  warpEffective: DASH,
  post: DASH,
  delay: DASH,
  event: DASH,
};

export function createApp({ onChange }: { onChange: (change: AppChange) => void }): App {
  const session = createDebugSession();
  let ready = false;
  let currentDt: number | null = null;
  let postName = DASH;
  let brief: Brief | null = null;
  let rung: WarpRung = 0;
  let lastNonZeroRung: WarpRung = 1;
  let levelNames: FrameLevelNames = EMPTY_LEVEL_NAMES;
  let currentLevelId: string | null = null;
  let currentSelection: Selection = null;
  let currentSolution: CompiledSolution | null = null;
  const trailSet: TrailSet = createTrailSet();
  // The full compiled level the planner needs (levelNames above is only the render-facing
  // subset); null exactly when nothing is loaded.
  let currentLevel: CompiledLevel | null = null;
  let plannerState: PlannerState = createPlannerState();

  // Events (GRV-0027, GRV-0030): the session's own append-only log, the per-tick observed-diff
  // cursor, each (probe, contact) pair's closest-approach trend, the pending-invert flag `step`
  // arms and `takePendingInvert` consumes, and the warp-to-event target `step` clamps to.
  let eventLog: SimEvent[] = [];
  let lastObserved: ObservedEventObject[] = [];
  const rangeTrends = new Map<string, RangeTrend>();
  let pendingInvert = false;
  let warpTarget: number | null = null;
  // Keyed by probe index; invalidated by log length rather than reference (debug-api.ts's log is
  // mutated in place by `command`, so `session.log()` never changes reference within a session).
  const predictionCache = new Map<number, { atLogLength: number; events: SimEvent[] }>();
  // The observed view (GRV-0030, src/app/observed.ts): the replay cache (persists for the loaded
  // session's whole lifetime, GRV-0030 module doc) and every object's own latest view, refreshed
  // once per `step`.
  let observedCache: ObservedCache = createObservedCache();
  let currentObserved: ObservedObject[] = [];

  function resetEvents(): void {
    eventLog = [];
    lastObserved = [];
    rangeTrends.clear();
    pendingInvert = false;
    warpTarget = null;
    predictionCache.clear();
    observedCache = createObservedCache();
    currentObserved = [];
  }

  function probeTag(index: number): string {
    return selectionNameOf({ level: levelNames, selection: { kind: 'probe', index } });
  }

  /** The terse, uppercase text GAME-0002 §9's inverted status-bar frame and the timeline strip's
   *  event marks both show (design note: "IMPACT PRB-01 -> DRIFT-HULK style"). Contact/body names
   *  read their own compiled id (not the display name, which may contain spaces) uppercased --
   *  the same terse convention `selectionNameOf` already uses for `PRB-NN`. */
  function eventText(event: SimEvent): string {
    const probe = event.probe !== undefined ? probeTag(event.probe) : '';
    const contact =
      event.contact !== undefined
        ? (levelNames.contactIds[event.contact] ?? `CONTACT-${event.contact}`).toUpperCase()
        : '';
    const body =
      event.body !== undefined
        ? (levelNames.bodyIds[event.body] ?? `BODY-${event.body}`).toUpperCase()
        : '';
    switch (event.kind) {
      case 'launch':
        return `LAUNCH ${probe}`;
      case 'nodeStart':
        return `BURN START ${probe}`;
      case 'nodeEnd':
        return `BURN END ${probe}`;
      case 'impact':
        return `IMPACT ${probe} → ${contact}`;
      case 'bodyHit':
        return `IMPACT ${probe} → ${body}`;
      case 'cleared':
        return `CLEARED ${contact}`;
      case 'closestApproach':
        return `CLOSEST APPROACH ${probe} → ${contact}`;
    }
  }

  /** The event the status bar announces (GRV-0027): usually the last one landed, except an impact
   *  that clears its contact pushes *two* events the same tick (impact, then cleared -- causal
   *  order: the impact is what caused the clearing) -- `cleared` alone is strictly less
   *  informative than the impact right before it, so the impact is what's shown. */
  function lastEventForStatus(): SimEvent | undefined {
    const last = eventLog.at(-1);
    if (!last || last.kind !== 'cleared') return last;
    const prior = eventLog.at(-2);
    return prior && prior.tick === last.tick && prior.kind === 'impact' ? prior : last;
  }

  function statusValues(): StatusValues {
    if (!ready || currentDt === null) return NO_STATE;
    const lastEvent = lastEventForStatus();
    const delaySeconds = session.delay(currentSelection);
    return {
      time: formatSimTime({ tick: session.state().tick, dt: currentDt }),
      warp: `${ticksPerFrame(rung)}x`,
      warpEffective: `${effectiveTicksThisFrame(rung)}x`,
      post: postName,
      delay: delaySeconds === null ? DASH : formatDuration(delaySeconds),
      event: lastEvent ? eventText(lastEvent) : DASH,
    };
  }

  function emit(plotError: PlotError | null = null, justLoaded = false): void {
    onChange({ status: statusValues(), plotError, brief, justLoaded });
  }

  function resetWarp(): void {
    rung = 0;
    lastNonZeroRung = 1;
  }

  function loadLevel(id: string): StateSnapshot | undefined {
    const level = getLevel(id);
    if (!level) {
      ready = false;
      currentDt = null;
      postName = DASH;
      brief = null;
      levelNames = EMPTY_LEVEL_NAMES;
      currentLevelId = null;
      currentLevel = null;
      currentSelection = null;
      currentSolution = null;
      plannerState = createPlannerState();
      resetTrailSet(trailSet);
      resetEvents();
      emit({ id, knownIds: levelIds() }, true);
      return undefined;
    }
    const snap = session.load({ scenario: level.scenario, seed: level.seed });
    currentDt = level.scenario.dt;
    // The post's own host (GRV-0030) -- not necessarily a rail's host (T01-far-post's post sits on
    // the system primary, nowhere near any rail).
    postName = level.names.bodies[level.scenario.post.host] ?? DASH;
    brief = { name: level.name, text: level.brief };
    levelNames = level;
    currentLevelId = level.id;
    currentLevel = level;
    currentSelection = null;
    currentSolution = null;
    plannerState = createPlannerState();
    resetTrailSet(trailSet);
    resetWarp();
    resetEvents();
    ready = true;
    emit(null, true);
    return snap;
  }

  function load(args: LoadArgs): StateSnapshot {
    brief = null; // a raw Scenario carries no brief to show (tests/e2e/parity.spec.ts's path)
    const snap = session.load(args);
    currentDt = args.scenario.dt;
    postName = DASH; // a raw Scenario carries no body names to read a post from
    levelNames = EMPTY_LEVEL_NAMES;
    currentLevelId = null; // a raw Scenario has no level id, so no committed solution to find
    currentLevel = wrapScenarioAsLevel(args);
    currentSelection = null;
    currentSolution = null;
    plannerState = createPlannerState();
    resetTrailSet(trailSet);
    resetWarp();
    resetEvents();
    ready = true;
    emit(null, true);
    return snap;
  }

  function loadSolution(): void {
    if (currentLevelId === null) return;
    const solution = getSolution(currentLevelId);
    if (!solution) return;
    for (const command of solution.log) session.command(command);
    currentSolution = solution;
    emit();
  }

  /** `probe`'s predicted remaining-flight events (src/app/predict.ts), cached until the committed
   *  log grows (GRV-0027 design note: "cached per probe until the log changes") -- `session.log()`
   *  is mutated in place by `command` (never reassigned), so length is the change signal, not
   *  reference identity. */
  function predictedEventsFor(probe: number): SimEvent[] {
    if (!currentLevel) return [];
    const log = session.log();
    const cached = predictionCache.get(probe);
    if (cached && cached.atLogLength === log.length) return cached.events;

    const nowTick = session.state().tick;
    const events = predictProbe({
      level: currentLevel,
      log,
      probe,
      fromTick: nowTick,
      horizonTick: nowTick + GHOST_HORIZON_TICKS,
    });
    predictionCache.set(probe, { atLogLength: log.length, events });
    return events;
  }

  /** Every known future event tick, labelled (GRV-0027 design note: "committed log commands with
   *  tick > now ... and predictions for running probes"). The draft ghost's own events are *not*
   *  folded in here -- they already have their own `ghost.*` timeline marks (GRV-0026) and
   *  `nextEventTick` reads them directly, so this stays the two sources that have no other
   *  representation yet: future committed commands and running-probe predictions. */
  function upcomingEvents(): { tick: number; label: string }[] {
    if (!currentLevel) return [];
    const nowTick = session.state().tick;
    const results: { tick: number; label: string }[] = [];

    for (const command of session.log()) {
      if (command.tick <= nowTick) continue;
      results.push({ tick: command.tick, label: command.kind === 'launch' ? 'LAUNCH' : 'BURN' });
    }

    const snap = session.state();
    for (let i = 0; i < snap.objects.length; i++) {
      const obj = snap.objects[i]!;
      if (obj.hitBody !== -1 || obj.hitContact !== -1) continue; // expended, no more events
      for (const event of predictedEventsFor(i)) {
        if (event.tick > nowTick) results.push({ tick: event.tick, label: eventText(event) });
      }
    }

    return results;
  }

  function nextEventTick(): number | null {
    if (!currentLevel) return null;
    const nowTick = session.state().tick;
    let best: number | null = null;
    for (const { tick } of upcomingEvents()) if (best === null || tick < best) best = tick;
    if (plannerState.ghost) {
      for (const event of plannerState.ghost.events) {
        if (event.tick > nowTick && (best === null || event.tick < best)) best = event.tick;
      }
    }
    return best;
  }

  function timelineData(): TimelineData | null {
    if (!ready || currentDt === null) return null;
    const dt = currentDt;
    const snap = session.state();
    const marks: TimelineMark[] = [];
    (currentSolution?.log ?? []).forEach((command, index) => {
      if (command.kind === 'launch') {
        marks.push({
          key: `launch.${index}`,
          tick: command.tick,
          label: formatSimTime({ tick: command.tick, dt }),
        });
      }
    });
    snap.contacts.forEach((contact, index) => {
      if (contact.impactTick !== NO_IMPACT) {
        marks.push({
          key: `impact.${index}`,
          tick: contact.impactTick,
          label: formatSimTime({ tick: contact.impactTick, dt }),
        });
      }
    });

    // Ghost events (GRV-0026 acceptance): its own nodes, closest approach and impact, prefixed
    // "ghost." so they never collide with a committed solution's own launch/impact keys above --
    // a still-uncommitted draft targeting the same contact a prior probe already cleared is a real
    // case (a backup attempt), and the two must stay distinguishable.
    let rangeTicks = currentSolution?.ticks ?? Math.max(snap.tick, 1);
    const ghost = plannerState.ghost;
    if (ghost) {
      (plannerState.draft?.nodes ?? []).forEach((node, index) => {
        marks.push({
          key: `ghost.node.${index}`,
          tick: node.atTick,
          label: formatSimTime({ tick: node.atTick, dt }),
        });
      });
      for (const event of ghost.events) {
        if (event.kind === 'closestApproach') {
          marks.push({
            key: `ghost.closestApproach.${event.contact}`,
            tick: event.tick,
            label: formatSimTime({ tick: event.tick, dt }),
          });
        } else if (event.kind === 'impact') {
          marks.push({
            key: `ghost.impact.${event.contact}`,
            tick: event.tick,
            label: formatSimTime({ tick: event.tick, dt }),
          });
        }
      }
      rangeTicks = Math.max(rangeTicks, ghost.fromTick + ghost.samples.count);
    }

    // The unified event list (GRV-0027 design note "labels keyed timeline.event.<n>"): landed
    // events from the session's own log first (drawn full), then predicted upcoming ones
    // continuing the same index (drawn dim) -- one continuous sequence, not two separate keyspaces.
    eventLog.forEach((event, index) => {
      marks.push({ key: `event.${index}`, tick: event.tick, label: eventText(event), past: true });
      rangeTicks = Math.max(rangeTicks, event.tick);
    });
    upcomingEvents().forEach(({ tick, label }, index) => {
      marks.push({ key: `event.${eventLog.length + index}`, tick, label, past: false });
      rangeTicks = Math.max(rangeTicks, tick);
    });

    return {
      marks,
      cursor: { tick: snap.tick, label: formatSimTime({ tick: snap.tick, dt }) },
      rangeTicks,
    };
  }

  /** Advances the loaded session by `ticks`, sampling the observed trail and telemetry events
   *  once per tick (GRV-0030 -- extending trails.ts's own per-tick sampling point rather than
   *  adding a second loop) -- returns whether any event landed, for `step`'s own automatic-drop
   *  decision. Closest approach stays fed from live positions (events.ts's own module doc: it's a
   *  prediction, never a telemetry event). */
  function advanceAndAccumulateEvents(ticks: number): boolean {
    if (!currentLevel) return false;
    let landed = false;
    session.stepSampled({
      ticks,
      level: currentLevel,
      cache: observedCache,
      onTick: (positions, sample) => {
        sampleObservedTrailSet(
          trailSet,
          sample.observed.map((o) => o.observation),
        );
        currentObserved = sample.observed;

        const edges = diffObservedEvents({
          before: lastObserved,
          after: sample.observed,
          atTick: sample.tick,
        });
        if (edges.length > 0) landed = true;
        eventLog.push(...edges);
        // Carries the *last successful* observation forward through a blackout (GRV-0030: a
        // fixed contact's host rotating the post out of view for a while is real, and observing
        // an object again once it clears must never read as a fresh launch or re-fire an edge
        // against a reset baseline) -- an index whose new observation is null keeps its held
        // entry; one that resolved adopts the fresh state.
        sample.observed.forEach((obs, i) => {
          if (obs.observation) lastObserved[i] = obs;
        });

        for (let c = 0; c < sample.contacts.length; c++) {
          if (sample.contacts[c]!.cleared) continue;
          const contactPos = sample.contactPositions[c]!;
          for (let i = 0; i < sample.objects.length; i++) {
            const obj = sample.objects[i]!;
            if (obj.hitContact !== -1 || obj.hitBody !== -1) continue;
            const range = Math.hypot(
              positions[i]!.x - contactPos.x,
              positions[i]!.y - contactPos.y,
            );
            const key = `${i}:${c}`;
            const { trend, event } = sampleClosestApproach({
              prior: rangeTrends.get(key) ?? null,
              tick: sample.tick,
              probe: i,
              contact: c,
              range,
            });
            rangeTrends.set(key, trend);
            if (event) {
              eventLog.push(event);
              landed = true;
            }
          }
        }
      },
    });
    return landed;
  }

  /** The one place the loop advances (GRV-0027 design note). Clamps to an armed `warpToEvent`
   *  target so the caller's own per-frame budget is never exceeded even mid-warp (main.ts's real
   *  rAF loop calls this once per frame; the debug API's synchronous `warpToEvent` just calls it in
   *  a tight loop). Automatic drop: an event landing while the rung is above 1x drops it to 1x and
   *  arms one inverted frame (GAME-0002 §9) -- gated on "was above 1x" so reaching an event already
   *  at 1x (real-time play) doesn't flash. Reaching an armed target always drops to 1x, even on the
   *  rare tick whose only committed command doesn't itself produce a matching SimEvent. */
  function step(ticks: number): StateSnapshot {
    const before = session.state().tick;
    const effectiveTicks =
      warpTarget === null ? ticks : Math.max(0, Math.min(ticks, warpTarget - before));

    const landed = advanceAndAccumulateEvents(effectiveTicks);
    if (landed && rung > 1) {
      rung = 1;
      pendingInvert = true;
    }
    if (warpTarget !== null && session.state().tick >= warpTarget) {
      warpTarget = null;
      rung = 1;
    }

    // A draft whose launch tick the clock has now reached or passed is stale (GRV-0028, docs/
    // issues/2026-09-18-commit-plan-uses-stale-launch-tick.md): step is the one place time
    // advances, so re-snapping and revalidating it here -- the same reintegrate every other
    // planner mutator already runs -- keeps the ghost the player sees, and what commit would
    // actually do with it, from ever lagging behind the clock while a draft just sits there.
    if (plannerState.draft && plannerState.draft.launchTick <= session.state().tick) {
      reintegratePlan();
    }

    emit();
    return session.state();
  }

  function warpTo(tick: number): StateSnapshot {
    const current = session.state().tick;
    if (tick < current)
      throw new Error(`app: warpTo(${tick}) precedes the current tick ${current}`);
    warpTarget = null; // an explicit jump always overrides an in-flight warpToEvent
    return step(tick - current);
  }

  function setWarp(newRung: number): void {
    rung = clampRung(newRung);
    if (rung !== 0) lastNonZeroRung = rung;
    emit();
  }

  /** Arms the warp-to-event target and jumps to the top rung (GRV-0027 design note: "the loop
   *  advances toward it at the top rung's budget per frame") -- a no-op without a known upcoming
   *  event. Does not itself drain the warp; see the App interface doc.
   *
   *  `warpTarget` stores the sim *tick to stop at*, one past `nextEventTick()`'s own reported
   *  tick: sim.ts's `advance` applies a command, or runs the step that lands an edge event, while
   *  processing tick T, which only *completes* once `sim.tick` reaches T+1 -- stopping exactly at
   *  T (not T+1) would land one tick short of the event actually having happened. */
  function warpToEvent(): void {
    const target = nextEventTick();
    if (target === null) return;
    warpTarget = target + 1;
    setWarp(WARP_LADDER.length - 1);
  }

  /** Re-integrates the ghost from the current draft (src/app/planner.ts's own `reintegrate`) --
   *  a no-op if nothing is loaded. Every planner mutator below calls this synchronously so the
   *  debug API and real pointer input see the same up-to-date ghost the instant they return
   *  (design note's "synchronous in debug mode"); the UI layer's own rAF loop is what keeps a
   *  fast pointermove stream from calling the drag updaters more than once per frame. */
  function reintegratePlan(): void {
    if (!currentLevel) return;
    const nowTick = session.state().tick;
    plannerState = plannerReintegrate({
      state: plannerState,
      level: currentLevel,
      log: session.log(),
      nowTick,
      horizonTick: nowTick + GHOST_HORIZON_TICKS,
    });
  }

  /** `reintegrate`'s own `issues` (src/app/planner.ts, GRV-0028): validatePlan's shape issues, or
   *  a human-readable line naming checkLaunch's own rejection -- computed there, alongside the
   *  ghost, rather than re-derived here (rule 11: one source of truth per displayed number). */
  function planIssues(): string[] {
    return [...plannerState.issues];
  }

  /** Re-snaps and revalidates the draft first (`reintegratePlan`, same as every other planner
   *  mutator -- GRV-0028, docs/issues/2026-09-18-commit-plan-uses-stale-launch-tick.md): a draft
   *  left alone while time ran could otherwise still carry a launch tick the clock has already
   *  passed, and committing it as-is threw straight out of the session's own command validation,
   *  uncaught, while the Commit button stayed enabled. Never throws -- any remaining issue (the
   *  shape, the launch, or simply no draft at all) is returned instead, so the caller (main.ts's
   *  Commit handler) can show it in the PLAN panel rather than the console. What actually commits
   *  is `commands` built from the *exact* draft `reintegratePlan` just integrated -- what the
   *  ghost most recently showed is what launches (the "ghost invariant"). */
  function commitPlan(): { committed: true } | { committed: false; issues: string[] } {
    reintegratePlan();
    const issues = planIssues();
    if (issues.length > 0) {
      emit();
      return { committed: false, issues };
    }

    const draft = plannerState.draft;
    if (!draft) {
      emit();
      return { committed: false, issues: ['no draft to commit'] };
    }

    const probeIndex = session.state().count;
    session.commitPlan({ plan: draft, probeIndex });
    plannerState = plannerDiscardDraft(plannerState);
    emit();
    return { committed: true };
  }

  return {
    loadLevel,
    load,
    command: (cmd) => session.command(cmd),
    step,
    warpTo,
    setWarp,
    togglePause: () => setWarp(togglePauseRung(rung, lastNonZeroRung)),
    stepWarpRung: (direction) => setWarp(stepRung(rung, direction)),
    warpRung: () => rung,
    hash: () => session.hash(),
    state: () => session.state(),
    run: (args) => session.run(args),
    events: () => [...eventLog],
    nextEventTick,
    warpToEvent,
    warpTargetTick: () => warpTarget,
    takePendingInvert: () => {
      if (!pendingInvert) return false;
      pendingInvert = false;
      return true;
    },
    frame: () => {
      const t = plannerState.horizon === null ? undefined : plannerState.horizon * (currentDt ?? 0);
      return session.captureFrame(levelNames, currentObserved, t);
    },
    trails: () => {
      const points = new Map<number, readonly { x: number; y: number }[]>();
      trailSet.buffers.forEach((buffer, index) => points.set(index, trailPoints(buffer)));
      return points;
    },
    predictedTails: () => {
      const tails = new Map<number, readonly { x: number; y: number }[]>();
      currentObserved.forEach((view, index) => {
        if (view.observation) tails.set(index, [view.observation, ...view.tail]);
      });
      return tails;
    },
    observed: (index) => currentObserved[index] ?? null,
    delay: (selection) => session.delay(selection),
    select: (sel) => {
      currentSelection = sel;
      emit();
    },
    selection: () => currentSelection,
    selectionReadouts: () => session.describeSelection(levelNames, currentSelection),
    selectionName: () => selectionNameOf({ level: levelNames, selection: currentSelection }),
    loadSolution,
    solution: () => currentSolution,
    timelineData,

    plan: () => plannerState.draft,
    setPlan: (plan) => {
      plannerState = plannerSetPlan({ state: plannerState, plan });
      reintegratePlan();
      emit();
    },
    discardDraft: () => {
      plannerState = plannerDiscardDraft(plannerState);
      emit();
    },
    beginLaunchDrag: ({ rail, worldX, worldY }) => {
      plannerState = plannerBeginLaunchDrag({ state: plannerState, rail, worldX, worldY });
      emit();
    },
    updateLaunchDrag: ({ worldX, worldY, metresPerPixel }) => {
      if (!currentLevel) return;
      plannerState = plannerUpdateLaunchDrag({
        state: plannerState,
        level: currentLevel,
        worldX,
        worldY,
        tick: session.state().tick,
        metresPerPixel,
      });
      reintegratePlan();
      emit();
    },
    beginNodeDrag: ({ index, handle, worldX, worldY }) => {
      plannerState = plannerBeginNodeDrag({ state: plannerState, index, handle, worldX, worldY });
      emit();
    },
    updateNodeDrag: ({ worldX, worldY, metresPerPixel }) => {
      plannerState = plannerUpdateNodeDrag({ state: plannerState, worldX, worldY, metresPerPixel });
      reintegratePlan();
      emit();
    },
    endDrag: () => {
      plannerState = plannerEndDrag(plannerState);
      reintegratePlan();
      emit();
    },
    selectNode: (index) => {
      plannerState = plannerSelectNode({ state: plannerState, index });
      emit();
    },
    selectedNode: () => plannerState.selectedNode,
    drag: () => plannerState.drag,
    addNode: ({ tick }) => {
      if (!currentLevel) return;
      plannerState = plannerAddNode({ state: plannerState, level: currentLevel, tick });
      reintegratePlan();
      emit();
    },
    removeNode: ({ index }) => {
      plannerState = plannerRemoveNode({ state: plannerState, index });
      reintegratePlan();
      emit();
    },
    ghost: () => plannerState.ghost,
    planSolution: () =>
      plannerState.ghost && currentLevel
        ? solutionReadout({ ghost: plannerState.ghost, level: currentLevel })
        : null,
    planIssues,
    setHorizon: (tick) => {
      plannerState = plannerSetHorizon({ state: plannerState, tick });
      emit();
    },
    horizon: () => plannerState.horizon,
    commitPlan,
  };
}
