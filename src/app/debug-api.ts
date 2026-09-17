// Debug automation API (docs/adr/2026-09-03-0004 §1, docs/work/
// GRV-0011): with `?debug=1` the page installs `window.graviton` so a
// headless driver can load a scenario, replay commands and read state with
// no renderer involved. Production pages never expose it -- no animation
// loop exists yet either way, so every call here is synchronous.
//
// `createDebugSession` is the pure, DOM-free session logic (one loaded `Sim`
// plus its append-only command log), independently testable; `installDebugApi`
// is the only part that touches `window`.

import { advance, createSim, hashSim } from '../sim/sim.ts';
import type { Command, Scenario, Sim } from '../sim/sim.ts';
import { SIM_VERSION } from '../sim/version.ts';

declare const __BUILD_SHA__: string;

export interface ObjectSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  hitBody: number;
  burning: number;
}

export interface StateSnapshot {
  tick: number;
  count: number;
  objects: ObjectSnapshot[];
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

/** Plain-number copy of the live object arrays: primitives, not references,
 *  so the result can't alias `sim.objects` and a fresh array is built on
 *  every call (research §4: `state()` is read-only). */
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
      burning: o.burning[i]!,
    });
  }
  return { tick: sim.tick, count: o.count, objects };
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

export interface DebugApi extends DebugSession {
  readonly version: { build: string; sim: number };
  /** True once `document.fonts.ready` has resolved (no animation loop to
   *  wait on otherwise). */
  ready: boolean;
  /** `window` `error` and `unhandledrejection` events since install. */
  errors: string[];
}

declare global {
  interface Window {
    graviton?: DebugApi;
  }
}

function debugRequested(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

/** Installs `window.graviton` only when the URL has `debug=1`; production
 *  pages never call this with the flag set, so the global never exists
 *  there. */
export function installDebugApi(): void {
  if (!debugRequested()) return;

  const errors: string[] = [];
  window.addEventListener('error', (event) => errors.push(`error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) =>
    errors.push(`unhandledrejection: ${String(event.reason)}`),
  );

  const session = createDebugSession();
  const api: DebugApi = {
    version: { build: __BUILD_SHA__, sim: SIM_VERSION },
    ready: false,
    errors,
    ...session,
  };
  window.graviton = api;

  void document.fonts.ready.then(() => {
    api.ready = true;
  });
}
