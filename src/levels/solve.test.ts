// solveLevel and its building blocks (docs/work/GRV-0018-level-solver.md). The objective and
// coarse-rung helpers are tested against closed forms and synthetic scenarios first, since they
// have no fs/CLI surface of their own; the full search is tested against the committed compiler
// fixture (ignoring its committed solution) and against small synthetic scenarios crafted to be
// unreachable, mirroring levels-verify.test.ts's own style for scenarios that don't need to be
// physically meaningful.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  coarsenScenario,
  evaluateLaunch,
  quantizeHeading,
  quantizeSpeed,
  solveLevel,
  sweptSegmentDistance,
  toCoarseTick,
  toFineTick,
} from './solve.ts';
import { verifyLevel } from './verify.ts';
import type { LevelSolution } from './verify.ts';
import type { CompiledLevel } from './compile.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';
import { HEADING_TURN } from '../sim/commands.ts';
import type { Scenario } from '../sim/sim.ts';

function loadFixture(): CompiledLevel {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'levels', 'T00-compiler-fixture.level.json'), 'utf8'),
  ) as CompiledLevel;
}

describe('sweptSegmentDistance', () => {
  test('a stationary contact and a probe flying a straight line past it: clamped point-segment distance', () => {
    // Probe flies from (-10, 5) to (10, 5) over the tick; contact sits at the origin. Relative
    // motion is the same straight line, so the closed form is the classic point-to-segment
    // distance: closest point is (0, 5), distance 5.
    const d = sweptSegmentDistance({
      probeStart: { x: -10, y: 5 },
      probeEnd: { x: 10, y: 5 },
      contactStart: { x: 0, y: 0 },
      contactEnd: { x: 0, y: 0 },
    });
    expect(d).toBeCloseTo(5, 10);
  });

  test('closest point off the far end of the segment clamps to s=1', () => {
    // The relative segment runs from (0,0) to (10,0); the contact is nearest the far endpoint,
    // so closest approach clamps to s=1 rather than extrapolating past it.
    const d = sweptSegmentDistance({
      probeStart: { x: 0, y: 0 },
      probeEnd: { x: 10, y: 0 },
      contactStart: { x: 15, y: 3 },
      contactEnd: { x: 15, y: 3 },
    });
    expect(d).toBeCloseTo(Math.hypot(10 - 15, 0 - 3), 10);
  });

  test('closest point off the near end clamps to s=0', () => {
    const d = sweptSegmentDistance({
      probeStart: { x: 0, y: 0 },
      probeEnd: { x: 10, y: 0 },
      contactStart: { x: -5, y: 4 },
      contactEnd: { x: -5, y: 4 },
    });
    expect(d).toBeCloseTo(Math.hypot(0 - -5, 0 - 4), 10);
  });

  test('zero relative motion: distance is the (constant) separation at either endpoint', () => {
    const d = sweptSegmentDistance({
      probeStart: { x: 3, y: 4 },
      probeEnd: { x: 3, y: 4 },
      contactStart: { x: 0, y: 0 },
      contactEnd: { x: 0, y: 0 },
    });
    expect(d).toBe(5);
  });
});

describe('coarsenScenario', () => {
  const base: Scenario = {
    dt: 30,
    capacity: 1,
    burnNodeCapacity: 0,
    bodies: [],
    rails: [
      {
        host: 0,
        longitude: 0,
        muzzleSpeedMin: 1,
        muzzleSpeedMax: 2,
        headingCone: 1,
        reloadTicks: 10,
      },
      {
        host: 0,
        longitude: 0,
        muzzleSpeedMin: 1,
        muzzleSpeedMax: 2,
        headingCone: 1,
        reloadTicks: 7,
      },
    ],
    contacts: [],
    probe: { dryMass: 1, propellantMass: 1, exhaustVelocity: 1, thrust: 1 },
    streams: [],
  };

  test('dt is multiplied and reloadTicks scales up, rounding up, without mutating the original', () => {
    const original = structuredClone(base);
    const coarse = coarsenScenario({ scenario: base, multiple: 4 });

    expect(coarse.dt).toBe(120);
    expect(coarse.rails[0]!.reloadTicks).toBe(3); // ceil(10/4)
    expect(coarse.rails[1]!.reloadTicks).toBe(2); // ceil(7/4)
    expect(base).toEqual(original);
  });

  test('multiple 1 is a no-op on dt and reloadTicks', () => {
    const coarse = coarsenScenario({ scenario: base, multiple: 1 });
    expect(coarse.dt).toBe(base.dt);
    expect(coarse.rails.map((r) => r.reloadTicks)).toEqual(base.rails.map((r) => r.reloadTicks));
  });
});

