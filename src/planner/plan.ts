// A flight plan as plain data (GAME-0001 §4.4, EPIC-06): rail, launch tick, heading, speed and up
// to `nodeBudget` burn nodes, every field already in the command log's own integer units (heading
// in 1/2^32 turn, speed and delta-v in mm/s, times in ticks -- ADR-0005 "Command log") so a plan
// never carries a floating-point value the log itself wouldn't. `planToCommands` is the only way a
// plan becomes commands: "a probe carries a flight plan loaded at launch and executed
// autonomously" (GAME-0001 §4.4) means every node's burn command is issued at the launch tick
// itself, not at its own activation tick -- the whole plan is uploaded to the probe at launch, and
// it executes the schedule on its own from there. `commit` (src/app, later work) is nothing but
// appending `planToCommands`'s result to the log.
import type { Command } from '../sim/sim.ts';
import type { CompiledLevel } from '../levels/compile.ts';

export interface BurnNode {
  /** Tick the burn activates on; must be later than the plan's `launchTick`. */
  atTick: number;
  /** mm/s along the frozen inertial-velocity direction at activation. */
  prograde: number;
  /** mm/s along the frozen +90 degree (left of velocity) direction. */
  lateral: number;
}

export interface FlightPlan {
  /** Rail index (Sim.rails order). */
  rail: number;
  launchTick: number;
  /** 0..4294967295 (1/2^32 of a turn -- commands.ts's HEADING_TURN). */
  heading: number;
  /** mm/s, muzzle speed relative to the rail. */
  speed: number;
  /** Sorted by `atTick`, length <= the level's per-probe node budget. */
  nodes: BurnNode[];
}

/** One probe type per level (schema.ts), so `Scenario.burnNodeCapacity` (`count * nodeBudget`,
 *  compile.ts's `buildScenario`) divided by `Scenario.capacity` (`count`) recovers the per-probe
 *  budget exactly, with no need for `CompiledLevel` to restate `nodeBudget` on its own -- this unit
 *  reuses `solve.ts` only and leaves `compile.ts`'s `CompiledLevel` shape untouched. */
function nodeBudget(level: CompiledLevel): number {
  return level.scenario.burnNodeCapacity / level.scenario.capacity;
}

/** Checks the plan's own well-formedness against `level` (node count within budget, nodes sorted
 *  by `atTick`, every quantised field an integer, every node's `atTick` strictly after the launch)
 *  -- never the rail/heading/speed feasibility `checkLaunch` (sim/commands.ts) already covers, so
 *  this stays a plan-shape check rather than a second model of what the simulation itself decides.
 *  Returns every issue found (empty = valid), mirroring `verifyLevel`'s own `failures: string[]`
 *  convention. */
export function validatePlan({
  plan,
  level,
}: {
  plan: FlightPlan;
  level: CompiledLevel;
}): string[] {
  const issues: string[] = [];
  const budget = nodeBudget(level);

  if (plan.nodes.length > budget)
    issues.push(`plan has ${plan.nodes.length} node(s), budget is ${budget}`);

  if (!Number.isInteger(plan.rail)) issues.push(`rail must be an integer, got ${plan.rail}`);
  if (!Number.isInteger(plan.launchTick))
    issues.push(`launchTick must be an integer, got ${plan.launchTick}`);
  if (!Number.isInteger(plan.heading))
    issues.push(`heading must be an integer, got ${plan.heading}`);
  if (!Number.isInteger(plan.speed)) issues.push(`speed must be an integer, got ${plan.speed}`);

  for (let i = 0; i < plan.nodes.length; i++) {
    const node = plan.nodes[i]!;
    if (!Number.isInteger(node.atTick))
      issues.push(`node ${i}: atTick must be an integer, got ${node.atTick}`);
    if (!Number.isInteger(node.prograde))
      issues.push(`node ${i}: prograde must be an integer, got ${node.prograde}`);
    if (!Number.isInteger(node.lateral))
      issues.push(`node ${i}: lateral must be an integer, got ${node.lateral}`);
    if (node.atTick <= plan.launchTick)
      issues.push(
        `node ${i}: atTick (${node.atTick}) must be later than launchTick (${plan.launchTick})`,
      );
    if (i > 0 && node.atTick < plan.nodes[i - 1]!.atTick)
      issues.push(`node ${i}: atTick (${node.atTick}) is out of order (nodes must be sorted)`);
  }

  return issues;
}

/** The only way a `FlightPlan` becomes `Command[]` (GAME-0001 §4.4: loaded at launch, executed
 *  autonomously) -- one launch command plus one burn command per node, every command's own `tick`
 *  (when it is *issued*) equal to `plan.launchTick`; a node's `atTick` (when it *activates*) is
 *  carried through unchanged. `probeIndex` is the object index the launch will get -- the caller's
 *  own `Sim.objects.count` at `plan.launchTick`, before the launch is applied (sim.ts's
 *  `applyLaunch` assigns exactly that index). Launch first, so a stable sort by tick (ties in log
 *  order, `Array.prototype.sort` is stable) never lets a burn's `probe` reference an object that
 *  does not exist yet when the log is replayed. */
export function planToCommands({
  plan,
  probeIndex,
}: {
  plan: FlightPlan;
  probeIndex: number;
}): Command[] {
  const commands: Command[] = [
    {
      tick: plan.launchTick,
      kind: 'launch',
      rail: plan.rail,
      heading: plan.heading,
      speed: plan.speed,
    },
  ];
  for (const node of plan.nodes) {
    commands.push({
      tick: plan.launchTick,
      kind: 'burn',
      probe: probeIndex,
      atTick: node.atTick,
      prograde: node.prograde,
      lateral: node.lateral,
    });
  }
  return commands;
}
