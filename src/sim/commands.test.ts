// Tests for command validation and application (docs/work/GRV-0008). Math.*
// is fine here -- tests are exempt from src/sim's determinism lint
// (ADR-0002).
import { describe, expect, test } from 'vitest';
import { applyCommand, HEADING_TURN } from './commands.ts';
import type { BurnCommand, LaunchCommand } from './commands.ts';
import { dcosOut, dsincos, dsinOut } from './math/kernels.ts';
import { advance, createSim } from './sim.ts';
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
    // 1/4 turn: 16384/65536 in the old unit, ie. 16384*65536/2^32 in the new one.
    applyCommand({ sim, command: launch({ heading: 16384 * 65536, speed: 1_000_000 }) });
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

  test('throws on heading out of [0, 2^32)', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ heading: 4294967296 }) })).toThrow();
    expect(() => applyCommand({ sim, command: launch({ heading: -1 }) })).toThrow();
  });

  test('accepts the maximum heading, 2^32 - 1', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ heading: 4294967295 }) })).not.toThrow();
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

// GRV-0013 (docs/adr/2026-09-17-0006 §4): heading moved from 1/65536 turn to
// 1/2^32 turn. The rescale is a power of two, so a multiple of the old
// quantum must produce the exact same direction bits the old formula gave --
// checked directly rather than assumed, over a spread of old headings.
describe('heading quantum', () => {
  const TWO_PI = 6.283185307179586;
  const OLD_HEADING_TURN = 65536; // the pre-GRV-0013 unit, 1/65536 of a turn

  test('a heading that is a multiple of the old quantum gives the bit-identical direction the old formula gave', () => {
    const oldHeadings = [0, 1, 16384, 32768, 65535];
    for (let i = 0; i < 300; i++) oldHeadings.push(Math.floor(Math.random() * OLD_HEADING_TURN));

    for (const oldHeading of oldHeadings) {
      dsincos((oldHeading * TWO_PI) / OLD_HEADING_TURN);
      const expectedNx = dcosOut;
      const expectedNy = dsinOut;

      // The command log's heading field, in the new unit: the old value
      // scaled by a fixed literal 65536, exactly as the golden and every
      // other fixture were rescaled -- not derived from HEADING_TURN, so
      // this only passes once HEADING_TURN really is 2^32.
      const newHeading = oldHeading * 65536;
      dsincos((newHeading * TWO_PI) / HEADING_TURN);
      expect(Object.is(dcosOut, expectedNx)).toBe(true);
      expect(Object.is(dsinOut, expectedNy)).toBe(true);
    }
  });
});

// docs/work/GRV-0013-heading-quantum.md's acceptance: the whole point of the
// finer quantum is that adjacent headings stay inside a capture radius while
// the old quantum did not. Measured directly on a simple one-primary coast,
// not asserted from the ADR's back-of-envelope number.
describe('heading sensitivity over an eleven-day coast', () => {
  const SPEED_MM_S = 200_000_000; // 200 km/s, relative to the primary
  const COAST_TICKS = 15840; // 11 days at dt=60
  const BASE_HEADING = 1_000_000_000; // arbitrary, well clear of both range edges
  const OLD_QUANTUM = 65536; // the pre-GRV-0013 heading unit, expressed in new units

  function finalPosition(heading: number): { x: number; y: number } {
    const sim = makeSim({ capacity: 1, burnNodeCapacity: 0 });
    applyCommand({ sim, command: launch({ heading, speed: SPEED_MM_S }) });
    advance({ sim, log: [], ticks: COAST_TICKS });
    return { x: sim.objects.x[0]!, y: sim.objects.y[0]! };
  }

  function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  test('two adjacent new-unit headings miss by under 1 km; one old quantum apart misses by thousands of km', () => {
    const base = finalPosition(BASE_HEADING);
    const adjacentMiss = distance(base, finalPosition(BASE_HEADING + 1));
    const oldQuantumMiss = distance(base, finalPosition(BASE_HEADING + OLD_QUANTUM));

    expect(adjacentMiss).toBeLessThan(1000); // under 1 km
    expect(oldQuantumMiss).toBeGreaterThan(1_000_000); // thousands of km
    expect(oldQuantumMiss).toBeGreaterThan(adjacentMiss * 1000); // scales with the unit ratio
  });
});