describe('toCoarseTick / toFineTick', () => {
  test('round-trips exactly when the fine tick is a multiple of the rung', () => {
    for (const [fineTick, multiple] of [
      [0, 4],
      [400, 4],
      [4096, 16],
    ] as const) {
      expect(toFineTick(toCoarseTick(fineTick, multiple), multiple)).toBe(fineTick);
    }
  });

  test('toFineTick is an exact multiply -- the inverse a caller can always trust', () => {
    expect(toFineTick(7, 16)).toBe(112);
  });
});

describe('quantizeHeading / quantizeSpeed', () => {
  test('heading wraps into [0, HEADING_TURN) for any real radian value', () => {
    expect(quantizeHeading(0)).toBe(0);
    expect(quantizeHeading(-0.0000001)).toBeLessThan(HEADING_TURN);
    expect(quantizeHeading(-0.0000001)).toBeGreaterThanOrEqual(0);
    expect(quantizeHeading(2 * Math.PI + 0.5)).toBe(quantizeHeading(0.5));
  });

  test('speed rounds to the nearest mm/s and never goes negative', () => {
    expect(quantizeSpeed(1.2345)).toBe(1235);
    expect(quantizeSpeed(-5)).toBe(0);
  });
});

describe('evaluateLaunch: penalties ordered sensibly (rejected > body hit > miss)', () => {
  // A star with a moon on a wide, near-circular orbit (a=1e9 m, so its own orbital speed is
  // negligible next to the rail's muzzle band -- a straight shot at the star stays straight
  // enough to land on it). Rail on the moon's near side (longitude pi, facing the star): the
  // geometry (verified directly -- runs/ throwaway, not committed) puts the local vertical
  // exactly at absolute heading pi, so heading 0 is dead opposite it and clearly outside a 0.2
  // rad cone, while heading pi is dead centre.
  const scenario: Scenario = {
    dt: 30,
    capacity: 1,
    burnNodeCapacity: 0,
    bodies: [
      { parent: -1, mu: 1e12, radius: 5e7, rotationPeriod: 1e9, axialPhaseAtEpoch: 0 },
      {
        parent: 0,
        mu: 1e5,
        radius: 1.0e6,
        a: 1e9,
        e: 0,
        argPeriapsis: 0,
        meanAnomaly0: 0,
        rotationPeriod: 1e9,
        axialPhaseAtEpoch: 0,
      },
    ],
    rails: [
      {
        host: 1,
        longitude: Math.PI,
        muzzleSpeedMin: 1000,
        muzzleSpeedMax: 5000,
        headingCone: 0.2,
        reloadTicks: 5,
      },
    ],
    contacts: [{ host: 0, longitude: Math.PI / 2, captureRadius: 1e5, minimumImpactEnergy: 1e6 }],
    probe: { dryMass: 100, propellantMass: 0, exhaustVelocity: 1000, thrust: 1 },
    streams: [],
  };

  function evalAt(headingRad: number, speedMps: number, maxFlightTicks: number) {
    return evaluateLaunch({
      scenario,
      seed: 1,
      priorLog: [],
      railIndex: 0,
      contactIndex: 0,
      launchTick: 0,
      headingRad,
      speedMps,
      maxFlightTicks,
    });
  }

  test('a launch outside the cone is rejected', () => {
    const result = evalAt(0, 3000, 500); // dead opposite the local vertical
    expect(result.rejection).toBe('cone');
    expect(result.bodyHit).toBe(false);
    expect(result.cleared).toBe(false);
  });

  test('a launch aimed straight at the (much larger) star hits its body', () => {
    const result = evalAt(Math.PI, 5000, 7000); // dead centre in the cone, long enough to arrive
    expect(result.rejection).toBeNull();
    expect(result.bodyHit).toBe(true);
    expect(result.cleared).toBe(false);
  });

  test('the same heading with too little flight time to arrive is a plain miss', () => {
    const result = evalAt(Math.PI, 3000, 500); // same direction, far too short a flight
    expect(result.rejection).toBeNull();
    expect(result.bodyHit).toBe(false);
    expect(result.cleared).toBe(false);
    expect(result.distance).toBeGreaterThan(0);
  });

  test('rejected > body hit > miss, using representative values from each tier', () => {
    const rejected = evalAt(0, 3000, 500);
    const bodyHit = evalAt(Math.PI, 5000, 7000);
    const miss = evalAt(Math.PI, 3000, 500);

    expect(rejected.distance).toBeGreaterThan(bodyHit.distance);
    expect(bodyHit.distance).toBeGreaterThan(miss.distance);
  });
});

