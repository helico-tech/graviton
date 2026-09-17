// Tests for Sim: warp invariance, serialisation round-trip, substep
// determinism across save/reload, seeded streams, and hash sensitivity
// (docs/domain/simulation-determinism.md's required tests, docs/work/
// GRV-0008). Math.* is fine here -- tests are exempt from src/sim's
// determinism lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import { computeKDyn, substepLevel } from './dynamics/ladder.ts';
import { evaluateEphemeris } from './ephemeris/bodies.ts';
import type { EphemerisOut } from './ephemeris/bodies.ts';
import { advance, createSim, deserializeSim, hashSim, serializeSim } from './sim.ts';
import type { Command, Scenario, Sim } from './sim.ts';

const DT = 60;
const MU = 3.986004418e14; // Earth-like
const RADIUS = 6.371e6;

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    dt: DT,
    capacity: 4,
    bodies: [{ parent: -1, mu: MU, radius: RADIUS }],
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: ['debris_ejection', 'sensor_noise'],
    ...overrides,
  };
}

// A radial launch fast enough to escape the primary (escape velocity here is
// ~11 186 m/s): the probe starts right at the surface -- close enough that
// the crossing ladder forces a level above 0 -- then recedes forever with no
// risk of falling back and colliding, so a long run never has to dodge a
// collision. A small lateral component in the mid-course burn is enough to
// nudge it off the purely radial line without threatening that guarantee.
function grazeLog(): Command[] {
  return [
    { tick: 0, kind: 'launch', body: 0, heading: 0, speed: 12_000_000 },
    { tick: 5, kind: 'burn', probe: 0, atTick: 10, prograde: 50_000, lateral: 20_000 },
  ];
}

function run(sim: Sim, log: Command[], ticks: number): void {
  advance({ sim, log, ticks });
}

describe('warp invariance', () => {
  test('batches of 1, 10 and 1000 ticks reach the same hash', () => {
    const log = grazeLog();
    const total = 3000;

    const s1 = createSim({ scenario: scenario(), seed: 7 });
    run(s1, log, total);

    const s10 = createSim({ scenario: scenario(), seed: 7 });
    for (let done = 0; done < total; done += 10) run(s10, log, 10);

    const s1000 = createSim({ scenario: scenario(), seed: 7 });
    for (let done = 0; done < total; done += 1000) run(s1000, log, 1000);

    const s1by1 = createSim({ scenario: scenario(), seed: 7 });
    for (let done = 0; done < total; done++) run(s1by1, log, 1);

    const expected = hashSim(s1);
    expect(hashSim(s10)).toBe(expected);
    expect(hashSim(s1000)).toBe(expected);
    expect(hashSim(s1by1)).toBe(expected);
  });
});

describe('serialisation round-trip', () => {
  test('mid-flight: save, reload, continue matches the uninterrupted run', () => {
    const log = grazeLog();
    const uninterrupted = createSim({ scenario: scenario(), seed: 11 });
    run(uninterrupted, log, 400);

    const first = createSim({ scenario: scenario(), seed: 11 });
    run(first, log, 200); // mid-flight, before the burn's activation

    const bytes = serializeSim(first);
    const reloaded = deserializeSim({ scenario: scenario(), bytes });
    run(reloaded, log, 200);

    expect(hashSim(reloaded)).toBe(hashSim(uninterrupted));
  });

  test('mid-burn: save, reload, continue matches the uninterrupted run', () => {
    const log = grazeLog();
    const uninterrupted = createSim({ scenario: scenario(), seed: 11 });
    run(uninterrupted, log, 400);

    const first = createSim({ scenario: scenario(), seed: 11 });
    run(first, log, 11); // one tick after the burn node activates (atTick 10)
    expect(first.objects.burning[0]).toBe(1); // actually mid-burn

    const bytes = serializeSim(first);
    const reloaded = deserializeSim({ scenario: scenario(), bytes });
    run(reloaded, log, 389);

    expect(hashSim(reloaded)).toBe(hashSim(uninterrupted));
  });

  test('serialise -> deserialise -> serialise is byte-identical', () => {
    const sim = createSim({ scenario: scenario(), seed: 3 });
    run(sim, grazeLog(), 15);

    const bytes = serializeSim(sim);
    const reloaded = deserializeSim({ scenario: scenario(), bytes });
    const bytesAgain = serializeSim(reloaded);

    expect(Array.from(bytesAgain)).toEqual(Array.from(bytes));
  });

  test('throws on a sim-version mismatch', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const bytes = serializeSim(sim);
    const corrupted = new Uint8Array(bytes);
    new DataView(corrupted.buffer).setUint32(4, 999, true); // simVersion field
    expect(() => deserializeSim({ scenario: scenario(), bytes: corrupted })).toThrow();
  });
});

