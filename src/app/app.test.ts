// The app's DOM-free core (GRV-0021): one loaded Sim plus level metadata and warp state, driven
// identically by main.ts's rAF loop and by the debug API. No DOM touches this file, so it's
// directly testable in Node -- rendering is an injected onChange callback main.ts wires to the
// real DOM; here it just records what would have been shown.
import { describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import type { App, AppChange } from './app.ts';
import { effectiveTicksThisFrame } from './loop.ts';
import type { Command, Scenario } from '../sim/sim.ts';
import type { FlightPlan } from '../planner/plan.ts';

const DT = 60;
const MU = 3.986004418e14;
const RADIUS = 6.371e6;

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    dt: DT,
    capacity: 4,
    burnNodeCapacity: 4,
    bodies: [{ parent: -1, mu: MU, radius: RADIUS, rotationPeriod: 1e9, axialPhaseAtEpoch: 0 }],
    rails: [
      {
        host: 0,
        longitude: 0,
        muzzleSpeedMin: 1,
        muzzleSpeedMax: 1_000_000,
        headingCone: Math.PI,
        reloadTicks: 0,
      },
    ],
    contacts: [],
    post: { host: 0, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: [],
    ...overrides,
  };
}

function launchCommand(
  overrides: Partial<{ tick: number; heading: number; speed: number }> = {},
): Command {
  return { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 8_000_000, ...overrides };
}

function recorder(): { changes: AppChange[]; onChange: (change: AppChange) => void } {
  const changes: AppChange[] = [];
  return { changes, onChange: (change) => changes.push(change) };
}

describe('createApp: raw scenario loads (the parity-spec path)', () => {
  test('load reports simulated time and a dash post name', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });

    app.load({ scenario: scenario(), seed: 1 });

    expect(changes.at(-1)).toEqual({
      status: {
        time: 'T+00:00:00:00',
        warp: '0x',
        warpEffective: '0x',
        post: '—',
        delay: '—',
        event: '—',
      },
      plotError: null,
      brief: null,
      justLoaded: true,
    });
  });

  test('step advances the readout time and re-renders synchronously', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });
    app.load({ scenario: scenario(), seed: 1 });

    app.step(2); // 2 ticks * 60 s = 120 s = 2 minutes

    expect(changes.at(-1)!.status.time).toBe('T+00:00:02:00');
  });
});

describe('createApp: warpTo', () => {
  test('advances to an absolute tick', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });

    const snap = app.warpTo(5);

    expect(snap.tick).toBe(5);
    expect(app.state().tick).toBe(5);
  });

  test('throws when the target tick precedes the current tick', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.step(10);

    expect(() => app.warpTo(5)).toThrow();
  });

  test('throws when nothing is loaded yet', () => {
    const app = createApp({ onChange: () => {} });
    expect(() => app.warpTo(5)).toThrow();
  });
});

describe('createApp: warp control', () => {
  test('setWarp clamps to the ladder and updates both warp readouts', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });
    app.load({ scenario: scenario(), seed: 1 });

    app.setWarp(99);

    expect(app.warpRung()).toBe(5);
    expect(changes.at(-1)!.status.warp).toBe('10000x');
    expect(changes.at(-1)!.status.warpEffective).toBe('700x'); // clamped by the frame budget
  });

  test('stepWarpRung moves one rung at a time', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });

    app.stepWarpRung(1);
    app.stepWarpRung(1);

    expect(app.warpRung()).toBe(2);
  });

  test('togglePause pauses and resumes at the last non-zero rung', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setWarp(3);

    app.togglePause();
    expect(app.warpRung()).toBe(0);

    app.togglePause();
    expect(app.warpRung()).toBe(3);
  });
});

describe('createApp: level loading', () => {
  test('loadLevel resolves a bundled level and derives the post name from the first rail host', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });

    const snap = app.loadLevel('L01-intercept');

    expect(snap?.tick).toBe(0);
    expect(changes.at(-1)!.plotError).toBeNull();
    expect(changes.at(-1)!.status.post).toBe('Meskel');
    expect(changes.at(-1)!.brief).toEqual({ name: 'Intercept', text: expect.any(String) });
  });

  test('an unknown level id reports a plot error, dashes the status, and does not throw', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });

    const snap = app.loadLevel('nope');

    expect(snap).toBeUndefined();
    expect(changes.at(-1)!.plotError).toEqual({
      id: 'nope',
      knownIds: expect.arrayContaining(['L01-intercept']),
    });
    expect(changes.at(-1)!.brief).toBeNull();
    expect(changes.at(-1)!.status).toEqual({
      time: '—',
      warp: '—',
      warpEffective: '—',
      post: '—',
      delay: '—',
      event: '—',
    });
  });

  test('a level loaded after a failed load clears the plot error', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });
    app.loadLevel('nope');

    app.loadLevel('L01-intercept');

    expect(changes.at(-1)!.plotError).toBeNull();
  });
});

