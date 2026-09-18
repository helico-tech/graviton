// Ghost invariant (docs/domain/simulation-determinism.md "Ghost invariant", GAME-0001 §7
// must-have 3): the planner's forward integration is the live simulation's own code path, so a
// ghost's samples must be bit-identical (Object.is per double) to a live simulation advanced with
// the same commands. Exercised against level 01's real committed solution (no nodes) and the
// flyby-burn golden (its own burn node plus a second one, with two other probes sharing its rail),
// mirroring golden-replay.test.ts's own fixtures rather than a hand-built scenario.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { integrateGhost } from './ghost.ts';
import { planToCommands } from './plan.ts';
import type { FlightPlan } from './plan.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import { advance, createSim } from '../sim/sim.ts';
import type { Command, Scenario } from '../sim/sim.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import { railGeometry } from '../sim/rails.ts';
import { quantizeHeading } from '../levels/solve.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';

interface LevelSolution {
  level: string;
  simVersion: number;
  ticks: number;
  log: Command[];
}

function loadJson<T>(...parts: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')) as T;
}

function loadLevel(): CompiledLevel {
  return loadJson<CompiledLevel>('levels', 'L01-intercept.level.json');
}

function loadSolution(): LevelSolution {
  return loadJson<LevelSolution>('levels', 'L01-intercept.solution.json');
}

interface GoldenFile {
  scenario: Scenario;
  seed: number;
  log: Command[];
  ticks: number;
}

function loadGolden(): GoldenFile {
  return loadJson<GoldenFile>('tests', 'golden', 'flyby-burn.json');
}

/** A golden fixture is a raw `{ scenario, seed }`, not a compiled level -- wrapped here with the
 *  fields `integrateGhost`/`validatePlan` actually read (`scenario`, `seed`) and empty/placeholder
 *  values for the rest, mirroring levels.ts's own restated `CompiledLevel` shape. */
function wrapAsLevel(golden: GoldenFile): CompiledLevel {
  return {
    schema: 1,
    id: 'flyby-burn',
    name: 'flyby-burn',
    brief: '',
    debrief: '',
    seed: golden.seed,
    names: { bodies: [], rails: [], contacts: [] },
    bodyIds: [],
    railIds: [],
    contactIds: [],
    bodyClasses: [],
    scenario: golden.scenario,
  };
}

/** Live reference: advances a fresh `Sim` one tick at a time with `commands` and samples the given
 *  probe's x/y/vx/vy/mass/burning after each tick -- the same "advance, then read straight from
 *  the typed arrays" shape as `captureFrame` and `debug-api.ts`'s `stepSampled`, plus one extra
 *  sample of the pristine pre-launch state at `fromTick` itself (matching `integrateGhost`'s own
 *  `horizonTick - fromTick + 1` buffer). */
function liveReferenceSamples({
  scenario,
  seed,
  commands,
  probeIndex,
  fromTick,
  horizonTick,
}: {
  scenario: Scenario;
  seed: number;
  commands: Command[];
  probeIndex: number;
  fromTick: number;
  horizonTick: number;
}): {
  x: number[];
  y: number[];
  vx: number[];
  vy: number[];
  mass: number[];
  burning: number[];
  impactTick: number[];
} {
  const sim = createSim({ scenario, seed });
  advance({ sim, log: commands, ticks: fromTick });

  const read = () => ({
    x: sim.objects.x[probeIndex]!,
    y: sim.objects.y[probeIndex]!,
    vx: sim.objects.vx[probeIndex]!,
    vy: sim.objects.vy[probeIndex]!,
    mass: sim.objects.mass[probeIndex]!,
    burning: sim.objects.burning[probeIndex]!,
  });

  const out = {
    x: [] as number[],
    y: [] as number[],
    vx: [] as number[],
    vy: [] as number[],
    mass: [] as number[],
    burning: [] as number[],
  };
  const push = (s: ReturnType<typeof read>) => {
    out.x.push(s.x);
    out.y.push(s.y);
    out.vx.push(s.vx);
    out.vy.push(s.vy);
    out.mass.push(s.mass);
    out.burning.push(s.burning);
  };
  push(read());
  for (let t = fromTick; t < horizonTick; t++) {
    advance({ sim, log: commands, ticks: 1 });
    push(read());
  }

  const impactTick: number[] = [];
  for (let c = 0; c < sim.contacts.count; c++) impactTick.push(sim.contactState.impactTick[c]!);

  return { ...out, impactTick };
}

/** Compares over the ghost's own `count`: the ghost stops early on an impact or a body hit, so its
 *  sample count can be shorter than the reference's (which keeps sampling to the horizon) -- the
 *  overlapping prefix must still be bit-identical, and the ghost must never claim more samples
 *  than the reference actually has. */