// Finds a tick where the probe's own substep level changes, by mirroring
// substepLevel's inputs from the live object state at each tick boundary
// (production doesn't persist a level -- research §8.3 marks it advisory,
// renderer-only cache, not simulation state).
function levelAt(sim: Sim, objectIndex: number): number {
  const kDyn = computeKDyn(sim.bodies, sim.scenario.dt);
  const eph: EphemerisOut = {
    x: new Float64Array(sim.bodies.count),
    y: new Float64Array(sim.bodies.count),
    vx: new Float64Array(sim.bodies.count),
    vy: new Float64Array(sim.bodies.count),
  };
  evaluateEphemeris(sim.bodies, sim.tick * sim.scenario.dt, eph);
  return substepLevel({
    bodies: sim.bodies,
    kDyn,
    dt: sim.scenario.dt,
    x: sim.objects.x[objectIndex]!,
    y: sim.objects.y[objectIndex]!,
    vx: sim.objects.vx[objectIndex]!,
    vy: sim.objects.vy[objectIndex]!,
    eph,
    burning: sim.objects.burning[objectIndex]!,
    mass: sim.objects.mass[objectIndex]!,
    dryMass: sim.objects.dryMass[objectIndex]!,
    thrust: sim.objects.thrust[objectIndex]!,
    exhaustVelocity: sim.objects.exhaustVelocity[objectIndex]!,
    burnTarget: sim.objects.burnTarget[objectIndex]!,
    burnDelivered: sim.objects.burnDelivered[objectIndex]!,
  });
}

describe('substep determinism', () => {
  test('reproduces exactly across save/reload either side of a level-change boundary', () => {
    const log = grazeLog();
    const probing = createSim({ scenario: scenario(), seed: 5 });
    run(probing, log, 1); // executes the launch command at tick 0
    let boundaryTick = -1;
    let previousLevel = levelAt(probing, 0);
    for (let t = 1; t < 600 && boundaryTick < 0; t++) {
      run(probing, log, 1);
      const level = levelAt(probing, 0);
      if (level !== previousLevel) boundaryTick = probing.tick;
      previousLevel = level;
    }
    expect(boundaryTick).toBeGreaterThan(0); // the scenario must actually cross a boundary

    const uninterrupted = createSim({ scenario: scenario(), seed: 5 });
    run(uninterrupted, log, 600);
    const expected = hashSim(uninterrupted);

    for (const offset of [-1, 1]) {
      const splitAt = boundaryTick + offset;
      const first = createSim({ scenario: scenario(), seed: 5 });
      run(first, log, splitAt);
      const bytes = serializeSim(first);
      const reloaded = deserializeSim({ scenario: scenario(), bytes });
      run(reloaded, log, 600 - splitAt);
      expect(hashSim(reloaded)).toBe(expected);
    }
  });
});

describe('seed', () => {
  test('different seeds give different stream words, and therefore different hashes', () => {
    const a = createSim({ scenario: scenario(), seed: 1 });
    const b = createSim({ scenario: scenario(), seed: 2 });
    expect(Array.from(a.streams[0]!)).not.toEqual(Array.from(b.streams[0]!));

    run(a, grazeLog(), 50);
    run(b, grazeLog(), 50);
    expect(hashSim(a)).not.toBe(hashSim(b));
  });

  test('the same seed gives the same hash', () => {
    const a = createSim({ scenario: scenario(), seed: 42 });
    const b = createSim({ scenario: scenario(), seed: 42 });
    run(a, grazeLog(), 50);
    run(b, grazeLog(), 50);
    expect(hashSim(a)).toBe(hashSim(b));
  });

  test('streams advance only when drawn: an unused stream never changes', () => {
    const sim = createSim({ scenario: scenario(), seed: 9 });
    const before = Array.from(sim.streams[1]!); // 'sensor_noise', never drawn from
    run(sim, grazeLog(), 200);
    expect(Array.from(sim.streams[1]!)).toEqual(before);
  });
});

describe('hash sensitivity', () => {
  test('flipping the lowest bit of one object x changes hashSim', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    run(sim, grazeLog(), 20);
    const before = hashSim(sim);

    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, sim.objects.x[0]!);
    const view = new DataView(buffer);
    view.setUint32(4, view.getUint32(4) ^ 1); // flip the lowest mantissa bit
    sim.objects.x[0] = view.getFloat64(0);

    expect(hashSim(sim)).not.toBe(before);
  });
});
