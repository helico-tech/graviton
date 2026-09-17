// verifyLevel: replay -> evidence (docs/work/GRV-0017-level-verifier-and-evidence.md). Exercised
// against the committed T00-compiler-fixture (compiled JSON + solution), the same fixture
// fixture.test.ts already proves loads into the real simulation, so a real solved level backs
// every assertion here instead of a hand-built scenario.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { canonicalJson } from './compile.ts';
import type { CompiledLevel } from './compile.ts';
import { compareDtConvergence, doubleLogTicks, halveDt, verifyLevel } from './verify.ts';
import type { LevelSolution } from './verify.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';
import { SIM_VERSION } from '../sim/version.ts';
import type { Command, Scenario } from '../sim/sim.ts';

const LEVEL_HASH = 'sha256:level-hash-placeholder';
const SOLUTION_HASH = 'sha256:solution-hash-placeholder';

function loadFixture(): { level: CompiledLevel; solution: LevelSolution } {
  const level = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'levels', 'T00-compiler-fixture.level.json'), 'utf8'),
  ) as CompiledLevel;
  const solution = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'levels', 'T00-compiler-fixture.solution.json'), 'utf8'),
  ) as LevelSolution;
  return { level, solution };
}

describe('verifyLevel: the compiler fixture clears', () => {
  test('all contacts cleared, no failures', () => {
    const { level, solution } = loadFixture();
    const { evidence, failures } = verifyLevel({
      level,
      levelHash: LEVEL_HASH,
      solution,
      solutionHash: SOLUTION_HASH,
    });

    expect(failures).toEqual([]);
    expect(evidence.outcome.contactsCleared).toBe(evidence.outcome.contactsTotal);
    expect(evidence.contacts.every((c) => c.cleared)).toBe(true);
  });

  test('time of flight matches an independent (impactTick - launchTick) * dt computation', () => {
    const { level, solution } = loadFixture();
    const { evidence } = verifyLevel({
      level,
      levelHash: LEVEL_HASH,
      solution,
      solutionHash: SOLUTION_HASH,
    });

    const contact = evidence.contacts[0]!;
    const launchTick = solution.log[0]!.tick;
    expect(contact.timeOfFlightSeconds).toBe((contact.impactTick - launchTick) * level.scenario.dt);
  });

  test('propellant remaining matches the full tank -- the solved launch never burns', () => {
    const { level, solution } = loadFixture();
    const { evidence } = verifyLevel({
      level,
      levelHash: LEVEL_HASH,
      solution,
      solutionHash: SOLUTION_HASH,
    });

    expect(solution.log.every((c) => c.kind === 'launch')).toBe(true);
    expect(evidence.outcome.propellantRemaining).toEqual([level.scenario.probe.propellantMass]);
  });

  test('levelHash/solutionHash pass through verbatim', () => {
    const { level, solution } = loadFixture();
    const { evidence } = verifyLevel({
      level,
      levelHash: LEVEL_HASH,
      solution,
      solutionHash: SOLUTION_HASH,
    });

    expect(evidence.levelHash).toBe(LEVEL_HASH);
    expect(evidence.solutionHash).toBe(SOLUTION_HASH);
    expect(evidence.simVersion).toBe(SIM_VERSION);
  });

  test('deterministic: two runs are byte-identical through canonicalJson', () => {
    const { level, solution } = loadFixture();
    const a = verifyLevel({ level, levelHash: LEVEL_HASH, solution, solutionHash: SOLUTION_HASH });
    const b = verifyLevel({ level, levelHash: LEVEL_HASH, solution, solutionHash: SOLUTION_HASH });

    expect(canonicalJson(a.evidence)).toBe(canonicalJson(b.evidence));
  });
});

