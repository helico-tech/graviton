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

declare const __BUILD_SHA__: string;

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
  step(ticks: number): StateSnapshot;
  hash(): string;
  state(): StateSnapshot;
  /** Runs a fresh, independent `Sim` to completion and reports its hash and
   *  final tick -- the loaded session (if any) is untouched. */
  run(args: RunArgs): RunResult;
}

/** Plain-number copy of the live object and contact-state arrays: primitives,
 *  not references, so the result can't alias `sim.objects`/`sim.contactState`
 *  and a fresh array is built on every call (research §4: `state()` is
 *  read-only). */
function snapshot(sim: Sim): StateSnapshot {
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

  return { tick: sim.tick, count: o.count, objects, contacts };
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

    step(ticks) {
      const s = loaded();
      advance({ sim: s, log, ticks });
      return snapshot(s);
    },

    hash() {
      return hashSim(loaded());
    },

    state() {
      return snapshot(loaded());
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
  };
  window.graviton = api;

  void document.fonts.ready.then(() => {
    api.ready = true;
  });
}