function expectSamplesIdentical(
  ghostSamples: {
    x: Float64Array;
    y: Float64Array;
    vx: Float64Array;
    vy: Float64Array;
    mass: Float64Array;
    burning: Uint8Array;
    count: number;
  },
  reference: {
    x: number[];
    y: number[];
    vx: number[];
    vy: number[];
    mass: number[];
    burning: number[];
  },
): void {
  expect(ghostSamples.count).toBeLessThanOrEqual(reference.x.length);
  for (let i = 0; i < ghostSamples.count; i++) {
    expect(Object.is(ghostSamples.x[i], reference.x[i])).toBe(true);
    expect(Object.is(ghostSamples.y[i], reference.y[i])).toBe(true);
    expect(Object.is(ghostSamples.vx[i], reference.vx[i])).toBe(true);
    expect(Object.is(ghostSamples.vy[i], reference.vy[i])).toBe(true);
    expect(Object.is(ghostSamples.mass[i], reference.mass[i])).toBe(true);
    expect(Object.is(ghostSamples.burning[i], reference.burning[i])).toBe(true);
  }
}

describe('ghost invariant: level 01, committed solution, no amendments', () => {
  test('the ghost is bit-identical to the live replay, and its impact tick matches contactState', () => {
    const level = loadLevel();
    const solution = loadSolution();
    const launch = solution.log[0]!;
    if (launch.kind !== 'launch') throw new Error('expected the solved launch command first');

    const plan: FlightPlan = {
      rail: launch.rail,
      launchTick: launch.tick,
      heading: launch.heading,
      speed: launch.speed,
      nodes: [],
    };

    const fromTick = 0;
    const horizonTick = solution.ticks;
    const { ghost } = integrateGhost({ level, log: [], plan, fromTick, horizonTick });

    const referenceSim = createSim({ scenario: level.scenario, seed: level.seed });
    const reference = liveReferenceSamples({
      scenario: level.scenario,
      seed: level.seed,
      commands: planToCommands({ sim: referenceSim, plan, probeIndex: 0 }),
      probeIndex: 0,
      fromTick,
      horizonTick,
    });

    expectSamplesIdentical(ghost.samples, reference);

    const impactEvent = ghost.events.find((e) => e.kind === 'impact');
    expect(impactEvent).toBeDefined();
    expect(impactEvent!.tick).toBe(reference.impactTick[0]);
    expect(ghost.contacts[0]!.cleared).toBe(true);
  });
});

describe('ghost invariant: flyby-burn golden, its burn node plus a second, among other probes', () => {
  test('the ghost is bit-identical to the live replay', () => {
    const golden = loadGolden();
    const level = wrapAsLevel(golden);
    const originalLaunch = golden.log[0]!;
    const originalBurn = golden.log[1]!;
    if (originalLaunch.kind !== 'launch' || originalBurn.kind !== 'burn')
      throw new Error('expected launch then burn in the golden log');

    const plan: FlightPlan = {
      rail: originalLaunch.rail,
      launchTick: originalLaunch.tick,
      heading: originalLaunch.heading,
      speed: originalLaunch.speed,
      nodes: [
        {
          atTick: originalBurn.atTick,
          prograde: originalBurn.prograde,
          lateral: originalBurn.lateral,
        },
        { atTick: 4500, prograde: 100000, lateral: 0 },
      ],
    };

    // Two other probes launched from the same rail, well clear of its 100-tick reload against the
    // ghost's own tick-0 launch and each other -- the ghost must still match the live sim with
    // them present (ADR-0005 "Dynamic objects": they never perturb each other or the ghost). The
    // rail's local vertical rotates with its host, so each probe's heading is aimed straight along
    // it (well inside the pi/2 cone) at its own launch tick rather than reusing tick 0's heading.
    const railLocalVerticalHeading = (tick: number): number => {
      const sim = createSim({ scenario: level.scenario, seed: level.seed });
      const eph = {
        x: new Float64Array(sim.bodies.count),
        y: new Float64Array(sim.bodies.count),
        vx: new Float64Array(sim.bodies.count),
        vy: new Float64Array(sim.bodies.count),
      };
      const t = tick * sim.scenario.dt;
      evaluateEphemeris(sim.bodies, t, eph);
      const geometry = railGeometry({
        bodies: sim.bodies,
        rails: sim.rails,
        rail: originalLaunch.rail,
        t,
        eph,
      });
      return quantizeHeading(Math.atan2(geometry.uy, geometry.ux));
    };
    const otherProbes: Command[] = [
      {
        tick: 500,
        kind: 'launch',
        rail: originalLaunch.rail,
        heading: railLocalVerticalHeading(500),
        speed: originalLaunch.speed,
      },
      {
        tick: 1000,
        kind: 'launch',
        rail: originalLaunch.rail,
        heading: railLocalVerticalHeading(1000),
        speed: originalLaunch.speed,
      },
    ];

    const fromTick = 0;
    const horizonTick = golden.ticks;
    const { ghost } = integrateGhost({ level, log: otherProbes, plan, fromTick, horizonTick });

    const referenceSim = createSim({ scenario: level.scenario, seed: level.seed });
    const commands = [
      ...otherProbes,
      ...planToCommands({ sim: referenceSim, plan, probeIndex: 0 }),
    ].sort((a, b) => a.tick - b.tick);
    const reference = liveReferenceSamples({
      scenario: level.scenario,
      seed: level.seed,
      commands,
      probeIndex: 0,
      fromTick,
      horizonTick,
    });

    expectSamplesIdentical(ghost.samples, reference);
    // Two burns fired and finished (0 -> 1 -> 0 twice) with no impact -- the flyby never collides
    // (golden-replay.test.ts's own finding for this scenario, unaffected by the extra probes and
    // the extra node since dynamic objects never perturb each other).
    expect(ghost.events.filter((e) => e.kind === 'nodeStart')).toHaveLength(2);
    expect(ghost.events.filter((e) => e.kind === 'nodeEnd')).toHaveLength(2);
    expect(ghost.events.some((e) => e.kind === 'bodyHit')).toBe(false);
  });
});

