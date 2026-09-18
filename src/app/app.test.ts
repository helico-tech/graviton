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
