// Tests for command validation and application (docs/work/GRV-0008,
// docs/work/GRV-0014). Math.* is fine here -- tests are exempt from
// src/sim's determinism lint (ADR-0002), and used deliberately as an
// independent oracle: production computes rail geometry with dsincos and
// surfacePhase, these tests recompute the same geometry with
// Math.cos/Math.sin so a real formula bug shows up as a mismatch.
import { describe, expect, test } from 'vitest';
import { applyCommand, checkLaunch, HEADING_TURN } from './commands.ts';
import type { BurnCommand, LaunchCommand } from './commands.ts';
import { dcosOut, dsincos, dsinOut } from './math/kernels.ts';
import { advance, createSim, hashSim } from './sim.ts';
import type { RailDef, Scenario, Sim } from './sim.ts';

const DT = 60;
const MU = 3.986004418e14; // Earth-like
const RADIUS = 6.371e6;
const ROTATION_PERIOD = 86400; // 1 day: a real, non-negligible spin rate
const OMEGA = (2 * Math.PI) / ROTATION_PERIOD;

const DEFAULT_RAIL: RailDef = {
  host: 0,
  longitude: 0,
  muzzleSpeedMin: 1,
  muzzleSpeedMax: 1_000_000,
  headingCone: Math.PI, // accepts any heading -- unrelated tests never hit 'cone'
  reloadTicks: 0,
};

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    dt: DT,
    capacity: 4,
    burnNodeCapacity: 4,
    bodies: [
      { parent: -1, mu: MU, radius: RADIUS, rotationPeriod: ROTATION_PERIOD, axialPhaseAtEpoch: 0 },
    ],
    rails: [DEFAULT_RAIL],
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: ['debris_ejection'],
    ...overrides,
  };
}

function launch(overrides: Partial<LaunchCommand> = {}): LaunchCommand {
  return { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 8_000_000, ...overrides };
}

function makeSim(overrides: Partial<Scenario> = {}): Sim {
  return createSim({ scenario: scenario(overrides), seed: 1 });
}

/** Independent oracle for a rail's local vertical and surface rotation
 *  velocity at time `t`, mirroring rails.ts's shape but computed with
 *  Math.cos/Math.sin instead of the production dsincos/surfacePhase. */
function railOracle({
  t,
  rotationPeriod,
  axialPhaseAtEpoch,
  longitude,
  radius,
}: {
  t: number;
  rotationPeriod: number;
  axialPhaseAtEpoch: number;
  longitude: number;
  radius: number;
}): { ux: number; uy: number; rotVx: number; rotVy: number } {
  const cycles = t / rotationPeriod;
  const frac = cycles - Math.floor(cycles);
  const phi = axialPhaseAtEpoch + 2 * Math.PI * frac + longitude;
  const omega = (2 * Math.PI) / rotationPeriod;
  return {
    ux: Math.cos(phi),
    uy: Math.sin(phi),
    rotVx: omega * radius * -Math.sin(phi),
    rotVy: omega * radius * Math.cos(phi),
  };
}

describe('launch', () => {
  test('position is exactly the rail surface point; velocity is host + rotation + muzzle', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch({ heading: 0, speed: 8_000_000 }) });

    expect(sim.objects.count).toBe(1);
    // heading 0 => muzzle direction (1, 0); axialPhaseAtEpoch/longitude are
    // both 0, so at t=0 the local vertical is also (1, 0) -- position lands
    // on the surface along +x, exactly as the pre-rail radial launch did.
    expect(sim.objects.x[0]).toBeCloseTo(RADIUS, 3);
    expect(sim.objects.y[0]).toBeCloseTo(0, 3);
    // Velocity: host is at rest (the primary never moves) + the surface
    // rotation term (tangential at phi=0 is (0,1)) + the muzzle vector.
    expect(sim.objects.vx[0]).toBeCloseTo(8000, 6);
    expect(sim.objects.vy[0]).toBeCloseTo(OMEGA * RADIUS, 6);
    expect(sim.objects.hitBody[0]).toBe(-1);
  });

  test('a quarter turn points the muzzle along +y; position is unchanged -- it depends on the rail, not the heading', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch({ heading: 16384 * 65536, speed: 1_000_000 }) });
    expect(sim.objects.x[0]).toBeCloseTo(RADIUS, 3);
    expect(sim.objects.y[0]).toBeCloseTo(0, 3);
    expect(sim.objects.vx[0]).toBeCloseTo(0, 6);
    expect(sim.objects.vy[0]).toBeCloseTo(OMEGA * RADIUS + 1000, 6);
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

  test('throws on an out-of-range rail index', () => {
    const sim = makeSim();
    expect(() => applyCommand({ sim, command: launch({ rail: 1 }) })).toThrow();
    expect(() => applyCommand({ sim, command: launch({ rail: -1 }) })).toThrow();
  });

  test('throws once the object capacity is exhausted', () => {
    const sim = makeSim({ capacity: 1 });
    applyCommand({ sim, command: launch() });
    expect(() => applyCommand({ sim, command: launch() })).toThrow();
  });

  test("records the launch as the rail's last-launch tick", () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch({ tick: 0 }) });
    expect(sim.railLastLaunchTick[0]).toBe(0);
  });
});

