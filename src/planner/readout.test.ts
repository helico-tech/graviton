// solutionReadout (GAME-0001 §4.6 "solution readout", docs/work/GRV-0025-flight-plan-and-ghost.md):
// every number derived from a ghost's own samples/events and the sim's own formulas. Exercised
// against level 01's real committed solution (a cleared contact, no nodes) and the
// T00-compiler-fixture (to prove an added burn actually reduces the reported delta-v remaining).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { integrateGhost } from './ghost.ts';
import { solutionReadout } from './readout.ts';
import type { FlightPlan } from './plan.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import type { Command } from '../sim/sim.ts';
import { dlog } from '../sim/math/kernels.ts';
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

describe('solutionReadout: L01-intercept, committed solution, no amendments', () => {
  const level = loadJson<CompiledLevel>('levels', 'L01-intercept.level.json');
  const solution = loadJson<LevelSolution>('levels', 'L01-intercept.solution.json');
  const launch = solution.log[0]!;
  if (launch.kind !== 'launch') throw new Error('expected the solved launch command first');

  const plan: FlightPlan = {
    rail: launch.rail,
    launchTick: launch.tick,
    heading: launch.heading,
    speed: launch.speed,
    nodes: [],
  };

  test('reports the cleared contact, time of flight, and full delta-v (no burns fired)', () => {
    const { ghost } = integrateGhost({
      level,
      log: [],
      plan,
      fromTick: 0,
      horizonTick: solution.ticks,
    });
    const readout = solutionReadout({ ghost, level });

    expect(readout.contacts).toHaveLength(1);
    const contact = readout.contacts[0]!;
    expect(contact.cleared).toBe(true);
    expect(contact.impactTick).toBe(ghost.contacts[0]!.impactTick);
    expect(contact.closingSpeed).toBe(ghost.contacts[0]!.impactSpeed);
    expect(contact.impactEnergy).toBeGreaterThan(level.scenario.contacts[0]!.minimumImpactEnergy);
    // Tick-level swept-segment sampling (solve.ts's own resolution, reused here) is far coarser
    // than the substep-accurate capture test that actually caught the impact -- a cruise probe
    // covers thousands of kilometres per tick, so this is a sanity bound, not the capture radius.
    expect(contact.closestApproach).toBeGreaterThan(0);
    expect(contact.closestTick).toBeGreaterThan(0);

    expect(readout.timeOfFlight).toBeCloseTo(
      (contact.impactTick! - launch.tick) * level.scenario.dt,
      6,
    );

    // No node ever fired, so every kilogram of propellant is still aboard: the full-tank figure.
    const wetMass = level.scenario.probe.dryMass + level.scenario.probe.propellantMass;
    const expectedFullDeltaV =
      level.scenario.probe.exhaustVelocity * dlog(wetMass / level.scenario.probe.dryMass);
    expect(readout.deltaVRemaining).toBeCloseTo(expectedFullDeltaV, 6);

    // Arrival speed (from a single tick's samples) and closing speed (the sim's own mean relative
    // velocity over the impacting substep) are two different measurements of the same event --
    // close, not necessarily bit-identical.
    expect(readout.arrivalSpeed).toBeGreaterThan(0);
    expect(
      Math.abs(readout.arrivalSpeed - contact.closingSpeed!) / contact.closingSpeed!,
    ).toBeLessThan(0.05);
  });
});

describe('solutionReadout: T00-compiler-fixture, a burn node reduces delta-v remaining', () => {
  const level = loadJson<CompiledLevel>('levels', 'T00-compiler-fixture.level.json');
  const solution = loadJson<LevelSolution>('levels', 'T00-compiler-fixture.solution.json');
  const launchCommand = solution.log[0]!;
  if (launchCommand.kind !== 'launch') throw new Error('expected the solved launch command first');
  const launch = launchCommand;

  function planWithNodes(nodes: FlightPlan['nodes']): FlightPlan {
    return {
      rail: launch.rail,
      launchTick: launch.tick,
      heading: launch.heading,
      speed: launch.speed,
      nodes,
    };
  }

  test('a fired burn node leaves less delta-v than an identical plan with none', () => {
    const horizonTick = solution.ticks;
    const { ghost: noBurnGhost } = integrateGhost({
      level,
      log: [],
      plan: planWithNodes([]),
      fromTick: 0,
      horizonTick,
    });
    const noBurnReadout = solutionReadout({ ghost: noBurnGhost, level });

    // A burn large enough to span several ticks (thrust 9400 N, ve 31000 m/s here -- a 50 m/s
    // node would finish inside a single 30 s tick and never show a burning-edge, per the ghost's
    // own tick-sampled event detection), so nodeStart/nodeEnd are actually observable.
    const { ghost: burnGhost } = integrateGhost({
      level,
      log: [],
      plan: planWithNodes([{ atTick: 20, prograde: 2000000, lateral: 0 }]),
      fromTick: 0,
      horizonTick,
    });
    const burnReadout = solutionReadout({ ghost: burnGhost, level });

    expect(burnGhost.events.some((e) => e.kind === 'nodeStart')).toBe(true);
    expect(burnGhost.events.some((e) => e.kind === 'nodeEnd')).toBe(true);
    expect(burnReadout.deltaVRemaining).toBeLessThan(noBurnReadout.deltaVRemaining);
  });
});
