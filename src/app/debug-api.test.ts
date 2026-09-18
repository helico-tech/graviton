// Tests for the DOM-free session logic behind the debug API (docs/work/
// GRV-0011): command ordering, state() copy semantics, and run()'s
// independence from the loaded session. installDebugApi's window wiring
// needs a real page and is covered by tests/e2e/parity.spec.ts instead.
import { describe, expect, test } from 'vitest';
import { createDebugSession } from './debug-api.ts';
import type { Command, Scenario } from '../sim/sim.ts';

const DT = 60;
const MU = 3.986004418e14; // Earth-like
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
    streams: ['debris_ejection'],
    ...overrides,
  };
}

function launchCommand(
  overrides: Partial<{ tick: number; heading: number; speed: number }> = {},
): Command {
  return { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 8_000_000, ...overrides };
}

function burnCommand(
  overrides: Partial<{ tick: number; atTick: number; prograde: number; lateral: number }> = {},
): Command {
  return { tick: 0, kind: 'burn', probe: 0, atTick: 1, prograde: 1000, lateral: 0, ...overrides };
}

describe('createDebugSession', () => {
  test('command throws before a scenario is loaded', () => {
    const session = createDebugSession();
    expect(() => session.command(launchCommand())).toThrow();
  });

  test('command throws when cmd.tick precedes the current sim tick', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    session.command(launchCommand());
    session.step(10); // sim.tick is now 10

    expect(() => session.command(burnCommand({ tick: 5, atTick: 6 }))).toThrow();
  });

  test('command throws when cmd.tick precedes an already-queued later command', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    session.command(launchCommand());
    session.command(burnCommand({ tick: 20, atTick: 25 }));

    expect(() => session.command(burnCommand({ tick: 10, atTick: 15 }))).toThrow();
  });

  test('command at exactly the current tick is accepted', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    expect(() => session.command(launchCommand({ tick: 0 }))).not.toThrow();
  });

  test('state() carries one body position per scenario body (GRV-0023: for a headless click driver)', () => {
    const session = createDebugSession();
    const loaded = session.load({ scenario: scenario(), seed: 1 });

    expect(loaded.bodies).toHaveLength(1);
    expect(loaded.bodies[0]).toEqual({ x: 0, y: 0 }); // the sole body here is the primary, at the origin
  });

  test('state() is a read-only copy, not the live arrays', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    session.command(launchCommand());
    const before = session.step(1);

    before.objects[0]!.x = -1; // mutate the returned snapshot
    const after = session.state();

    expect(after.tick).toBe(1);
    expect(after.objects[0]!.x).not.toBe(-1);
  });

  test('state() reports one contacts entry per scenario contact, read-only', () => {
    const withContact = scenario({
      contacts: [{ host: 0, longitude: 0, captureRadius: 40000, minimumImpactEnergy: 1e12 }],
    });
    const session = createDebugSession();
    const loaded = session.load({ scenario: withContact, seed: 1 });

    expect(loaded.contacts).toEqual([
      { cleared: 0, impactTick: -1, impactSpeed: 0, impactEnergy: 0 },
    ]);

    loaded.contacts[0]!.cleared = 1; // mutate the returned snapshot
    const after = session.state();
    expect(after.contacts[0]!.cleared).toBe(0);
  });

  test('run() reports a fresh, independent sim without disturbing the loaded session', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    session.command(launchCommand());
    session.step(50);
    const stateBefore = session.state();
    const hashBefore = session.hash();

    const otherLog: Command[] = [
      { tick: 0, kind: 'launch', rail: 0, heading: 16384 * 65536, speed: 5_000_000 },
    ];
    const result = session.run({ scenario: scenario(), seed: 2, log: otherLog, ticks: 30 });

    expect(result.tick).toBe(30);
    expect(result.hash).not.toBe(hashBefore);
    expect(session.hash()).toBe(hashBefore);
    expect(session.state()).toEqual(stateBefore);
  });

  test('stepSampled reaches the same final state as step()', () => {
    const viaStep = createDebugSession();
    viaStep.load({ scenario: scenario(), seed: 1 });
    viaStep.command(launchCommand());
    const stepResult = viaStep.step(10);

    const viaSampled = createDebugSession();
    viaSampled.load({ scenario: scenario(), seed: 1 });
    viaSampled.command(launchCommand());
    const sampledResult = viaSampled.stepSampled(10, () => {});

    expect(sampledResult).toEqual(stepResult);
    expect(viaSampled.hash()).toBe(viaStep.hash());
  });

  test('stepSampled calls onTick once per tick, with every live object position that tick', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    session.command(launchCommand());

    const samples: { x: number; y: number }[][] = [];
    session.stepSampled(3, (positions) => samples.push([...positions]));

    expect(samples).toHaveLength(3);
    for (const sample of samples) expect(sample).toHaveLength(1); // the one launched probe
    // The probe actually moves: not every sampled tick has the same position.
    expect(new Set(samples.map((s) => s[0]!.x)).size).toBeGreaterThan(1);
  });

  test('captureFrame throws before a scenario is loaded, like state()/hash()', () => {
    const session = createDebugSession();
    const emptyLevel = {
      bodyIds: [],
      railIds: [],
      contactIds: [],
      bodyClasses: [],
      names: { bodies: [], rails: [], contacts: [] },
    };
    expect(() => session.captureFrame(emptyLevel)).toThrow();
  });

  test('captureFrame reflects the loaded scenario', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    const level = {
      bodyIds: ['origin'],
      railIds: [],
      contactIds: [],
      bodyClasses: ['rock'],
      names: { bodies: ['Origin'], rails: [], contacts: [] },
    };

    const frame = session.captureFrame(level);

    expect(frame.tick).toBe(0);
    expect(frame.bodies).toHaveLength(1);
    expect(frame.bodies[0]!.id).toBe('origin');
  });

  const emptyLevel = {
    bodyIds: ['origin'],
    railIds: ['launch-rail'],
    contactIds: [],
    bodyClasses: ['rock'],
    names: { bodies: ['Origin'], rails: ['Launch Rail'], contacts: [] },
  };

  test('describeSelection reads the loaded sim through src/app/selection.ts', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    session.command(launchCommand());
    session.step(1);

    const rows = session.describeSelection(emptyLevel, { kind: 'probe', index: 0 });

    expect(rows.find((r) => r.key === 'state')?.value).toBe('FLYING');
  });

  test('describeSelection returns no rows for a null selection', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });

    expect(session.describeSelection(emptyLevel, null)).toEqual([]);
  });

  test('describeSelection(level, null) never throws even before anything is loaded', () => {
    const session = createDebugSession();
    expect(session.describeSelection(emptyLevel, null)).toEqual([]);
  });
});
