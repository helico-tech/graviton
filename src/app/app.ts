// The app's core state (GRV-0021): one loaded Sim (via a DebugSession, GRV-0011) plus the level
// metadata and warp state the status bar and plot region read from. DOM-free by design, like
// loop.ts and warp.ts, so it's directly testable in Node; main.ts's `onChange` callback is the
// only place that touches the real DOM, and the debug API (debug-api.ts) drives this exact same
// App so a headless driver and a human see identical state (ADR-0004 §1-2,
// docs/domain/simulation-determinism.md rule 10: this never writes simulation state itself,
// `advance` does -- it only reads what the session already computed).
import { createDebugSession } from './debug-api.ts';
import type { LoadArgs, RunArgs, RunResult, StateSnapshot } from './debug-api.ts';
import { getLevel, levelIds } from './levels.ts';
import type { CompiledLevel } from './levels.ts';
import { effectiveTicksThisFrame } from './loop.ts';
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
import { createTrailSet, resetTrailSet, sampleTrailSet, trailPoints } from './trails.ts';
import type { TrailSet } from './trails.ts';
import { clampRung, stepRung, ticksPerFrame, togglePause as togglePauseRung } from './warp.ts';
import type { WarpRung } from './warp.ts';
import { NO_IMPACT } from '../sim/contacts.ts';
import type { Command } from '../sim/sim.ts';
import type { Frame, FrameLevelNames } from '../render/frame.ts';
import { planToCommands, validatePlan } from '../planner/plan.ts';
import type { FlightPlan } from '../planner/plan.ts';
import type { Ghost } from '../planner/ghost.ts';
import { solutionReadout } from '../planner/readout.ts';
import type { SolutionReadout } from '../planner/readout.ts';

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
  /** A read-only render snapshot of the loaded session at its current tick (src/render/frame.ts);
   *  throws if nothing is loaded, like `state()`/`hash()`. */
  frame(): Frame;
  /** Every dynamic object's flown trail so far, keyed by object index (src/app/trails.ts) --
   *  sampled once per tick `step`/`warpTo` actually advanced, never derived. */
  trails(): ReadonlyMap<number, readonly { x: number; y: number }[]>;
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
  /** validatePlan's own issues (plan.ts: node budget, sortedness, integer-ness) plus, if the
   *  draft's launch is currently infeasible, a human-readable line naming checkLaunch's own
   *  rejection reason -- the PLAN panel's Commit button reads this to decide whether it is
   *  disabled and why (design note). `[]` when the draft is valid or there is none. */
  planIssues(): string[];
  /** `null` is "the present"; otherwise the tick `frame()` reads bodies/rails/contacts at (GAME-
   *  0001 §4.6 "horizon scrub"). Nothing in the simulation moves because of this. */
  setHorizon(tick: number | null): void;
  horizon(): number | null;
  /** Appends `planToCommands` (plan.ts) to the session log at the draft's own (already-future)
   *  launch tick and clears the draft (design note). Throws if there is no draft or it is
   *  currently invalid (`planIssues()` non-empty) -- mirrors `warpTo`'s own throw-on-misuse style
   *  rather than silently doing nothing. */
  commitPlan(): void;
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

  function statusValues(): StatusValues {
    if (!ready || currentDt === null) return NO_STATE;
    return {
      time: formatSimTime({ tick: session.state().tick, dt: currentDt }),
      warp: `${ticksPerFrame(rung)}x`,
      warpEffective: `${effectiveTicksThisFrame(rung)}x`,
      post: postName,
      delay: DASH,
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
      emit({ id, knownIds: levelIds() }, true);
      return undefined;
    }
    const snap = session.load({ scenario: level.scenario, seed: level.seed });
    currentDt = level.scenario.dt;
    const hostBody = level.scenario.rails[0]?.host;
    postName = hostBody === undefined ? DASH : (level.names.bodies[hostBody] ?? DASH);
    brief = { name: level.name, text: level.brief };
    levelNames = level;
    currentLevelId = level.id;
    currentLevel = level;
    currentSelection = null;
    currentSolution = null;
    plannerState = createPlannerState();
    resetTrailSet(trailSet);
    resetWarp();
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

    return {
      marks,
      cursor: { tick: snap.tick, label: formatSimTime({ tick: snap.tick, dt }) },
      rangeTicks,
    };
  }

  function step(ticks: number): StateSnapshot {
    const snap = session.stepSampled(ticks, (positions) => sampleTrailSet(trailSet, positions));
    emit();
    return snap;
  }

  function warpTo(tick: number): StateSnapshot {
    const current = session.state().tick;
    if (tick < current)
      throw new Error(`app: warpTo(${tick}) precedes the current tick ${current}`);
    return step(tick - current);
  }

  function setWarp(newRung: number): void {
    rung = clampRung(newRung);
    if (rung !== 0) lastNonZeroRung = rung;
    emit();
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

  function planIssues(): string[] {
    if (!plannerState.draft || !currentLevel) return [];
    const issues = validatePlan({ plan: plannerState.draft, level: currentLevel });
    if (plannerState.launchRejection)
      issues.push(`launch rejected: ${plannerState.launchRejection}`);
    return issues;
  }

  function commitPlan(): void {
    const draft = plannerState.draft;
    if (!draft) throw new Error('app: commitPlan called with no draft');
    const issues = planIssues();
    if (issues.length > 0)
      throw new Error(`app: commitPlan called on an invalid draft (${issues.join('; ')})`);

    const probeIndex = session.state().count;
    for (const command of planToCommands({ plan: draft, probeIndex })) session.command(command);
    plannerState = plannerDiscardDraft(plannerState);
    emit();
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
    frame: () => {
      const t = plannerState.horizon === null ? undefined : plannerState.horizon * (currentDt ?? 0);
      return session.captureFrame(levelNames, t);
    },
    trails: () => {
      const points = new Map<number, readonly { x: number; y: number }[]>();
      trailSet.buffers.forEach((buffer, index) => points.set(index, trailPoints(buffer)));
      return points;
    },
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