describe('verifyLevel: failure cases', () => {
  test('a solution that misses (heading perturbed far past the capture margin) fails "not all contacts cleared"', () => {
    const { level, solution } = loadFixture();
    const base = solution.log[0]!;
    if (base.kind !== 'launch') throw new Error('fixture solution must open with a launch');
    const missed: LevelSolution = {
      ...solution,
      log: [{ ...base, heading: (base.heading + 1_000_000) >>> 0 }],
    };

    const { evidence, failures } = verifyLevel({
      level,
      levelHash: LEVEL_HASH,
      solution: missed,
      solutionHash: SOLUTION_HASH,
    });

    expect(failures).toContain('not all contacts cleared');
    expect(evidence.outcome.contactsCleared).toBe(0);
  });

  test('a stale simVersion fails', () => {
    const { level, solution } = loadFixture();
    const stale: LevelSolution = { ...solution, simVersion: SIM_VERSION - 1 };

    const { failures } = verifyLevel({
      level,
      levelHash: LEVEL_HASH,
      solution: stale,
      solutionHash: SOLUTION_HASH,
    });

    expect(failures.some((f) => f.includes('simVersion'))).toBe(true);
  });

  test('a solution for the wrong level id fails', () => {
    const { level, solution } = loadFixture();
    const wrongLevel: LevelSolution = { ...solution, level: 'some-other-level' };

    const { failures } = verifyLevel({
      level,
      levelHash: LEVEL_HASH,
      solution: wrongLevel,
      solutionHash: SOLUTION_HASH,
    });

    expect(failures.some((f) => f.includes('some-other-level'))).toBe(true);
  });

  test('a command the simulation rejects is caught and reported, not thrown', () => {
    const { level, solution } = loadFixture();
    const base = solution.log[0]!;
    if (base.kind !== 'launch') throw new Error('fixture solution must open with a launch');
    const tooSlow: LevelSolution = { ...solution, log: [{ ...base, speed: 1_000_000 }] }; // 1000 m/s, below the rail's band

    let failures: string[] = [];
    expect(() => {
      ({ failures } = verifyLevel({
        level,
        levelHash: LEVEL_HASH,
        solution: tooSlow,
        solutionHash: SOLUTION_HASH,
      }));
    }).not.toThrow();
    expect(failures.some((f) => f.startsWith('command rejected:'))).toBe(true);
  });
});

describe('halveDt', () => {
  test('halves dt and doubles every rail reloadTicks, without mutating the original', () => {
    const scenario: Scenario = {
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
      ],
      contacts: [],
      probe: { dryMass: 1, propellantMass: 1, exhaustVelocity: 1, thrust: 1 },
      streams: [],
    };
    const original = structuredClone(scenario);

    const halved = halveDt(scenario);

    expect(halved.dt).toBe(15);
    expect(halved.rails[0]!.reloadTicks).toBe(20);
    expect(scenario).toEqual(original);
  });
});

describe('doubleLogTicks', () => {
  test('doubles a launch command tick, and a burn command tick and atTick, without mutating the original', () => {
    const log: Command[] = [
      { tick: 5, kind: 'launch', rail: 0, heading: 1, speed: 2 },
      { tick: 5, kind: 'burn', probe: 0, atTick: 8, prograde: 1, lateral: 0 },
    ];
    const original = structuredClone(log);

    const doubled = doubleLogTicks(log);

    expect(doubled).toEqual([
      { tick: 10, kind: 'launch', rail: 0, heading: 1, speed: 2 },
      { tick: 10, kind: 'burn', probe: 0, atTick: 16, prograde: 1, lateral: 0 },
    ]);
    expect(log).toEqual(original);
  });
});

describe('compareDtConvergence', () => {
  test('agrees when both runs clear the same contacts, and reports both impact times', () => {
    const result = compareDtConvergence({
      contactIds: ['a', 'b'],
      dt: 10,
      halfDt: 5,
      atDt: { cleared: [1, 1], impactTick: [20, 30], impactSpeed: [100, 200] },
      atHalfDt: { cleared: [1, 1], impactTick: [41, 59], impactSpeed: [101, 199] },
    });

    expect(result.agrees).toBe(true);
    expect(result.entries).toEqual([
      {
        id: 'a',
        clearedAtDt: true,
        clearedAtHalfDt: true,
        impactTimeSecondsAtDt: 200,
        impactTimeSecondsAtHalfDt: 205,
        impactTimeDifferenceSeconds: 5,
        closingSpeedAtDt: 100,
        closingSpeedAtHalfDt: 101,
      },
      {
        id: 'b',
        clearedAtDt: true,
        clearedAtHalfDt: true,
        impactTimeSecondsAtDt: 300,
        impactTimeSecondsAtHalfDt: 295,
        impactTimeDifferenceSeconds: 5,
        closingSpeedAtDt: 200,
        closingSpeedAtHalfDt: 199,
      },
    ]);
  });

  test('disagrees when the two runs clear a different set of contacts', () => {
    const result = compareDtConvergence({
      contactIds: ['a'],
      dt: 10,
      halfDt: 5,
      atDt: { cleared: [1], impactTick: [20], impactSpeed: [100] },
      atHalfDt: { cleared: [0], impactTick: [-1], impactSpeed: [0] },
    });

    expect(result.agrees).toBe(false);
    expect(result.entries[0]!.clearedAtDt).toBe(true);
    expect(result.entries[0]!.clearedAtHalfDt).toBe(false);
    expect(result.entries[0]!.impactTimeSecondsAtHalfDt).toBe(-1);
    expect(result.entries[0]!.impactTimeDifferenceSeconds).toBe(-1);
  });
});