describe('evaluateLaunch: against the real compiler fixture', () => {
  test('the committed solution scores at or near zero (it clears)', () => {
    const level = loadFixture();
    const result = evaluateLaunch({
      scenario: level.scenario,
      seed: level.seed,
      priorLog: [],
      railIndex: 0,
      contactIndex: 0,
      launchTick: 0,
      headingRad: (2570577009 / HEADING_TURN) * 2 * Math.PI,
      speedMps: 65426813 / 1000,
      maxFlightTicks: 220,
    });
    expect(result.cleared).toBe(true);
    expect(result.distance).toBeLessThanOrEqual(0);
  });

  test('a heading pointed far from the target scores a large real miss, not a penalty tier', () => {
    const level = loadFixture();
    const result = evaluateLaunch({
      scenario: level.scenario,
      seed: level.seed,
      priorLog: [],
      railIndex: 0,
      contactIndex: 0,
      launchTick: 0,
      headingRad: (2570577009 / HEADING_TURN) * 2 * Math.PI + 0.3,
      speedMps: 65426813 / 1000,
      maxFlightTicks: 220,
    });
    expect(result.cleared).toBe(false);
    expect(result.distance).toBeLessThan(1e14); // not a body-hit/reject penalty
    expect(result.distance).toBeGreaterThan(0);
  });
});

// A real solve takes ~4 s here and more on CI runners; vitest's default is 5 s.
const SOLVE_TIMEOUT_MS = 120_000;

describe('solveLevel: the compiler fixture, from scratch', () => {
  test(
    'finds a launch that clears, ignoring the committed solution, and passes verifyLevel',
    () => {
      const level = loadFixture();
      const result = solveLevel({
        level,
        options: { window: { start: 0, end: 30 }, maxFlightTicks: 260, budget: 4000 },
      });

      if (!('solution' in result))
        throw new Error(`expected a solution, got failure: ${result.failure}`);
      const solution: LevelSolution = result.solution;
      expect(solution.level).toBe(level.id);

      const { evidence, failures } = verifyLevel({
        level,
        levelHash: 'sha256:test',
        solution,
        solutionHash: 'sha256:test',
      });
      expect(failures).toEqual([]);
      expect(evidence.outcome.contactsCleared).toBe(evidence.outcome.contactsTotal);
    },
    SOLVE_TIMEOUT_MS,
  );

  test('determinism: two runs on the same level produce byte-identical solutions', () => {
    const level = loadFixture();
    const options = { window: { start: 0, end: 30 }, maxFlightTicks: 260, budget: 4000 };
    const a = solveLevel({ level, options });
    const b = solveLevel({ level, options });

    if (!('solution' in a) || !('solution' in b)) throw new Error('expected both runs to solve');
    expect(a.solution).toEqual(b.solution);
  }, 20000);
});

describe('solveLevel: an unreachable contact fails cleanly, respecting the budget', () => {
  test('a contact on the far side of a non-spinning body, with a window too short to reach it', () => {
    const level: CompiledLevel = {
      schema: 1,
      id: 'unreachable',
      name: 'unreachable',
      brief: 'b',
      debrief: 'd',
      seed: 1,
      names: { bodies: ['Star', 'Rock'], rails: ['r'], contacts: ['c'] },
      bodyIds: ['star', 'rock'],
      railIds: ['r'],
      contactIds: ['c'],
      bodyClasses: ['star', 'rock'],
      scenario: {
        dt: 30,
        capacity: 3,
        burnNodeCapacity: 0,
        bodies: [
          {
            parent: -1,
            mu: 1.26687e17,
            radius: 7.1492e7,
            rotationPeriod: 1e9,
            axialPhaseAtEpoch: 0,
          },
          {
            parent: 0,
            mu: 4.9e12,
            radius: 1.0e6,
            a: 4.217e8,
            e: 0,
            argPeriapsis: 0,
            meanAnomaly0: 0,
            rotationPeriod: 1e9, // effectively non-spinning within any short window
            axialPhaseAtEpoch: 0,
          },
        ],
        rails: [
          {
            host: 1,
            longitude: 0, // near side, facing the star -- the contact sits on the far side
            muzzleSpeedMin: 100,
            muzzleSpeedMax: 200,
            headingCone: 0.05,
            reloadTicks: 5,
          },
        ],
        contacts: [{ host: 1, longitude: Math.PI, captureRadius: 1000, minimumImpactEnergy: 1 }],
        probe: { dryMass: 100, propellantMass: 0, exhaustVelocity: 1000, thrust: 1 },
        streams: [],
      },
    };

    const start = Date.now();
    const result = solveLevel({
      level,
      options: { window: { start: 0, end: 10 }, maxFlightTicks: 50, budget: 300 },
    });
    const wallMs = Date.now() - start;

    expect('failure' in result).toBe(true);
    if ('failure' in result) {
      expect(typeof result.failure).toBe('string');
      expect(result.best.length).toBe(1);
      expect(result.best[0]!.contactId).toBe('c');
    }
    expect(wallMs).toBeLessThan(10000); // budget respected, not an endless loop
  });
});