describe('createApp: command and hash passthrough', () => {
  test('command queues onto the loaded session and step applies it', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });

    app.command(launchCommand());
    const snap = app.step(1);

    expect(snap.count).toBe(1);
  });

  test('run() does not disturb the loaded session', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    const before = app.hash();

    const result = app.run({ scenario: scenario(), seed: 2, log: [launchCommand()], ticks: 5 });

    expect(result.tick).toBe(5);
    expect(app.hash()).toBe(before);
  });
});

describe('createApp: frame() and trails()', () => {
  test('frame() throws before anything is loaded, like state()/hash()', () => {
    const app = createApp({ onChange: () => {} });
    expect(() => app.frame()).toThrow();
  });

  test('frame() reflects the loaded scenario at tick 0, with no objects yet', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });

    const frame = app.frame();

    expect(frame.tick).toBe(0);
    expect(frame.dt).toBe(DT);
    expect(frame.bodies).toHaveLength(1);
    expect(frame.objects).toEqual([]);
  });

  test('trails() gains one sampled point per tick stepped, for a launched object', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.command(launchCommand());

    app.step(5);

    const trails = app.trails();
    expect(trails.get(0)).toHaveLength(5);
  });

  test('loadLevel resets trails() so a previous run leaves nothing behind', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.command(launchCommand());
    app.step(5);
    expect(app.trails().get(0)).toHaveLength(5);

    app.loadLevel('L01-intercept');

    expect(app.trails().size).toBe(0);
  });
});

describe('createApp: selection', () => {
  test('starts null, select() sets it and re-renders synchronously', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });
    app.load({ scenario: scenario(), seed: 1 });
    const before = changes.length;

    expect(app.selection()).toBeNull();
    app.select({ kind: 'body', index: 0 });

    expect(app.selection()).toEqual({ kind: 'body', index: 0 });
    expect(changes.length).toBe(before + 1);
  });

  test('selectionReadouts reads the loaded session, not the frame', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.select({ kind: 'body', index: 0 });

    const rows = app.selectionReadouts();

    expect(rows.find((r) => r.key === 'class')?.value).toBe('Rock');
  });

  test('selectionReadouts() never throws, even after a failed loadLevel (regression: main.ts calls it from every onChange, including a failed load’s)', () => {
    const app = createApp({ onChange: () => {} });
    app.loadLevel('nope');

    expect(() => app.selectionReadouts()).not.toThrow();
    expect(app.selectionReadouts()).toEqual([]);
  });

  test('selectionReadouts() never throws before anything has ever been loaded', () => {
    const app = createApp({ onChange: () => {} });
    expect(() => app.selectionReadouts()).not.toThrow();
  });

  test('a fresh load clears the previous selection', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.select({ kind: 'body', index: 0 });

    app.load({ scenario: scenario(), seed: 1 });

    expect(app.selection()).toBeNull();
  });
});

describe('createApp: selectionName', () => {
  test('empty before anything is selected, the level id/name once one is', () => {
    const app = createApp({ onChange: () => {} });
    app.loadLevel('L01-intercept');
    expect(app.selectionName()).toBe('');

    app.select({ kind: 'body', index: 1 });
    expect(app.selectionName()).toBe('Meskel');
  });
});

