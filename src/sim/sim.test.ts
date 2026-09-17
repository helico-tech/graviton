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

// A very long rotation period and a full (pi) heading cone: these tests are
// about warp invariance, serialisation and burn-node ordering, not rail
// geometry (that's commands.test.ts and rails.test.ts), so spin is given a
// real but practically negligible rate (omega*radius ~ 0.04 m/s, against
// launch speeds of several km/s) rather than perturbing every trajectory
// these tests already reason about.
const ROTATION_PERIOD = 1e9;

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    dt: DT,
    capacity: 4,
    burnNodeCapacity: 4,
    bodies: [
      { parent: -1, mu: MU, radius: RADIUS, rotationPeriod: ROTATION_PERIOD, axialPhaseAtEpoch: 0 },
    ],
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
    { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 12_000_000 },
    { tick: 5, kind: 'burn', probe: 0, atTick: 10, prograde: 50_000, lateral: 20_000 },
  ];
}

function run(sim: Sim, log: Command[], ticks: number): void {
  advance({ sim, log, ticks });
}

describe('scenario validation', () => {
  const VALID_SCENARIO = scenario();
  const VALID_BYTES = serializeSim(createSim({ scenario: VALID_SCENARIO, seed: 1 }));

  test.each([
    ['dt', 0],
    ['dt', -1],
    ['dt', NaN],
    ['dt', Infinity],
    ['capacity', 0],
    ['capacity', -1],
    ['capacity', 1.5],
    ['capacity', NaN],
    ['burnNodeCapacity', -1],
    ['burnNodeCapacity', 1.5],
    ['burnNodeCapacity', NaN],
  ])('createSim and deserializeSim throw when scenario.%s is %p', (field, value) => {
    const invalid = scenario({ [field]: value });
    expect(() => createSim({ scenario: invalid, seed: 1 })).toThrow();
    expect(() => deserializeSim({ scenario: invalid, bytes: VALID_BYTES })).toThrow();
  });

  test.each([
    ['dryMass', 0],
    ['dryMass', -1],
    ['dryMass', NaN],
    ['propellantMass', -1],
    ['propellantMass', NaN],
    ['thrust', 0],
    ['thrust', -1],
    ['thrust', NaN],
    ['exhaustVelocity', 0],
    ['exhaustVelocity', -1],
    ['exhaustVelocity', NaN],
  ])('createSim and deserializeSim throw when probe.%s is %p', (field, value) => {
    const invalid = scenario({ probe: { ...VALID_SCENARIO.probe, [field]: value } });
    expect(() => createSim({ scenario: invalid, seed: 1 })).toThrow();
    expect(() => deserializeSim({ scenario: invalid, bytes: VALID_BYTES })).toThrow();
  });

  // The two failure modes demonstrated in docs/issues/2026-09-17-scenario-
  // probe-and-body-radius-unvalidated.md: thrust: 0 arms a burn that never
  // ends, exhaustVelocity: 0 makes mdot infinite.
  test('createSim throws on the demonstrated thrust: 0 and exhaustVelocity: 0 cases', () => {
    expect(() =>
      createSim({ scenario: scenario({ probe: { ...VALID_SCENARIO.probe, thrust: 0 } }), seed: 1 }),
    ).toThrow();
    expect(() =>
      createSim({
        scenario: scenario({ probe: { ...VALID_SCENARIO.probe, exhaustVelocity: 0 } }),
        seed: 1,
      }),
    ).toThrow();
  });

  test('accepts a valid scenario', () => {
    expect(() => createSim({ scenario: VALID_SCENARIO, seed: 1 })).not.toThrow();
    expect(() => deserializeSim({ scenario: VALID_SCENARIO, bytes: VALID_BYTES })).not.toThrow();
  });
});

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

  // GRV-0014: railLastLaunchTick is Sim state, not derived scratch -- it
  // must round-trip through serialise/deserialise, and a run that never
  // launches must keep its sentinel (NEVER_LAUNCHED, -1).
  test("a rail's last-launch tick round-trips through serialise/deserialise", () => {
    const sim = createSim({ scenario: scenario(), seed: 11 });
    run(sim, grazeLog(), 1); // executes the tick-0 launch from rail 0
    expect(sim.railLastLaunchTick[0]).toBe(0);

    const bytes = serializeSim(sim);
    const reloaded = deserializeSim({ scenario: scenario(), bytes });
    expect(Array.from(reloaded.railLastLaunchTick)).toEqual(Array.from(sim.railLastLaunchTick));
  });

  test('a rail that never launches keeps the NEVER_LAUNCHED sentinel through a round-trip', () => {
    const sim = createSim({ scenario: scenario(), seed: 11 });
    run(sim, [], 5); // no commands at all
    expect(sim.railLastLaunchTick[0]).toBe(-1);

    const bytes = serializeSim(sim);
    const reloaded = deserializeSim({ scenario: scenario(), bytes });
    expect(reloaded.railLastLaunchTick[0]).toBe(-1);
  });

  test('railLastLaunchTick is hash-sensitive', () => {
    const sim = createSim({ scenario: scenario(), seed: 11 });
    run(sim, grazeLog(), 1);
    const before = hashSim(sim);

    sim.railLastLaunchTick[0] = 999;

    expect(hashSim(sim)).not.toBe(before);
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

describe('burn nodes for a probe that has hit a body', () => {
  function launchOnlyLog(): Command[] {
    return [{ tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 2_000_000 }]; // radial, sub-escape: falls back and hits
  }

  // Finds the tick the radial-fall probe actually hits at, empirically, rather
  // than assuming a value: the exact tick depends on the integrator, not a
  // closed-form time of flight.
  function findHitTick(): number {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    for (let t = 0; t < 400; t++) {
      run(sim, launchOnlyLog(), 1);
      if (sim.objects.hitBody[0] !== -1) return sim.tick;
    }
    throw new Error('test setup: probe 0 never hit the body within 400 ticks');
  }

  test('a due node for a hit probe is dropped, not armed; nodes for other probes fire normally', () => {
    const hitTick = findHitTick();
    const dueTick = hitTick + 10;
    const laterDueTick = dueTick + 20;
    const log: Command[] = [
      { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 2_000_000 }, // probe 0: radial, falls back and hits
      { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 12_000_000 }, // probe 1: radial, escapes unaffected
      { tick: 0, kind: 'burn', probe: 0, atTick: dueTick, prograde: 100_000, lateral: 0 },
      { tick: 0, kind: 'burn', probe: 1, atTick: dueTick, prograde: 100_000, lateral: 0 },
      { tick: 0, kind: 'burn', probe: 0, atTick: laterDueTick, prograde: 200_000, lateral: 0 },
    ];

    const sim = createSim({ scenario: scenario(), seed: 1 });
    run(sim, log, hitTick);
    expect(sim.objects.hitBody[0]).not.toBe(-1); // hit as predicted
    expect(sim.pending.count).toBe(3); // none due yet

    run(sim, log, dueTick - hitTick + 1); // carry past the first due tick
    expect(sim.objects.burning[0]).toBe(0); // hit probe never arms
    expect(sim.pending.count).toBe(1); // probe 0's node dropped, probe 1's fired; probe 0's later node still waits
    expect(sim.objects.burnDelivered[1]).toBeGreaterThan(0); // probe 1's burn actually ran

    run(sim, log, laterDueTick - dueTick); // carry past the later due tick too
    expect(sim.objects.burning[0]).toBe(0); // still never arms
    expect(sim.pending.count).toBe(0); // the later node was dropped too, in its turn
  });
});

// GRV-0015: fixed contacts as Sim state -- serialisation, hashing, and a
// contact-expended probe's pending nodes. The impact test's own math (swept
// segment, ladder term, ghost isolation) is step.test.ts's; this file
// covers the state that rides on top of it.
describe('fixed contacts', () => {
  const CONTACT_LONGITUDE = 0.5;
  const CAPTURE_RADIUS = 40000;

  function contactScenario(minimumImpactEnergy: number): Scenario {
    return scenario({
      contacts: [
        {
          host: 0,
          longitude: CONTACT_LONGITUDE,
          captureRadius: CAPTURE_RADIUS,
          minimumImpactEnergy,
        },
      ],
    });
  }

  // Places a probe 600 km out from the contact, heading straight at it, by
  // direct field assignment rather than solving a real launch heading for
  // it (mirrors this file's own "hash sensitivity" test's direct pokes) --
  // what these tests check is contact *state* handling, not a realistic
  // flight; step.test.ts already covers the impact test's own geometry.
  function seedAimedProbe(sim: Sim, speed: number): void {
    const contactX = RADIUS * Math.cos(CONTACT_LONGITUDE);
    const contactY = RADIUS * Math.sin(CONTACT_LONGITUDE);
    const i = sim.objects.count++;
    sim.objects.x[i] = contactX + 600000;
    sim.objects.y[i] = contactY;
    sim.objects.vx[i] = -speed;
    sim.objects.vy[i] = 0;
    sim.objects.hitBody[i] = -1;
    sim.objects.hitContact[i] = -1;
    sim.objects.mass[i] = 1000;
    sim.objects.dryMass[i] = 500;
    sim.objects.thrust[i] = 400;
    sim.objects.exhaustVelocity[i] = 3000;
    sim.objects.burning[i] = 0;
  }

  function stepUntilImpact(sim: Sim): void {
    for (let t = 0; t < 200 && sim.objects.hitContact[0] === -1; t++) run(sim, [], 1);
    if (sim.objects.hitContact[0] === -1)
      throw new Error('test setup: probe never hit the contact');
  }

  test("serialise round-trip mid-approach carries a live contact's state (before and after impact)", () => {
    const before = createSim({ scenario: contactScenario(1e9), seed: 1 });
    seedAimedProbe(before, 5000);
    run(before, [], 1); // mid-approach (600 km out at 5000 m/s takes 2 ticks), contact not yet impacted
    expect(before.objects.hitContact[0]).toBe(-1);
    expect(before.contactState.impactTick[0]).toBe(-1);

    const bytesBefore = serializeSim(before);
    const reloadedBefore = deserializeSim({ scenario: contactScenario(1e9), bytes: bytesBefore });
    run(reloadedBefore, [], 19);
    expect(reloadedBefore.objects.hitContact[0]).toBe(0); // reached the contact after reload
    expect(reloadedBefore.contactState.cleared[0]).toBe(1);

    const uninterrupted = createSim({ scenario: contactScenario(1e9), seed: 1 });
    seedAimedProbe(uninterrupted, 5000);
    run(uninterrupted, [], 20);
    expect(hashSim(reloadedBefore)).toBe(hashSim(uninterrupted));

    // Split again, this time after the impact: the contact's recorded
    // outcome (cleared, impact tick/speed/energy) must itself survive the
    // round trip, not just the trajectory that led to it.
    const after = createSim({ scenario: contactScenario(1e9), seed: 1 });
    seedAimedProbe(after, 5000);
    stepUntilImpact(after);
    const impactTick = after.contactState.impactTick[0]!;
    const bytesAfter = serializeSim(after);
    const reloadedAfter = deserializeSim({ scenario: contactScenario(1e9), bytes: bytesAfter });
    expect(reloadedAfter.contactState.cleared[0]).toBe(1);
    expect(reloadedAfter.contactState.impactTick[0]).toBe(impactTick);
    expect(reloadedAfter.contactState.impactSpeed[0]).toBe(after.contactState.impactSpeed[0]);
    expect(reloadedAfter.contactState.impactEnergy[0]).toBe(after.contactState.impactEnergy[0]);

    run(reloadedAfter, [], 50);
    run(after, [], 50);
    expect(hashSim(reloadedAfter)).toBe(hashSim(after));
  });

  test('hash sensitivity: flipping a contact state field changes hashSim', () => {
    const sim = createSim({ scenario: contactScenario(1e9), seed: 1 });
    seedAimedProbe(sim, 5000);
    stepUntilImpact(sim);
    const before = hashSim(sim);

    sim.contactState.cleared[0] = sim.contactState.cleared[0]! ? 0 : 1;
    expect(hashSim(sim)).not.toBe(before);

    sim.contactState.cleared[0] = sim.contactState.cleared[0]! ? 0 : 1; // restore
    expect(hashSim(sim)).toBe(before);

    sim.contactState.impactEnergy[0] = sim.contactState.impactEnergy[0]! + 1;
    expect(hashSim(sim)).not.toBe(before);
  });

  test('hash sensitivity: flipping an object hitContact changes hashSim', () => {
    const sim = createSim({ scenario: contactScenario(1e9), seed: 1 });
    seedAimedProbe(sim, 5000);
    run(sim, [], 1);
    const before = hashSim(sim);

    sim.objects.hitContact[0] = 0;
    expect(hashSim(sim)).not.toBe(before);
  });

  test('a due burn node for a contact-expended probe is dropped, not armed', () => {
    // minimumImpactEnergy well below what a 5000 m/s, 1000 kg impact
    // delivers (~1.25e10 J): the probe clears the contact and is expended.
    const sim = createSim({ scenario: contactScenario(1e9), seed: 1 });
    seedAimedProbe(sim, 5000);
    stepUntilImpact(sim);
    expect(sim.objects.hitContact[0]).toBe(0);
    expect(sim.objects.hitBody[0]).toBe(-1); // expended by the contact, not the body

    const dueTick = sim.tick + 5;
    sim.pending.object[0] = 0;
    sim.pending.atTick[0] = dueTick;
    sim.pending.prograde[0] = 100_000;
    sim.pending.lateral[0] = 0;
    sim.pending.count = 1;

    run(sim, [], dueTick - sim.tick + 1);
    expect(sim.objects.burning[0]).toBe(0); // never arms
    expect(sim.pending.count).toBe(0); // dropped once due
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

describe('pending burn node ordering', () => {
  // A long first burn (~19 ticks) keeps the probe busy while two more burn
  // nodes are scheduled at tick 1, deliberately enqueued out of atTick order
  // (atTick 8 before atTick 3) and both already due long before the long
  // burn ends -- so both spend most of the run waiting on the same probe.
  function longBurnLog(): Command[] {
    return [
      { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 12_000_000 },
      { tick: 0, kind: 'burn', probe: 0, atTick: 0, prograde: 500_000, lateral: 0 },
      { tick: 1, kind: 'burn', probe: 0, atTick: 8, prograde: 30_000, lateral: 0 },
      { tick: 1, kind: 'burn', probe: 0, atTick: 3, prograde: 10_000, lateral: 0 },
    ];
  }

  test('two nodes due while a long burn is active fire afterwards in atTick order', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const log = longBurnLog();
    // Sampled at tick boundaries (where activateDueBurnNodes runs), not by
    // watching `burning` mid-tick: a short enough burn can arm and finish
    // entirely within one tick's internal substeps, so `pending.count`'s
    // transitions are the reliable signal of firing order, not `burning`.
    let sawBothWaiting = false;
    let remainingAfterFirstFire: number[] | null = null;
    let lastCount = 0;
    for (let t = 0; t < 40; t++) {
      run(sim, log, 1);
      const count = sim.pending.count;
      if (count === 2) sawBothWaiting = true;
      if (lastCount === 2 && count === 1 && remainingAfterFirstFire === null) {
        remainingAfterFirstFire = Array.from(sim.pending.prograde.slice(0, count));
      }
      lastCount = count;
    }
    expect(sawBothWaiting).toBe(true);
    // The atTick-3 node (10_000 mm/s) fires first even though it was
    // enqueued second (after the atTick-8 node); only the atTick-8 node
    // (30_000) is left waiting.
    expect(remainingAfterFirstFire).toEqual([30_000]);
    expect(sim.objects.burning[0]).toBe(0);
    expect(sim.pending.count).toBe(0);
  });

  test('the same firing order survives a serialise/deserialise mid-wait', () => {
    const log = longBurnLog();
    const uninterrupted = createSim({ scenario: scenario(), seed: 1 });
    run(uninterrupted, log, 40);

    const first = createSim({ scenario: scenario(), seed: 1 });
    run(first, log, 5); // both extra nodes enqueued and already waiting
    expect(first.pending.count).toBe(2);
    expect(first.objects.burning[0]).toBe(1); // still on the original burn

    const bytes = serializeSim(first);
    const reloaded = deserializeSim({ scenario: scenario(), bytes });
    run(reloaded, log, 35);

    expect(hashSim(reloaded)).toBe(hashSim(uninterrupted));
  });
});
