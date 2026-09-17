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
    bodies: [{ parent: -1, mu: MU, radius: RADIUS }],
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: ['debris_ejection'],
    ...overrides,
  };
}

function launchCommand(
  overrides: Partial<{ tick: number; heading: number; speed: number }> = {},
): Command {
  return { tick: 0, kind: 'launch', body: 0, heading: 0, speed: 8_000_000, ...overrides };
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

  test('run() reports a fresh, independent sim without disturbing the loaded session', () => {
    const session = createDebugSession();
    session.load({ scenario: scenario(), seed: 1 });
    session.command(launchCommand());
    session.step(50);
    const stateBefore = session.state();
    const hashBefore = session.hash();

    const otherLog: Command[] = [
      { tick: 0, kind: 'launch', body: 0, heading: 16384 * 65536, speed: 5_000_000 },
    ];
    const result = session.run({ scenario: scenario(), seed: 2, log: otherLog, ticks: 30 });

    expect(result.tick).toBe(30);
    expect(result.hash).not.toBe(hashBefore);
    expect(session.hash()).toBe(hashBefore);
    expect(session.state()).toEqual(stateBefore);
  });
});
