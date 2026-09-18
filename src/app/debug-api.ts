// Debug automation API (docs/adr/2026-09-03-0004 §1, docs/work/
// GRV-0011, GRV-0021): with `?debug=1` the page installs `window.graviton` so a
// headless driver can load a level or a scenario, replay commands, warp to a
// tick and read state and rendered readouts with no animation loop involved.
// Production pages never expose it.
//
// `createDebugSession` is the pure, DOM-free session logic (one loaded `Sim`
// plus its append-only command log), independently testable; `installDebugApi`
// wraps a `DebugApiDriver` (GRV-0021's `App`, see app.ts) to add level-id
// loading, warping to an absolute tick and reading `[data-readout]` text, and
// is the only part of this module that touches `window`.

import { advance, createSim, hashSim } from '../sim/sim.ts';
import type { Command, Scenario, Sim } from '../sim/sim.ts';
import { SIM_VERSION } from '../sim/version.ts';
import { readAllReadouts } from '../ui/readouts.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import { captureFrame as captureFrameOf } from '../render/frame.ts';
import type { Frame, FrameLevelNames } from '../render/frame.ts';
import type { View } from '../render/camera.ts';
import { describeSelection as describeSelectionOf } from './selection.ts';
import type { ReadoutRow, Selection } from './selection.ts';
import type { FlightPlan } from '../planner/plan.ts';
import type { SolutionReadout } from '../planner/readout.ts';

declare const __BUILD_SHA__: string;

export interface BodySnapshot {
  x: number;
  y: number;
}

export interface ObjectSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  hitBody: number;
  hitContact: number;
  burning: number;
}

export interface ContactSnapshot {
  cleared: number;
  impactTick: number;
  impactSpeed: number;
  impactEnergy: number;
}

export interface StateSnapshot {
  tick: number;
  count: number;
  /** Every body's current world position (GRV-0023): unlike objects/contacts, bodies are on
   *  published orbits and always shown at their true current position (determinism rule 12), so
   *  there is no signal-delay reason to withhold this -- a headless driver needs it to compute a
   *  click's screen coordinates without duplicating captureFrame's ephemeris evaluation. */
  bodies: BodySnapshot[];
  objects: ObjectSnapshot[];
  contacts: ContactSnapshot[];
}

export interface LoadArgs {
  scenario: Scenario;
  seed: number;
}

export interface RunArgs {
  scenario: Scenario;
  seed: number;
  log: Command[];
  ticks: number;
}

export interface RunResult {
  hash: string;
  tick: number;
}

export interface DebugSession {
  load(args: LoadArgs): StateSnapshot;
  /** Appends to the loaded session's log, exactly as the UI would. Throws if
   *  `cmd.tick` precedes the current tick (the sim's own clock, or a
   *  later-ticked command already queued) -- the log must stay sorted by
   *  tick (sim.ts's `validateLogSorted`), and a command behind the sim's
   *  clock would silently never be applied (`advance`'s cursor never looks
   *  back), so this is caught here rather than surfacing later as a
   *  dropped command. */
  command(cmd: Command): void;
  /** The committed log exactly as `advance` would replay it (GRV-0026): the planner's own
   *  reintegration (src/app/planner.ts's `reintegrate`) needs it to reproduce the world up to a
   *  draft's launch tick, the same way `integrateGhost` itself replays "everything already
   *  committed". Read-only by contract (`readonly Command[]`), the live array by reference -- like
   *  `state()`'s snapshot, callers never see `Sim` itself, only plain data it already owns. */
  log(): readonly Command[];
  step(ticks: number): StateSnapshot;
  /** `step`, but advancing one tick at a time and calling `onTick` with every live object's
   *  position after each tick -- the shared "tick-advance-with-trails" loop app.ts and
   *  src/headless/render.ts both drive (GRV-0022 design), so a trail is sampled once per
   *  simulation tick regardless of how many ticks a single call advances (a warp frame stepping
   *  hundreds of ticks still samples every one of them, just more cheaply than a full
   *  `StateSnapshot` copy per tick would). */
  stepSampled(
    ticks: number,
    onTick: (positions: readonly { x: number; y: number }[]) => void,
  ): StateSnapshot;
  hash(): string;
  state(): StateSnapshot;
  /** A read-only render snapshot of the loaded `Sim` (src/render/frame.ts) -- the one place
   *  outside `src/render` a live `Sim` is read for drawing; `Sim` itself never leaves this module.
   *  `t`, if given, is the horizon scrub's own override (GRV-0026, captureFrame's own doc). */
  captureFrame(level: FrameLevelNames, t?: number): Frame;
  /** Every selection-panel field for `selection`, computed straight from the loaded `Sim`
   *  (src/app/selection.ts's `describeSelection`, GRV-0023) -- mirrors `captureFrame`'s boundary:
   *  the one place outside `src/render` (this module) a live `Sim` is read, `Sim` itself never
   *  leaves it. */
  describeSelection(level: FrameLevelNames, selection: Selection): ReadoutRow[];
  /** Runs a fresh, independent `Sim` to completion and reports its hash and
   *  final tick -- the loaded session (if any) is untouched. */
  run(args: RunArgs): RunResult;
}

