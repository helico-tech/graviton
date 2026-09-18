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
import { formatSimTime } from './time.ts';
import { clampRung, stepRung, ticksPerFrame, togglePause as togglePauseRung } from './warp.ts';
import type { WarpRung } from './warp.ts';
import type { Command } from '../sim/sim.ts';

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

export interface AppChange {
  status: StatusValues;
  plotError: PlotError | null;
  brief: Brief | null;
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

  function emit(plotError: PlotError | null = null): void {
    onChange({ status: statusValues(), plotError, brief });
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
      emit({ id, knownIds: levelIds() });
      return undefined;
    }
    const snap = session.load({ scenario: level.scenario, seed: level.seed });
    currentDt = level.scenario.dt;
    const hostBody = level.scenario.rails[0]?.host;
    postName = hostBody === undefined ? DASH : (level.names.bodies[hostBody] ?? DASH);
    brief = { name: level.name, text: level.brief };
    resetWarp();
    ready = true;
    emit();
    return snap;
  }

  function load(args: LoadArgs): StateSnapshot {
    brief = null; // a raw Scenario carries no brief to show (tests/e2e/parity.spec.ts's path)
    const snap = session.load(args);
    currentDt = args.scenario.dt;
    postName = DASH; // a raw Scenario carries no body names to read a post from
    resetWarp();
    ready = true;
    emit();
    return snap;
  }

  function step(ticks: number): StateSnapshot {
    const snap = session.step(ticks);
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
  };
}