describe('launch geometry: position at a known phase', () => {
  test('lands exactly on the surface at the angle surfacePhase + longitude predicts', () => {
    const longitude = 0.9;
    const axialPhaseAtEpoch = 1.4;
    const sim = createSim({
      scenario: scenario({
        bodies: [
          {
            parent: -1,
            mu: MU,
            radius: RADIUS,
            rotationPeriod: ROTATION_PERIOD,
            axialPhaseAtEpoch,
          },
        ],
        rails: [{ ...DEFAULT_RAIL, longitude }],
      }),
      seed: 1,
    });
    advance({ sim, log: [], ticks: 100 }); // sim.tick is now 100, t = 100 * DT = 6000
    applyCommand({ sim, command: launch({ tick: 100, heading: 0, speed: 1000 }) });

    const t = 100 * DT;
    const oracle = railOracle({
      t,
      rotationPeriod: ROTATION_PERIOD,
      axialPhaseAtEpoch,
      longitude,
      radius: RADIUS,
    });

    expect(Math.hypot(sim.objects.x[0]!, sim.objects.y[0]!)).toBeCloseTo(RADIUS, 3);
    expect(Math.abs(sim.objects.x[0]! - RADIUS * oracle.ux)).toBeLessThan(RADIUS * 1e-9);
    expect(Math.abs(sim.objects.y[0]! - RADIUS * oracle.uy)).toBeLessThan(RADIUS * 1e-9);
  });
});

describe('launch geometry: velocity is the exact sum of three terms', () => {
  test('on a circular-orbit host, each term matches its closed form', () => {
    const MU_STAR = 1.32712440018e20;
    const a = 1.495978707e11; // 1 au
    const hostRadius = 6.371e6;
    const hostRotationPeriod = 90000;
    const axialPhaseAtEpoch = 0.5;
    const longitude = -0.3;
    const headingRad = 2.1;

    const twoBody = scenario({
      bodies: [
        { parent: -1, mu: MU_STAR, radius: 6.957e8, rotationPeriod: 2.2e6, axialPhaseAtEpoch: 0 },
        {
          parent: 0,
          mu: MU,
          radius: hostRadius,
          a,
          e: 0,
          argPeriapsis: 0,
          meanAnomaly0: 0,
          rotationPeriod: hostRotationPeriod,
          axialPhaseAtEpoch,
        },
      ],
      rails: [{ ...DEFAULT_RAIL, host: 1, longitude }],
    });
    const sim = createSim({ scenario: twoBody, seed: 1 });

    const speed = 4000; // m/s
    const heading = Math.round((headingRad / (2 * Math.PI)) * HEADING_TURN);
    applyCommand({ sim, command: launch({ tick: 0, heading, speed: speed * 1000 }) });

    const t = 0;
    const orbitalSpeed = Math.sqrt(MU_STAR / a); // closed form, circular orbit
    // theta = meanAnomaly0 (0) at t=0 for a circular orbit: position along
    // +x, velocity purely tangential (0, orbitalSpeed) -- vis-viva/circular
    // closed form, independent of the ephemeris implementation.
    const hostVx = 0;
    const hostVy = orbitalSpeed;

    const oracle = railOracle({
      t,
      rotationPeriod: hostRotationPeriod,
      axialPhaseAtEpoch,
      longitude,
      radius: hostRadius,
    });
    const muzzleVx = speed * Math.cos(heading * ((2 * Math.PI) / HEADING_TURN));
    const muzzleVy = speed * Math.sin(heading * ((2 * Math.PI) / HEADING_TURN));

    const expectedVx = hostVx + oracle.rotVx + muzzleVx;
    const expectedVy = hostVy + oracle.rotVy + muzzleVy;

    expect(Math.abs(sim.objects.vx[0]! - expectedVx)).toBeLessThan(1e-3);
    expect(Math.abs(sim.objects.vy[0]! - expectedVy)).toBeLessThan(1e-3);
  });
});

