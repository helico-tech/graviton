// predictProbe (GRV-0027 design note "predictions for running probes"): a running probe is a plan
// already launched -- its remaining flight is predicted by replaying the committed log from now to
// a horizon and reading off closest-approach/impact/body-hit events, matching what the live
// simulation will actually do (not a second model). Exercised against level 01's real committed
// solution, mirroring src/planner/ghost.test.ts's own fixture-loading style.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { downlinkArrivalOf, predictProbe, predictProbePath } from './predict.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import { advance, createSim } from '../sim/sim.ts';
import type { Command, Scenario } from '../sim/sim.ts';
import { observedState } from '../sim/telemetry.ts';
import { postPositionAtTime } from '../sim/post.ts';
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
// (levels/L01-intercept.solution.json) fires at tick 2464. The post sits on the rail's own host
// (GRV-0029), but the probe itself has travelled well away from home by impact -- confirmed
// directly against the running level: telemetry of the impact reaches the post one tick later.
const L01_LAUNCH_TICK = 2464;
const L01_IMPACT_TICK = 3298;
const L01_IMPACT_ARRIVAL_TICK = 3299;

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
    expect(impact).toEqual({
      tick: L01_IMPACT_TICK,
      kind: 'impact',
      probe: 0,
      contact: 0,
      arrivalTick: L01_IMPACT_ARRIVAL_TICK,
    });
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
      arrivalTick: L01_IMPACT_ARRIVAL_TICK,
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

function loadT01(): { level: CompiledLevel; solution: Command[] } {
  return {
    level: loadJson<CompiledLevel>('levels', 'T01-far-post.level.json'),
    solution: loadJson<{ log: Command[] }>('levels', 'T01-far-post.solution.json').log,
  };
}

describe('downlinkArrivalOf', () => {
  test('round-trips through observedState/downlinkEmission (the same light-cone equation, solved the other way) on T01’s own real ~20-tick delay', () => {
    const { level, solution } = loadT01();
    const sim = createSim({ scenario: level.scenario, seed: level.seed });
    const emissionTick = 5900; // well after materialisation (5744), well before impact (5806)
    advance({ sim, log: solution, ticks: emissionTick });
    const x = sim.objects.x[0]!;
    const y = sim.objects.y[0]!;

    const receiveTick = downlinkArrivalOf({ sim, emissionTick, x, y });
    expect(receiveTick).toBeGreaterThan(emissionTick); // a real, positive delay (~20 ticks)
    expect(receiveTick - emissionTick).toBeGreaterThan(15);
    expect(receiveTick - emissionTick).toBeLessThan(25);

    advance({ sim, log: solution, ticks: receiveTick - sim.tick });
    const observed = observedState({ sim, object: 0, atTick: receiveTick });
    expect(observed).not.toBeNull();
    // ceil (uplink/downlink-arrival) vs floor (downlink-emission) quantise oppositely, so the
    // round trip lands within a tick of the original, never exactly it by construction.
    expect(Math.abs(observed!.emissionTick - emissionTick)).toBeLessThanOrEqual(1);
  });

  test('a source sitting exactly on the post has zero delay', () => {
    const level = wrapAsLevel(scenario());
    const sim = createSim({ scenario: level.scenario, seed: level.seed });
    const post = postPositionAtTime({ sim, t: 0 });
    const receiveTick = downlinkArrivalOf({ sim, emissionTick: 0, x: post.x, y: post.y });
    expect(receiveTick).toBe(0);
  });
});

describe('predictProbePath', () => {
  test('samples the same trajectory predictProbe itself integrates, one point per tick', () => {
    const level = loadLevel();
    const solution = loadSolution().log;
    const fromTick = L01_LAUNCH_TICK + 100;
    const horizonTick = fromTick + 50;

    const path = predictProbePath({ level, log: solution, probe: 0, fromTick, horizonTick });
    expect(path).toHaveLength(horizonTick - fromTick + 1);
    expect(path[0]!.tick).toBe(fromTick);
    expect(path.at(-1)!.tick).toBe(horizonTick);

    const reference = createSim({ scenario: level.scenario, seed: level.seed });
    advance({ sim: reference, log: solution, ticks: fromTick });
    expect(path[0]!.x).toBe(reference.objects.x[0]);
    expect(path[0]!.y).toBe(reference.objects.y[0]);
  });

  test('an unlaunched probe has no path', () => {
    const level = loadLevel();
    expect(predictProbePath({ level, log: [], probe: 0, fromTick: 0, horizonTick: 50 })).toEqual(
      [],
    );
  });

  test('fromTick before materialisation advances to wherever the probe actually starts existing (GRV-0031, uplinkWindows’ own whole-flight path)', () => {
    const level = loadLevel();
    const solution = loadSolution().log;

    const path = predictProbePath({
      level,
      log: solution,
      probe: 0,
      fromTick: 0, // well before L01_LAUNCH_TICK (2464)
      horizonTick: L01_LAUNCH_TICK + 50,
    });
    // advance's own cursor applies a tick-2464 command while sim.tick is still 2464, only
    // incrementing to 2465 once that same call returns -- one tick later than the launch's own
    // arrival tick is the earliest this loop's plain one-tick-at-a-time advance can observe it.
    expect(path[0]!.tick).toBe(L01_LAUNCH_TICK + 1);
    expect(path.at(-1)!.tick).toBe(L01_LAUNCH_TICK + 50);
  });
});
