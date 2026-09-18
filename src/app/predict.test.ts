// predictProbe (GRV-0027 design note "predictions for running probes"): a running probe is a plan
// already launched -- its remaining flight is predicted by replaying the committed log from now to
// a horizon and reading off closest-approach/impact/body-hit events, matching what the live
// simulation will actually do (not a second model). Exercised against level 01's real committed
// solution, mirroring src/planner/ghost.test.ts's own fixture-loading style.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { predictProbe } from './predict.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import { advance, createSim } from '../sim/sim.ts';
import type { Command, Scenario } from '../sim/sim.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';

function loadJson<T>(...parts: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')) as T;
}

function loadLevel(): CompiledLevel {
  return loadJson<CompiledLevel>('levels', 'L01-intercept.level.json');
}

function loadSolution(): { log: Command[] } {
  return loadJson<{ log: Command[] }>('levels', 'L01-intercept.solution.json');
}

// levels/L01-intercept.evidence.json's own recorded outcome; the solution's own launch command
// (levels/L01-intercept.solution.json) fires at tick 2464.
const L01_LAUNCH_TICK = 2464;
const L01_IMPACT_TICK = 3298;

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
    post: { host: 0, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: [],
    ...overrides,
  };
}

function wrapAsLevel(scenarioValue: Scenario, seed = 1): CompiledLevel {
  return {
    schema: 1,
    id: '',
    name: '',
    brief: '',
    debrief: '',
    seed,
    names: { bodies: [], rails: [], contacts: [] },
    bodyIds: [],
    railIds: [],
    contactIds: [],
    bodyClasses: [],
    scenario: scenarioValue,
  };
}

describe('predictProbe', () => {
  test('finds level 01’s real impact tick when predicting from partway through the flight', () => {
    const level = loadLevel();
    const solution = loadSolution().log;

    const events = predictProbe({
      level,
      log: solution,
      probe: 0,
      fromTick: L01_LAUNCH_TICK + 100, // well after launch, well before the recorded impact
      horizonTick: 6000,
    });

    const impact = events.find((e) => e.kind === 'impact');
    expect(impact).toEqual({ tick: L01_IMPACT_TICK, kind: 'impact', probe: 0, contact: 0 });
  });

  test('predicting from just after launch finds the same impact tick as predicting from just before impact', () => {
    const level = loadLevel();
    const solution = loadSolution().log;

    const fromLaunch = predictProbe({
      level,
      log: solution,
      probe: 0,
      fromTick: L01_LAUNCH_TICK + 1,
      horizonTick: 6000,
    });
    const fromLate = predictProbe({
      level,
      log: solution,
      probe: 0,
      fromTick: L01_IMPACT_TICK - 10,
      horizonTick: 6000,
    });

    expect(fromLaunch.find((e) => e.kind === 'impact')).toEqual(
      fromLate.find((e) => e.kind === 'impact'),
    );
    expect(fromLaunch.find((e) => e.kind === 'impact')).toEqual({
      tick: L01_IMPACT_TICK,
      kind: 'impact',
      probe: 0,
      contact: 0,
    });
  });

  test('an unlaunched probe index predicts nothing', () => {
    const level = loadLevel();
    const events = predictProbe({
      level,
      log: [],
      probe: 0,
      fromTick: 0,
      horizonTick: 100,
    });
    expect(events).toEqual([]);
  });

  test('an already-expended probe predicts nothing (an expended object never moves again)', () => {
    const level = loadLevel();
    const solution = loadSolution().log;
    const events = predictProbe({
      level,
      log: solution,
      probe: 0,
      fromTick: L01_IMPACT_TICK + 50, // well past the recorded impact
      horizonTick: L01_IMPACT_TICK + 500,
    });
    expect(events).toEqual([]);
  });

  test('a straight-line probe with no contacts to close in on predicts no closest approach', () => {
    const level = wrapAsLevel(scenario());
    const log: Command[] = [{ tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 8_000_000 }];
    const events = predictProbe({ level, log, probe: 0, fromTick: 0, horizonTick: 50 });
    expect(events).toEqual([]);
  });

  test('matches a live sim advanced with the same committed log (never a second model)', () => {
    const level = loadLevel();
    const solution = loadSolution().log;

    const predicted = predictProbe({
      level,
      log: solution,
      probe: 0,
      fromTick: L01_LAUNCH_TICK + 200,
      horizonTick: 6000,
    });
    const impact = predicted.find((e) => e.kind === 'impact')!;

    const reference = createSim({ scenario: level.scenario, seed: level.seed });
    advance({ sim: reference, log: solution, ticks: L01_IMPACT_TICK + 1 });
    expect(reference.objects.hitContact[0]).toBe(0);
    expect(reference.contactState.impactTick[0]).toBe(impact.tick);
  });
});