describe('checkLaunch', () => {
  test('is pure: the hash is unchanged after calling it', () => {
    const sim = makeSim();
    applyCommand({ sim, command: launch({ tick: 0 }) });
    advance({ sim, log: [], ticks: 5 });
    const before = hashSim(sim);

    checkLaunch({ sim, command: launch({ tick: sim.tick, rail: 0 }) });

    expect(hashSim(sim)).toBe(before);
  });

  test('returns null for an acceptable launch', () => {
    const sim = makeSim();
    expect(checkLaunch({ sim, command: launch() })).toBeNull();
  });

  test("returns 'capacity' once the object cap is reached", () => {
    const sim = makeSim({ capacity: 1 });
    applyCommand({ sim, command: launch() });
    expect(checkLaunch({ sim, command: launch({ tick: 1 }) })).toBe('capacity');
  });

  describe('speed band', () => {
    const railSpeedBand: RailDef = { ...DEFAULT_RAIL, muzzleSpeedMin: 1000, muzzleSpeedMax: 5000 };

    test('accepts the band edges, min and max', () => {
      const sim = makeSim({ rails: [railSpeedBand] });
      expect(checkLaunch({ sim, command: launch({ speed: 1_000_000 }) })).toBeNull();
      expect(checkLaunch({ sim, command: launch({ speed: 5_000_000 }) })).toBeNull();
    });

    test('rejects just below min and just above max', () => {
      const sim = makeSim({ rails: [railSpeedBand] });
      expect(checkLaunch({ sim, command: launch({ speed: 999_999 }) })).toBe('speed');
      expect(checkLaunch({ sim, command: launch({ speed: 5_000_001 }) })).toBe('speed');
    });
  });

  describe('heading cone', () => {
    // A 60 deg half-angle: cos(60 deg) = 0.5 exactly, which lets the edge be
    // expressed as a whole-number heading fraction rather than a rounded one.
    const headingConeRad = Math.PI / 3;
    const railNarrowCone: RailDef = { ...DEFAULT_RAIL, headingCone: headingConeRad };

    test('accepts a heading exactly on the local vertical (dot = 1)', () => {
      const sim = makeSim({ rails: [railNarrowCone] });
      expect(checkLaunch({ sim, command: launch({ heading: 0 }) })).toBeNull();
    });

    test('accepts a heading exactly at the cone edge, rejects just outside it', () => {
      const sim = makeSim({ rails: [railNarrowCone] });
      // The local vertical is (1, 0) at t=0 (axialPhaseAtEpoch = longitude =
      // 0); the cone edge is headingConeRad away from it. Math.floor, not
      // .round: the reconstructed heading must land at or inside the cone,
      // never a hair past it, or the "accepts the edge" half of this test
      // would be flaky at the boundary.
      const edgeHeading = Math.floor((headingConeRad / (2 * Math.PI)) * HEADING_TURN);
      expect(checkLaunch({ sim, command: launch({ heading: edgeHeading }) })).toBeNull();
      expect(checkLaunch({ sim, command: launch({ heading: edgeHeading + 1000 }) })).toBe('cone');
    });

    test('rejects a heading pointing straight into the surface (dot = -1)', () => {
      const sim = makeSim({ rails: [railNarrowCone] });
      const oppositeHeading = HEADING_TURN / 2;
      expect(checkLaunch({ sim, command: launch({ heading: oppositeHeading }) })).toBe('cone');
    });

    test('headingCone = pi accepts every heading, including straight into the surface', () => {
      const sim = makeSim(); // DEFAULT_RAIL has headingCone: Math.PI
      expect(checkLaunch({ sim, command: launch({ heading: HEADING_TURN / 2 }) })).toBeNull();
    });
  });

  describe('reload', () => {
    const railReload: RailDef = { ...DEFAULT_RAIL, reloadTicks: 100 };

    test('a rail that has never fired needs no reload wait', () => {
      const sim = makeSim({ rails: [railReload] });
      expect(checkLaunch({ sim, command: launch({ tick: 0 }) })).toBeNull();
    });

    test('a second launch from the same rail on the same tick is rejected as reloading', () => {
      const sim = makeSim({ rails: [railReload] });
      applyCommand({ sim, command: launch({ tick: 0 }) });
      expect(checkLaunch({ sim, command: launch({ tick: 0 }) })).toBe('reloading');
      expect(() => applyCommand({ sim, command: launch({ tick: 0 }) })).toThrow();
    });

    test('rejects before reloadTicks have passed, accepts once they have', () => {
      const sim = makeSim({ rails: [railReload] });
      applyCommand({ sim, command: launch({ tick: 0 }) });
      expect(checkLaunch({ sim, command: launch({ tick: 99 }) })).toBe('reloading');
      expect(checkLaunch({ sim, command: launch({ tick: 100 }) })).toBeNull();
    });

    test('reloadTicks: 0 allows an immediate second launch from a different rail firing, but not the same tick from itself without reload', () => {
      // reloadTicks: 0 means "no wait": the very next tick is fine, and
      // even the same tick is fine once the earlier launch's own state
      // update is accounted for -- covered by DEFAULT_RAIL's own tests
      // above (reloadTicks: 0). This test instead confirms zero reload
      // ticks still records a last-launch tick that a *tighter* rail
      // definition could reload against.
      const sim = makeSim(); // DEFAULT_RAIL: reloadTicks 0
      applyCommand({ sim, command: launch({ tick: 0 }) });
      expect(sim.railLastLaunchTick[0]).toBe(0);
      expect(checkLaunch({ sim, command: launch({ tick: 0 }) })).toBeNull();
    });
  });
});