describe('createApp: timelineData', () => {
  test('null before anything is loaded', () => {
    const app = createApp({ onChange: () => {} });
    expect(app.timelineData()).toBeNull();
  });

  test('a launch mark and the cursor, before any solution is loaded', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });

    app.command(launchCommand({ tick: 2 }));
    app.step(5);
    const data = app.timelineData()!;

    expect(data.cursor.tick).toBe(5);
    // No solution loaded -> the old launch.N/impact.N marks stay empty; the real launch that just
    // happened shows up as the new unified past event mark, and this scenario's own launch heading
    // sends the probe straight back into its home body -- predictProbe finds that too, as an
    // upcoming event, and rangeTicks stretches to cover it (GRV-0027).
    expect(data.marks).toEqual([
      { key: 'event.0', tick: 2, label: 'LAUNCH PRB-01', past: true },
      { key: 'event.1', tick: 74, label: 'IMPACT PRB-01 → BODY-0', past: false },
    ]);
    expect(data.rangeTicks).toBe(74);
  });

  test('after loadSolution: a launch mark per command, range from the solution, plus impact marks', () => {
    const app = createApp({ onChange: () => {} });
    app.loadLevel('L01-intercept');
    app.loadSolution();
    const solution = app.solution()!;

    const beforeImpact = app.timelineData()!;
    // The old launch.N mark (from the committed solution log) plus the new unified upcoming-event
    // mark for that same not-yet-reached launch command (GRV-0027) -- distinct keyspaces, both present.
    expect(beforeImpact.marks).toHaveLength(2);
    expect(beforeImpact.marks[0]!.key).toBe('launch.0');
    expect(beforeImpact.marks[0]!.tick).toBe(solution.log[0]!.tick);
    const upcoming = beforeImpact.marks.find((m) => m.key === 'event.0')!;
    expect(upcoming).toEqual({
      key: 'event.0',
      tick: solution.log[0]!.tick,
      label: 'LAUNCH',
      past: false,
    });
    expect(beforeImpact.rangeTicks).toBe(solution.ticks);

    app.warpTo(solution.ticks);
    const afterImpact = app.timelineData()!;
    expect(afterImpact.marks.some((m) => m.key === 'impact.0')).toBe(true);
    expect(afterImpact.cursor.tick).toBe(solution.ticks);
  });
});

describe('createApp: loadSolution', () => {
  test('applies L01-intercept’s committed solution log and exposes it', () => {
    const app = createApp({ onChange: () => {} });
    app.loadLevel('L01-intercept');
    expect(app.solution()).toBeNull();

    app.loadSolution();

    expect(app.solution()?.log.length).toBeGreaterThan(0);
    const snap = app.warpTo(app.solution()!.ticks);
    expect(snap.count).toBe(1); // the solution's one launch actually applied
  });

  test('is a no-op before anything is loaded', () => {
    const app = createApp({ onChange: () => {} });
    expect(() => app.loadSolution()).not.toThrow();
    expect(app.solution()).toBeNull();
  });

  test('is a no-op for a raw scenario, which has no level id', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    expect(() => app.loadSolution()).not.toThrow();
    expect(app.solution()).toBeNull();
  });
});

describe('createApp: AppChange.justLoaded', () => {
  test('is true for load() and loadLevel(), including a failed loadLevel', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });

    app.load({ scenario: scenario(), seed: 1 });
    expect(changes.at(-1)!.justLoaded).toBe(true);

    app.loadLevel('L01-intercept');
    expect(changes.at(-1)!.justLoaded).toBe(true);

    app.loadLevel('nope');
    expect(changes.at(-1)!.justLoaded).toBe(true);
  });

  test('is false for step() and setWarp(), which must never move the camera on their own', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });
    app.load({ scenario: scenario(), seed: 1 });

    app.step(1);
    expect(changes.at(-1)!.justLoaded).toBe(false);

    app.setWarp(2);
    expect(changes.at(-1)!.justLoaded).toBe(false);
  });
});

/** Drives an armed `warpToEvent` target to completion a frame's own budget at a time -- the
 *  synchronous drain main.ts's debug API wraps `App.warpToEvent` with (design note: "debug
 *  warpToEvent() ... advances to the target in one call"). Guarded against ever looping forever:
 *  `step` always makes progress toward an armed target (GRV-0027's own step() doc). */
function drainWarpToEvent(app: App): void {
  app.warpToEvent();
  let guard = 0;
  while (app.warpTargetTick() !== null) {
    app.step(effectiveTicksThisFrame(app.warpRung()));
    if (++guard > 10_000) throw new Error('drainWarpToEvent: exceeded guard iterations');
  }
}

