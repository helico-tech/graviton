// Tests for command validation and application (docs/work/GRV-0008). Math.*
// is fine here -- tests are exempt from src/sim's determinism lint
// (ADR-0002).
import { describe, expect, test } from 'vitest';
import { applyCommand } from './commands.ts';
import type { BurnCommand, LaunchCommand } from './commands.ts';
import { createSim } from './sim.ts';
import type { Scenario, Sim } from './sim.ts';

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

function launch(overrides: Partial<LaunchCommand> = {}): LaunchCommand {
  return { tick: 0, kind: 'launch', body: 0, heading: 0, speed: 8_000_000, ...overrides };
}

function makeSim(overrides: Partial<Scenario> = {}): Sim {
  return createSim({ scenario: scenario(overrides), seed: 1 });
}

describe('launch', () => {
  test('sets position and velocity from the body plus the heading direction', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch({ heading: 0, speed: 8_000_000 }) });

    expect(sim.objects.count).toBe(1);
    // heading 0 => direction (1, 0); body is at rest at the origin.
    expect(sim.objects.x[0]).toBeCloseTo(RADIUS + 1000, 6);
    expect(sim.objects.y[0]).toBeCloseTo(0, 6);
    expect(sim.objects.vx[0]).toBeCloseTo(8000, 9);
    expect(sim.objects.vy[0]).toBeCloseTo(0, 9);
    expect(sim.objects.hitBody[0]).toBe(-1);
  });

  test('a quarter turn points along +y', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch({ heading: 16384, speed: 1_000_000 }) }); // 1/4 turn
    expect(sim.objects.x[0]).toBeCloseTo(0, 3);
    expect(sim.objects.y[0]).toBeCloseTo(RADIUS + 1000, 3);
    expect(sim.objects.vx[0]).toBeCloseTo(0, 6);
    expect(sim.objects.vy[0]).toBeCloseTo(1000, 6);
  });

  test('sets probe mass, dry mass, thrust and exhaust velocity from the scenario', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch() });
    expect(sim.objects.mass[0]).toBe(1000);
    expect(sim.objects.dryMass[0]).toBe(500);
    expect(sim.objects.thrust[0]).toBe(400);
    expect(sim.objects.exhaustVelocity[0]).toBe(3000);
    expect(sim.objects.burning[0]).toBe(0);
  });

  test('throws on a non-integer heading', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ heading: 1.5 }) })).toThrow();
  });

  test('throws on heading out of [0, 65535]', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ heading: 65536 }) })).toThrow();
    expect(() => applyCommand({ sim, command: launch({ heading: -1 }) })).toThrow();
  });

  test('throws on a non-integer or negative speed', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ speed: 1.5 }) })).toThrow();
    expect(() => applyCommand({ sim, command: launch({ speed: -1 }) })).toThrow();
  });

  test('throws on an out-of-range body index', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ body: 1 }) })).toThrow();
    expect(() => applyCommand({ sim, command: launch({ body: -1 }) })).toThrow();
  });

  test('throws once the object capacity is exhausted', () => {
    const sim = makeSim({ capacity: 1 });
    applyCommand({ sim, command: launch() });
    expect(() => applyCommand({ sim, command: launch() })).toThrow();
  });
});

function burn(overrides: Partial<BurnCommand> = {}): BurnCommand {
  return { tick: 0, kind: 'burn', probe: 0, atTick: 0, prograde: 100, lateral: 0, ...overrides };
}

describe('burn', () => {
  test('enqueues a pending node rather than arming the burn immediately', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch() });
    applyCommand({ sim, command: burn({ atTick: 5, prograde: 300, lateral: -40 }) });

    expect(sim.pending.count).toBe(1);
    expect(sim.pending.object[0]).toBe(0);
    expect(sim.pending.atTick[0]).toBe(5);
    expect(sim.pending.prograde[0]).toBe(300);
    expect(sim.pending.lateral[0]).toBe(-40);
    expect(sim.objects.burning[0]).toBe(0); // not armed yet
  });

  test('throws when the probe index does not reference a launched object', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: burn({ probe: 0 }) })).toThrow();
  });

  test('throws when atTick precedes the command tick', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch() });
    expect(() => applyCommand({ sim, command: burn({ tick: 10, atTick: 9 }) })).toThrow();
  });

  test('throws on non-integer prograde/lateral', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch() });
    expect(() => applyCommand({ sim, command: burn({ prograde: 1.5 }) })).toThrow();
    expect(() => applyCommand({ sim, command: burn({ lateral: 1.5 }) })).toThrow();
  });

  // Zero prograde and zero lateral is a zero delta-v target: startBurn (burn.ts)
  // rejects it, but that only runs once the node comes due, ticks after the
  // command was logged. Reject it here instead, at apply time.
  test('throws when both prograde and lateral are zero', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch() });
    expect(() => applyCommand({ sim, command: burn({ prograde: 0, lateral: 0 }) })).toThrow();
  });

  // A flight plan can carry several nodes per probe (GAME-0001 §4.4), so
  // the pending queue is sized on its own, not bounded by object capacity.
  test('accepts more pending nodes than objects, up to burnNodeCapacity, and throws beyond it', () => {
    const sim = makeSim({ capacity: 1, burnNodeCapacity: 3 });
    applyCommand({ sim, command: launch() });
    applyCommand({ sim, command: burn({ atTick: 1 }) });
    applyCommand({ sim, command: burn({ atTick: 2 }) });
    applyCommand({ sim, command: burn({ atTick: 3 }) });
    expect(sim.pending.count).toBe(3); // three pending nodes on a single object

    expect(() => applyCommand({ sim, command: burn({ atTick: 4 }) })).toThrow();
  });

  test('nodes enqueued out of atTick order end up stored sorted by atTick', () => {
    const sim = makeSim({ burnNodeCapacity: 3 });
    applyCommand({ sim, command: launch() });
    applyCommand({ sim, command: burn({ atTick: 30, prograde: 3 }) });
    applyCommand({ sim, command: burn({ atTick: 10, prograde: 1 }) });
    applyCommand({ sim, command: burn({ atTick: 20, prograde: 2 }) });

    expect(Array.from(sim.pending.atTick)).toEqual([10, 20, 30]);
    expect(Array.from(sim.pending.prograde)).toEqual([1, 2, 3]);
  });

  test('ties at the same atTick keep log (insertion) order', () => {
    const sim = makeSim({ burnNodeCapacity: 3 });
    applyCommand({ sim, command: launch() });
    applyCommand({ sim, command: burn({ atTick: 10, prograde: 1 }) });
    applyCommand({ sim, command: burn({ atTick: 10, prograde: 2 }) });
    applyCommand({ sim, command: burn({ atTick: 5, prograde: 3 }) });

    // atTick 5 sorts first; the two atTick-10 entries keep their enqueue order.
    expect(Array.from(sim.pending.atTick)).toEqual([5, 10, 10]);
    expect(Array.from(sim.pending.prograde)).toEqual([3, 1, 2]);
  });
});

describe('tick validation', () => {
  test('throws on a non-integer or negative tick', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ tick: 1.5 }) })).toThrow();
    expect(() => applyCommand({ sim, command: launch({ tick: -1 }) })).toThrow();
  });
});
