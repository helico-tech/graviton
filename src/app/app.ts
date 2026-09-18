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
import { effectiveTicksThisFrame } from './loop.ts';
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
      currentSelection = null;
      currentSolution = null;
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
    currentSelection = null;
    currentSolution = null;
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
    currentSelection = null;
    currentSolution = null;
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
    return {
      marks,
      cursor: { tick: snap.tick, label: formatSimTime({ tick: snap.tick, dt }) },
      rangeTicks: currentSolution?.ticks ?? Math.max(snap.tick, 1),
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
    frame: () => session.captureFrame(levelNames),
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
  };
}