describe('launch window: the rail sweeps with rotation', () => {
  // GAME-0001 §4.2: "launch bearing sweeps with the host's spin, which makes
  // the launch window a rotation phase". A narrow cone (60 deg half-angle)
  // around the local vertical: the same absolute heading is reachable at
  // t=0, unreachable half a rotation later (the local vertical has turned
  // to point the opposite way), and reachable again a full rotation later.
  const rail: RailDef = { ...DEFAULT_RAIL, headingCone: Math.PI / 3 };

  test("accepted at t=0, rejected as 'cone' at T/2, accepted again at T", () => {
    const sim = makeSim({ rails: [rail] });
    const halfPeriodTicks = ROTATION_PERIOD / 2 / DT; // 720, exact
    const fullPeriodTicks = ROTATION_PERIOD / DT; // 1440, exact

    expect(checkLaunch({ sim, command: launch({ tick: 0, heading: 0 }) })).toBeNull();
    expect(checkLaunch({ sim, command: launch({ tick: halfPeriodTicks, heading: 0 }) })).toBe(
      'cone',
    );
    expect(checkLaunch({ sim, command: launch({ tick: fullPeriodTicks, heading: 0 }) })).toBeNull();
  });
});

describe('no self-collision on launch', () => {
  // A real rail (Earth-like host, km/s-class muzzle speeds): checks the
  // endpoint collision test (step.ts's testCollisions) never flags a probe
  // that launched outward, including at the cone's edge where the muzzle's
  // radial component is smallest (docs/work/GRV-0014's acceptance).
  const cone = 80 * (Math.PI / 180); // 80 deg half-angle
  const rail: RailDef = {
    host: 0,
    longitude: 0,
    muzzleSpeedMin: 1000,
    muzzleSpeedMax: 20000,
    headingCone: cone,
    reloadTicks: 0,
  };

  test('a launch straight along the local vertical never collides on the first tick', () => {
    const sim = makeSim({ rails: [rail] });
    applyCommand({ sim, command: launch({ heading: 0, speed: 5_000_000 }) });
    advance({ sim, log: [], ticks: 1 });
    expect(sim.objects.hitBody[0]).toBe(-1);
  });

  test('a launch exactly at the cone edge never collides on the first tick', () => {
    const sim = makeSim({ rails: [rail] });
    // Math.floor, not .round: stay strictly inside the accepted cone (see
    // the identical reasoning in the checkLaunch cone-edge test above).
    const edgeHeading = Math.floor((cone / (2 * Math.PI)) * HEADING_TURN);
    applyCommand({ sim, command: launch({ heading: edgeHeading, speed: 5_000_000 }) });
    advance({ sim, log: [], ticks: 1 });
    expect(sim.objects.hitBody[0]).toBe(-1);
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
  const SPEED_MM_S = 200_000_000; // 200 km/s, relative to the rail
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