describe('createApp: events (GRV-0027)', () => {
  test('events() starts empty and returns a copy', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });

    const events = app.events();
    expect(events).toEqual([]);
    (events as unknown[]).push('mutated');
    expect(app.events()).toEqual([]); // the mutation above never touched the app's own log
  });

  test('a launch lands in the event log with the terse status text', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });
    app.load({ scenario: scenario(), seed: 1 });

    app.command(launchCommand({ tick: 0 }));
    app.step(1);

    expect(app.events()).toEqual([{ tick: 0, kind: 'launch', probe: 0 }]);
    expect(changes.at(-1)!.status.event).toBe('LAUNCH PRB-01');
  });

  test('an impact that also clears the contact announces IMPACT, the more salient of the two same-tick events', () => {
    const { changes, onChange } = recorder();
    const app = createApp({ onChange });
    app.loadLevel('L01-intercept');
    app.loadSolution();

    app.warpTo(3299); // one past L01-intercept.evidence.json's own recorded impact tick (3298)

    expect(app.events()).toContainEqual({ tick: 3298, kind: 'impact', probe: 0, contact: 0 });
    expect(app.events()).toContainEqual({ tick: 3298, kind: 'cleared', contact: 0 });
    expect(changes.at(-1)!.status.event).toBe('IMPACT PRB-01 → DRIFT-HULK');
  });

  test('the log resets on a fresh load', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.command(launchCommand({ tick: 0 }));
    app.step(1);
    expect(app.events().length).toBeGreaterThan(0);

    app.load({ scenario: scenario(), seed: 1 });

    expect(app.events()).toEqual([]);
  });
});

describe('createApp: automatic drop to 1x (GRV-0027, GAME-0001 §4.11)', () => {
  test('an event landing while above 1x drops the rung to 1 and arms exactly one inverted frame', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setWarp(3); // 100x
    app.command(launchCommand({ tick: 0 }));

    app.step(1); // the launch lands this step

    expect(app.warpRung()).toBe(1);
    expect(app.takePendingInvert()).toBe(true);
    expect(app.takePendingInvert()).toBe(false); // consumed -- exactly one frame
  });

  test('an event landing already at 1x does not flash the invert (real-time play)', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setWarp(1);
    app.command(launchCommand({ tick: 0 }));

    app.step(1);

    expect(app.warpRung()).toBe(1);
    expect(app.takePendingInvert()).toBe(false);
  });

  test('a step with no event landing leaves the rung and invert flag alone', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setWarp(3);

    app.step(1);

    expect(app.warpRung()).toBe(3);
    expect(app.takePendingInvert()).toBe(false);
  });
});

describe('createApp: nextEventTick/warpToEvent (GRV-0027)', () => {
  test('nextEventTick is null with nothing loaded or nothing known', () => {
    const app = createApp({ onChange: () => {} });
    expect(app.nextEventTick()).toBeNull();

    app.load({ scenario: scenario(), seed: 1 });
    expect(app.nextEventTick()).toBeNull();
  });

  test('finds a committed future launch command', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.command(launchCommand({ tick: 10 }));

    expect(app.nextEventTick()).toBe(10);
  });

  test('warpToEvent is a no-op without a known upcoming event', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    const rungBefore = app.warpRung();

    app.warpToEvent();

    expect(app.warpRung()).toBe(rungBefore);
    expect(app.warpTargetTick()).toBeNull();
  });

  test('warpToEvent jumps to the top rung and arms a target one past the event tick; step clamps to it and drops to 1x on arrival', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.command(launchCommand({ tick: 10 }));

    app.warpToEvent();
    expect(app.warpRung()).toBe(5); // WARP_LADDER's top rung
    expect(app.warpTargetTick()).toBe(11); // one past tick 10 -- sim.ts's advance() applies a
    // tick-10 command *while processing* tick 10, which only completes once sim.tick reaches 11.

    app.step(700); // a real frame's own budget -- far more than needed to reach the target
    expect(app.state().tick).toBe(11); // never overshoots
    expect(app.warpTargetTick()).toBeNull();
    expect(app.warpRung()).toBe(1);
    expect(app.events()).toEqual([{ tick: 10, kind: 'launch', probe: 0 }]);
  });

  test('warpToEvent on the real L01 solution reaches launch, then impact, in order, one frame budget at a time', () => {
    const app = createApp({ onChange: () => {} });
    app.loadLevel('L01-intercept');
    app.loadSolution();

    drainWarpToEvent(app);
    expect(app.state().tick).toBe(2465); // one past the solution's own launch tick (2464)
    expect(app.warpRung()).toBe(1);
    expect(app.events()).toEqual([{ tick: 2464, kind: 'launch', probe: 0 }]);

    drainWarpToEvent(app);
    expect(app.state().tick).toBe(3299); // one past the recorded impact tick (3298)
    expect(app.warpRung()).toBe(1);
    expect(app.events()).toContainEqual({ tick: 3298, kind: 'impact', probe: 0, contact: 0 });
  });

  test('an explicit warpTo cancels an in-flight warpToEvent target', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.command(launchCommand({ tick: 500 }));
    app.warpToEvent();
    expect(app.warpTargetTick()).toBe(501);

    app.warpTo(5);

    expect(app.warpTargetTick()).toBeNull();
    expect(app.state().tick).toBe(5);
  });
});

