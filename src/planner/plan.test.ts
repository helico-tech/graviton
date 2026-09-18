// FlightPlan validation and commit (docs/work/GRV-0025-flight-plan-and-ghost.md). Against the
// committed T00-compiler-fixture (capacity 3, nodeBudget 4 -- levels/T00-compiler-fixture.level.json),
// the same fixture solve.test.ts and verify.test.ts already exercise, rather than a hand-built
// scenario.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { diffAmendmentNodes, existingNodesForProbe, planToCommands, validatePlan } from './plan.ts';
import type { BurnNode, FlightPlan } from './plan.ts';
import type { Command } from '../sim/sim.ts';
import { createSim } from '../sim/sim.ts';
import type { Scenario } from '../sim/sim.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';

function loadFixture(): CompiledLevel {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'levels', 'T00-compiler-fixture.level.json'), 'utf8'),
  ) as CompiledLevel;
}

// Two rails, both on the post's own host and longitude -- zero uplink delay from either one, at
// any tick, so `planToCommands`'s own issue-tick solve (`issueTickFor`) always lands exactly on
// `plan.launchTick`, matching this file's mechanical (not physics) expectations below.
function planToCommandsFixtureScenario(): Scenario {
  const rail = {
    host: 0,
    longitude: 0,
    muzzleSpeedMin: 1,
    muzzleSpeedMax: 1e6,
    headingCone: Math.PI,
    reloadTicks: 0,
  };
  return {
    dt: 60,
    capacity: 4,
    burnNodeCapacity: 4,
    bodies: [
      {
        parent: -1,
        mu: 3.986004418e14,
        radius: 6.371e6,
        rotationPeriod: 1e9,
        axialPhaseAtEpoch: 0,
      },
    ],
    rails: [rail, rail],
    contacts: [],
    post: { host: 0, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: [],
  };
}

function basePlan(): FlightPlan {
  return { rail: 0, launchTick: 0, heading: 2570577009, speed: 65426813, nodes: [] };
}

describe('validatePlan', () => {
  const level = loadFixture(); // nodeBudget 4 (burnNodeCapacity 12 / capacity 3)

  test('a plan with no nodes is valid', () => {
    expect(validatePlan({ plan: basePlan(), level })).toEqual([]);
  });

  test('a plan within budget, sorted, all integers, is valid', () => {
    const plan: FlightPlan = {
      ...basePlan(),
      nodes: [
        { atTick: 10, prograde: 1000, lateral: 0 },
        { atTick: 20, prograde: 0, lateral: -500 },
      ],
    };
    expect(validatePlan({ plan, level })).toEqual([]);
  });

  test('rejects more nodes than the level budget', () => {
    const plan: FlightPlan = {
      ...basePlan(),
      nodes: [1, 2, 3, 4, 5].map((n) => ({ atTick: n * 10, prograde: 1, lateral: 0 })),
    };
    const issues = validatePlan({ plan, level });
    expect(issues).toContainEqual(expect.stringContaining('budget is 4'));
  });

  test('rejects a node at or before the launch tick', () => {
    const plan: FlightPlan = {
      ...basePlan(),
      launchTick: 50,
      nodes: [{ atTick: 50, prograde: 1, lateral: 0 }],
    };
    const issues = validatePlan({ plan, level });
    expect(issues).toContainEqual(expect.stringContaining('must be later than launchTick'));
  });

  test('rejects nodes out of order', () => {
    const plan: FlightPlan = {
      ...basePlan(),
      nodes: [
        { atTick: 20, prograde: 1, lateral: 0 },
        { atTick: 10, prograde: 1, lateral: 0 },
      ],
    };
    const issues = validatePlan({ plan, level });
    expect(issues).toContainEqual(expect.stringContaining('out of order'));
  });

  test('rejects non-integer fields', () => {
    const plan: FlightPlan = {
      ...basePlan(),
      heading: 1.5,
      nodes: [{ atTick: 10.5, prograde: 1, lateral: 0.2 }],
    };
    const issues = validatePlan({ plan, level });
    expect(issues.some((i) => i.includes('heading must be an integer'))).toBe(true);
    expect(issues.some((i) => i.includes('atTick must be an integer'))).toBe(true);
    expect(issues.some((i) => i.includes('lateral must be an integer'))).toBe(true);
  });
});

describe('planToCommands', () => {
  const sim = createSim({ scenario: planToCommandsFixtureScenario(), seed: 1 });

  test('a plan with no nodes becomes a single launch command', () => {
    const plan = basePlan();
    const commands = planToCommands({ sim, plan, probeIndex: 0 });
    expect(commands).toEqual([
      { tick: 0, kind: 'launch', rail: 0, heading: 2570577009, speed: 65426813 },
    ]);
  });

  test('every node becomes a burn command issued at launchTick, atTick carried through unchanged', () => {
    const plan: FlightPlan = {
      rail: 1,
      launchTick: 100,
      heading: 42,
      speed: 999,
      nodes: [
        { atTick: 150, prograde: 2000, lateral: -100 },
        { atTick: 300, prograde: -50, lateral: 10 },
      ],
    };
    const commands = planToCommands({ sim, plan, probeIndex: 3 });
    expect(commands).toEqual([
      { tick: 100, kind: 'launch', rail: 1, heading: 42, speed: 999 },
      { tick: 100, kind: 'burn', probe: 3, atTick: 150, prograde: 2000, lateral: -100 },
      { tick: 100, kind: 'burn', probe: 3, atTick: 300, prograde: -50, lateral: 10 },
    ]);
  });

  test('launch always sorts before its own burns when appended and stably re-sorted by tick', () => {
    // The log-append contract (sim.ts's advance requires tick-sorted input): concatenating this
    // plan's commands onto an existing log and stably re-sorting by tick must never let a burn
    // referencing `probeIndex` land ahead of the launch that creates it.
    const plan: FlightPlan = {
      rail: 0,
      launchTick: 5,
      heading: 0,
      speed: 1,
      nodes: [{ atTick: 6, prograde: 1, lateral: 0 }],
    };
    const commands = [...planToCommands({ sim, plan, probeIndex: 0 })].sort(
      (a, b) => a.tick - b.tick,
    );
    expect(commands[0]!.kind).toBe('launch');
    expect(commands[1]!.kind).toBe('burn');
  });
});

describe('existingNodesForProbe', () => {
  test('collects every burn command for one probe, sorted by atTick, ignoring other probes and launches', () => {
    const log: Command[] = [
      { tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 1 },
      { tick: 10, kind: 'burn', probe: 1, atTick: 200, prograde: 9, lateral: 0 }, // a different probe
      { tick: 0, kind: 'burn', probe: 0, atTick: 300, prograde: 5, lateral: 1 },
      { tick: 0, kind: 'burn', probe: 0, atTick: 100, prograde: 2, lateral: 0 },
    ];
    expect(existingNodesForProbe({ log, probe: 0 })).toEqual([
      { atTick: 100, prograde: 2, lateral: 0 },
      { atTick: 300, prograde: 5, lateral: 1 },
    ]);
  });

  test('a probe with no burn commands yet has no existing nodes', () => {
    const log: Command[] = [{ tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 1 }];
    expect(existingNodesForProbe({ log, probe: 0 })).toEqual([]);
  });
});

describe('diffAmendmentNodes', () => {
  const existing: BurnNode[] = [
    { atTick: 100, prograde: 2, lateral: 0 },
    { atTick: 500, prograde: 5, lateral: 1 },
  ];

  test('an unedited node list has nothing to issue', () => {
    expect(diffAmendmentNodes({ existing, nodes: existing.map((n) => ({ ...n })) })).toEqual([]);
  });

  test('a brand-new node (beyond the existing list) is issued', () => {
    const added: BurnNode = { atTick: 900, prograde: 7, lateral: -1 };
    const nodes = [...existing, added];
    expect(diffAmendmentNodes({ existing, nodes })).toEqual([added]);
  });

  test('an edited existing node (any field changed) is issued again', () => {
    const edited: BurnNode = { atTick: 500, prograde: 6, lateral: 1 };
    const nodes = [existing[0]!, edited];
    expect(diffAmendmentNodes({ existing, nodes })).toEqual([edited]);
  });

  test('a locked node dropped from the current list is simply not re-issued (never a cancellation)', () => {
    const nodes = [existing[1]!];
    expect(diffAmendmentNodes({ existing, nodes })).toEqual([]);
  });
});
