// The app's DOM-free core (GRV-0021): one loaded Sim plus level metadata and warp state, driven
// identically by main.ts's rAF loop and by the debug API. No DOM touches this file, so it's
// directly testable in Node -- rendering is an injected onChange callback main.ts wires to the
// real DOM; here it just records what would have been shown.
import { describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import type { AppChange } from './app.ts';
import type { Command, Scenario } from '../sim/sim.ts';

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
      status: { time: 'T+00:00:00:00', warp: '0x', warpEffective: '0x', post: '—', delay: '—' },
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
    expect(data.rangeTicks).toBe(5); // no solution loaded -> max(tick, 1)
    expect(data.marks).toEqual([]); // marks come from the *solution* log, not the raw command log
  });

  test('after loadSolution: a launch mark per command, range from the solution, plus impact marks', () => {
    const app = createApp({ onChange: () => {} });
    app.loadLevel('L01-intercept');
    app.loadSolution();
    const solution = app.solution()!;

    const beforeImpact = app.timelineData()!;
    expect(beforeImpact.marks).toHaveLength(1);
    expect(beforeImpact.marks[0]!.key).toBe('launch.0');
    expect(beforeImpact.marks[0]!.tick).toBe(solution.log[0]!.tick);
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