/** Plain-number copy of the live object and contact-state arrays: primitives,
 *  not references, so the result can't alias `sim.objects`/`sim.contactState`
 *  and a fresh array is built on every call (research §4: `state()` is
 *  read-only). */
function snapshot(sim: Sim): StateSnapshot {
  const eph = {
    x: new Float64Array(sim.bodies.count),
    y: new Float64Array(sim.bodies.count),
    vx: new Float64Array(sim.bodies.count),
    vy: new Float64Array(sim.bodies.count),
  };
  evaluateEphemeris(sim.bodies, sim.tick * sim.scenario.dt, eph);
  const bodies: BodySnapshot[] = [];
  for (let i = 0; i < sim.bodies.count; i++) bodies.push({ x: eph.x[i]!, y: eph.y[i]! });

  const o = sim.objects;
  const objects: ObjectSnapshot[] = [];
  for (let i = 0; i < o.count; i++) {
    objects.push({
      x: o.x[i]!,
      y: o.y[i]!,
      vx: o.vx[i]!,
      vy: o.vy[i]!,
      mass: o.mass[i]!,
      hitBody: o.hitBody[i]!,
      hitContact: o.hitContact[i]!,
      burning: o.burning[i]!,
    });
  }

  const cs = sim.contactState;
  const contacts: ContactSnapshot[] = [];
  for (let i = 0; i < sim.contacts.count; i++) {
    contacts.push({
      cleared: cs.cleared[i]!,
      impactTick: cs.impactTick[i]!,
      impactSpeed: cs.impactSpeed[i]!,
      impactEnergy: cs.impactEnergy[i]!,
    });
  }

  return { tick: sim.tick, count: o.count, bodies, objects, contacts };
}

export function createDebugSession(): DebugSession {
  let sim: Sim | null = null;
  let log: Command[] = [];

  function loaded(): Sim {
    if (!sim) throw new Error('debug session: no scenario loaded');
    return sim;
  }

  return {
    load({ scenario, seed }) {
      sim = createSim({ scenario, seed });
      log = [];
      return snapshot(sim);
    },

    command(cmd) {
      const s = loaded();
      const currentTick = Math.max(s.tick, log.at(-1)?.tick ?? s.tick);
      if (cmd.tick < currentTick) {
        throw new Error(
          `debug session: command tick ${cmd.tick} precedes current tick ${currentTick}`,
        );
      }
      log.push(cmd);
    },

    log: () => log,

    step(ticks) {
      const s = loaded();
      advance({ sim: s, log, ticks });
      return snapshot(s);
    },

    stepSampled(ticks, onTick) {
      const s = loaded();
      for (let i = 0; i < ticks; i++) {
        advance({ sim: s, log, ticks: 1 });
        const o = s.objects;
        const positions: { x: number; y: number }[] = new Array(o.count);
        for (let j = 0; j < o.count; j++) positions[j] = { x: o.x[j]!, y: o.y[j]! };
        onTick(positions);
      }
      return snapshot(s);
    },

    hash() {
      return hashSim(loaded());
    },

    state() {
      return snapshot(loaded());
    },

    captureFrame(level, t) {
      return captureFrameOf({ sim: loaded(), level, t });
    },

    describeSelection(level, selection) {
      // A null selection never needs the loaded sim (describeSelectionOf's own contract, see
      // selection.ts) -- checked here too, rather than only inside the pure function, so this
      // stays answerable before anything is loaded (app.ts's selectionReadouts() calls it on
      // every render, including a failed loadLevel's, where `loaded()` below would throw).
      if (!selection) return [];
      return describeSelectionOf({ sim: loaded(), level, selection });
    },

    run({ scenario, seed, log: runLog, ticks }) {
      const fresh = createSim({ scenario, seed });
      advance({ sim: fresh, log: runLog, ticks });
      return { hash: hashSim(fresh), tick: fresh.tick };
    },
  };
}

/** The subset of GRV-0021's `App` the debug API drives -- declared here rather than imported so
 *  this module never imports app.ts (app.ts imports `createDebugSession` from here; importing
 *  back would be a cycle). Structural typing means the real `App` satisfies this with no
 *  declaration on its side. */
export interface DebugApiDriver {
  loadLevel(id: string): StateSnapshot | undefined;
  load(args: LoadArgs): StateSnapshot;
  command(cmd: Command): void;
  step(ticks: number): StateSnapshot;
  warpTo(tick: number): StateSnapshot;
  setWarp(rung: number): void;
  hash(): string;
  state(): StateSnapshot;
  run(args: RunArgs): RunResult;
  /** One synchronous frame of the plot at the current state (GRV-0022, ADR-0004 §1): draws, does
   *  not advance anything. Implemented in main.ts by composing the DOM-free `App` above with
   *  src/ui/plot.ts's canvas-owning controller -- `App` itself stays DOM-free. */
  render(): void;
  /** FNV-1a over the plot canvas's RGBA bytes (src/sim/state/hash.ts), comparable only under one
   *  renderer key (research §3: Playwright's Chromium and `@napi-rs/canvas` draw 7% of pixels
   *  differently). */
  frameHash(): string;
  view(): View;
  setView(patch: Partial<View>): void;
  select(selection: Selection): void;
  selection(): Selection;
  /** Applies the loaded level's committed solution log to the session (GRV-0023), the same way
   *  `?solution=1` does. A no-op if nothing is loaded or the level has no committed solution. */
  loadSolution(): void;
  // -- Planner (GRV-0026) -- App's own plan()/setPlan()/commitPlan()/setHorizon() reused verbatim;
  // `planSolution` is named to avoid colliding with App's own `solution()` (the committed campaign
  // solution log above), and is exposed here as `solution` to match the debug API's own naming.
  plan(): FlightPlan | null;
  setPlan(plan: FlightPlan): void;
  commitPlan(): void;
  setHorizon(tick: number | null): void;
  planSolution(): SolutionReadout | null;
}