describe('ghost cache', () => {
  function buildPlan(secondNodeProgradeMmPerS: number): FlightPlan {
    return {
      rail: 0,
      launchTick: 0,
      heading: 3447904301,
      speed: 35000000,
      nodes: [
        { atTick: 1000, prograde: 200000, lateral: 50000 },
        { atTick: 2000, prograde: secondNodeProgradeMmPerS, lateral: 0 },
      ],
    };
  }

  test('editing the second node reuses the cached prefix and matches a cold re-integration', () => {
    const golden = loadGolden();
    const level = wrapAsLevel(golden);
    // The same array instance across calls -- integrateGhost invalidates the whole cache whenever
    // the committed log reference changes (planResume's own contract: a caller edits a plan while
    // holding the log steady, never the other way around).
    const log: Command[] = [];
    const fromTick = 0;
    const horizonTick = 3000;

    const plan1 = buildPlan(100000);
    const { ghost: ghost1, cache: cache1 } = integrateGhost({
      level,
      log,
      plan: plan1,
      fromTick,
      horizonTick,
    });
    expect(ghost1.ticksIntegrated).toBe(horizonTick - fromTick);

    const plan2 = buildPlan(150000); // only the second node's prograde differs
    const { ghost: ghost2 } = integrateGhost({
      level,
      log,
      plan: plan2,
      fromTick,
      horizonTick,
      cache: cache1,
    });

    // Resumed from node 1's own checkpoint -- taken at its own issue tick (issueTickFor, ADR-0007
    // §2: the latest tick that still gets it to the probe by atTick 2000, not atTick itself, so a
    // resume can still substitute a fresh command for a node not yet issued -- module header),
    // read back from cache1 itself rather than re-derived: far fewer ticks than a full
    // re-integration either way, the cached-prefix proof the unit asks for.
    const node1IssueTick = cache1.checkpoints[1]!.tick;
    expect(ghost2.ticksIntegrated).toBe(horizonTick - node1IssueTick);
    expect(ghost2.ticksIntegrated).toBeLessThan(ghost1.ticksIntegrated);

    const { ghost: coldGhost2 } = integrateGhost({
      level,
      log,
      plan: plan2,
      fromTick,
      horizonTick,
    });
    expect(coldGhost2.ticksIntegrated).toBe(horizonTick - fromTick);

    expect(ghost2.samples.count).toBe(coldGhost2.samples.count);
    for (let i = 0; i < ghost2.samples.count; i++) {
      expect(Object.is(ghost2.samples.x[i], coldGhost2.samples.x[i])).toBe(true);
      expect(Object.is(ghost2.samples.y[i], coldGhost2.samples.y[i])).toBe(true);
      expect(Object.is(ghost2.samples.vx[i], coldGhost2.samples.vx[i])).toBe(true);
      expect(Object.is(ghost2.samples.vy[i], coldGhost2.samples.vy[i])).toBe(true);
      expect(Object.is(ghost2.samples.mass[i], coldGhost2.samples.mass[i])).toBe(true);
      expect(Object.is(ghost2.samples.burning[i], coldGhost2.samples.burning[i])).toBe(true);
    }
  });

  test('an unchanged plan does no further work', () => {
    const golden = loadGolden();
    const level = wrapAsLevel(golden);
    const log: Command[] = [];
    const fromTick = 0;
    const horizonTick = 3000;

    const plan = buildPlan(100000);
    const { cache } = integrateGhost({ level, log, plan, fromTick, horizonTick });
    const { ghost } = integrateGhost({
      level,
      log,
      plan: buildPlan(100000),
      fromTick,
      horizonTick,
      cache,
    });
    expect(ghost.ticksIntegrated).toBe(0);
  });
});