// GRV-0028 review fixes: docs/issues/2026-09-18-commit-plan-uses-stale-launch-tick.md and
// docs/issues/2026-09-18-reintegrate-skips-validate-plan.md.
function eastPlan(overrides: Partial<FlightPlan> = {}): FlightPlan {
  return { rail: 0, launchTick: 1, heading: 0, speed: 8_000_000, nodes: [], ...overrides };
}

describe('createApp: step re-snaps a stale draft (GRV-0028)', () => {
  test('a draft whose launch tick the clock reaches is re-snapped to now + 1 and reintegrated', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setPlan(eastPlan());
    expect(app.plan()!.launchTick).toBe(1);

    app.step(5);

    expect(app.plan()!.launchTick).toBe(6);
    expect(app.ghost()).not.toBeNull();
    expect(app.planIssues()).toEqual([]);
  });

  test('a node that ends up before the re-snapped launch tick is reported as an issue, not dropped', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setPlan(eastPlan({ nodes: [{ atTick: 3, prograde: 1, lateral: 0 }] }));
    expect(app.planIssues()).toEqual([]); // node at 3 is fine against launchTick 1, for now

    app.step(5); // the clock reaches 5; the launch re-snaps to 6, past the node's own atTick (3)

    expect(app.plan()!.launchTick).toBe(6);
    expect(app.ghost()).toBeNull();
    expect(app.planIssues()).toEqual(['node 0: atTick (3) must be later than launchTick (6)']);
  });

  test('a fresh draft well ahead of the clock is left untouched', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setPlan(eastPlan({ launchTick: 100 }));

    app.step(5);

    expect(app.plan()!.launchTick).toBe(100);
  });
});

describe('createApp: commitPlan never throws (GRV-0028)', () => {
  test('a draft left alone while time passes its launch tick still commits, with the re-snapped tick', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setPlan(eastPlan()); // launchTick 1

    app.step(5); // time runs while the draft sits there, well past its own launch tick

    const result = app.commitPlan();

    expect(result).toEqual({ committed: true });
    expect(app.plan()).toBeNull();

    app.step(2); // reach tick 6, the re-snapped launch tick, for the command to actually apply
    expect(app.state().count).toBe(1);
  });

  test('an invalid draft (launch rejected: capacity) returns its issues instead of throwing', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario({ capacity: 1 }), seed: 1 });
    app.command(launchCommand({ tick: 0 })); // fills the rail's one and only probe slot
    app.step(1);
    expect(app.state().count).toBe(1);

    app.setPlan(eastPlan({ launchTick: 2 }));
    expect(app.planIssues()).toEqual(['launch rejected: capacity']);

    let result: ReturnType<App['commitPlan']> | undefined;
    expect(() => {
      result = app.commitPlan();
    }).not.toThrow();

    expect(result).toEqual({ committed: false, issues: ['launch rejected: capacity'] });
    expect(app.plan()).not.toBeNull(); // the draft is kept, not silently discarded
  });

  test('no draft to commit reports an issue rather than throwing', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });

    const result = app.commitPlan();

    expect(result.committed).toBe(false);
  });
});

describe('createApp: endDrag reintegrates too (GRV-0028)', () => {
  test('ending a drag leaves the ghost/issues consistent with the released draft', () => {
    const app = createApp({ onChange: () => {} });
    app.load({ scenario: scenario(), seed: 1 });
    app.setPlan(eastPlan());
    app.step(5); // launchTick snaps to 6

    app.beginLaunchDrag({ rail: 0, worldX: RADIUS, worldY: 0 });
    app.endDrag(); // released without ever calling updateLaunchDrag -- a click, not a drag

    expect(app.plan()!.launchTick).toBe(6);
    expect(app.ghost()).not.toBeNull();
    expect(app.planIssues()).toEqual([]);
  });
});