export interface DebugApi {
  readonly version: { build: string; sim: number };
  /** True once `document.fonts.ready` has resolved AND the initial level named by the URL has
   *  been loaded (docs/work/GRV-0021). main.ts always finishes that load, success or handled
   *  error, before calling `installDebugApi` -- both synchronous -- so by construction the load
   *  is already done whenever this later resolves; stated as its own condition anyway so a future
   *  asynchronous load can't silently drop it. */
  ready: boolean;
  /** `window` `error` and `unhandledrejection` events since install. */
  errors: string[];
  /** A level id loads the bundled level (GRV-0021); the existing `{ scenario, seed }` form loads
   *  a raw scenario directly, as tests/e2e/parity.spec.ts's golden replays do. An unknown level id
   *  never throws -- it reports a handled error state (readouts()/plotError) instead. */
  load(args: LoadArgs | string): StateSnapshot | undefined;
  command(cmd: Command): void;
  step(ticks: number): StateSnapshot;
  /** Advances to an absolute tick; throws if it precedes the current tick. */
  warpTo(tick: number): StateSnapshot;
  setWarp(rung: number): void;
  hash(): string;
  state(): StateSnapshot;
  /** Runs a fresh, independent `Sim` to completion; the loaded session is untouched. */
  run(args: RunArgs): RunResult;
  /** Every `[data-readout]` element's text, keyed by its `data-readout` attribute (ADR-0004 §2):
   *  reads the live DOM, not app-internal state, so a broken panel fails this even when the
   *  simulation underneath is correct. */
  readouts(): Record<string, string>;
  render(): void;
  frameHash(): string;
  /** A copy of the plot's current camera state -- mutating it does nothing (GRV-0022 acceptance
   *  "view() returns a copy"); call `setView` to change it. */
  view(): View;
  setView(patch: Partial<View>): void;
  select(selection: Selection): void;
  selection(): Selection;
  loadSolution(): void;
  // -- Planner (GRV-0026, docs/work/GRV-0026-planner-overlay.md's own debug-API list).
  plan(): FlightPlan | null;
  setPlan(plan: FlightPlan): void;
  commitPlan(): void;
  setHorizon(tick: number | null): void;
  /** The current draft's ghost solution readout (src/planner/readout.ts) -- `null` without a
   *  draft, a ghost, or a currently feasible launch. */
  solution(): SolutionReadout | null;
}

declare global {
  interface Window {
    graviton?: DebugApi;
  }
}

function debugRequested(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

/** Installs `window.graviton` only when the URL has `debug=1`; production pages never call this
 *  with the flag set, so the global never exists there. Takes the already-bootstrapped driver
 *  (main.ts's `App`, loaded before this is called) rather than creating its own, so a headless
 *  driver and a human see the exact same state and the exact same render path. */
export function installDebugApi(driver: DebugApiDriver): void {
  if (!debugRequested()) return;

  const errors: string[] = [];
  window.addEventListener('error', (event) => errors.push(`error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) =>
    errors.push(`unhandledrejection: ${String(event.reason)}`),
  );

  const api: DebugApi = {
    version: { build: __BUILD_SHA__, sim: SIM_VERSION },
    ready: false,
    errors,
    load: (args) => (typeof args === 'string' ? driver.loadLevel(args) : driver.load(args)),
    command: (cmd) => driver.command(cmd),
    step: (ticks) => driver.step(ticks),
    warpTo: (tick) => driver.warpTo(tick),
    setWarp: (rung) => driver.setWarp(rung),
    hash: () => driver.hash(),
    state: () => driver.state(),
    run: (args) => driver.run(args),
    readouts: () => readAllReadouts(document),
    render: () => driver.render(),
    frameHash: () => driver.frameHash(),
    view: () => driver.view(),
    setView: (patch) => driver.setView(patch),
    select: (selection) => driver.select(selection),
    selection: () => driver.selection(),
    loadSolution: () => driver.loadSolution(),
    plan: () => driver.plan(),
    setPlan: (plan) => driver.setPlan(plan),
    commitPlan: () => driver.commitPlan(),
    setHorizon: (tick) => driver.setHorizon(tick),
    solution: () => driver.planSolution(),
  };
  window.graviton = api;

  void document.fonts.ready.then(() => {
    api.ready = true;
  });
}
