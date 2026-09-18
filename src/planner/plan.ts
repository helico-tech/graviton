// A flight plan as plain data (GAME-0001 §4.4, EPIC-06): rail, launch tick, heading, speed and up
// to `nodeBudget` burn nodes, every field already in the command log's own integer units (heading
// in 1/2^32 turn, speed and delta-v in mm/s, times in ticks -- ADR-0005 "Command log") so a plan
// never carries a floating-point value the log itself wouldn't. `planToCommands` is the only way a
// plan becomes commands: "a probe carries a flight plan loaded at launch and executed
// autonomously" (GAME-0001 §4.4) means every node's burn command is issued at the SAME tick as the
// launch itself, not at its own activation tick -- the whole plan is uploaded to the probe in one
// transmission, and it executes the schedule on its own from there (ADR-0007 §2's "same issue
// batch": the probe does not exist yet when a node's command is issued, so its arrival is solved
// against the launch's own arrival, not the node's own target -- sim/commands.ts's
// `resolveBurnProbe`). `commit` (src/app) is nothing but appending `planToCommands`'s result to
// the log. `launchTick` is the plan's ARRIVAL tick -- when the probe actually leaves the rail
// (ADR-0007 §2) -- not the tick the order is sent; `planToCommands` derives the issue tick itself
// via `issueTickFor` so a caller never has to.
import { issueTickFor } from '../sim/lightcone.ts';
import type { Sim, Command } from '../sim/sim.ts';
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
  /** The tick the probe actually leaves the rail (ADR-0007 §2's arrival tick), not the tick the
   *  launch order is sent -- `planToCommands` solves the issue tick itself. */
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
 *  autonomously; ADR-0007 §2) -- one launch command plus one burn command per node, every
 *  command's own `tick` (when it is *issued*) equal to `issueTickFor(rail, plan.launchTick)`: the
 *  latest tick the launch could be sent from and still arrive (materialise) exactly at
 *  `plan.launchTick`. Every node command is issued at that SAME tick, bundled with the launch --
 *  the probe does not exist yet at issue time, so its arrival can't be solved against the probe
 *  itself; `resolveBurnProbe` (sim/commands.ts) instead finds the same-tick pending launch and
 *  inherits its arrival ("same issue batch", ADR-0007 §2). A node's `atTick` (when it *activates*)
 *  is carried through unchanged. `probeIndex` is the object index the launch will get -- the
 *  caller's own `Sim.objects.count` at commit time, before the launch arrives (sim/commands.ts's
 *  `materializeLaunch` assigns exactly that index, assuming no other launch arrives between commit
 *  and this one's own arrival -- a known limitation for concurrent in-flight launches, not
 *  exercised by any level this unit ships). Launch first, so a stable sort by tick (ties in log
 *  order, `Array.prototype.sort` is stable) never lets a burn's `probe` reference an object that
 *  does not exist yet when the log is replayed. */
/** Every burn command already committed for `probe`, sorted by `atTick` (GRV-0031's amendment
 *  mode): the amended probe's own flight plan as it stands right now, before any edit this session
 *  makes -- reconstructed from the log itself rather than carried separately, so there is exactly
 *  one source of truth for "what has this probe already been told to do" (a launch's own bundled
 *  nodes and a prior amendment's own diffed-in nodes look identical here, both just burn commands
 *  naming this probe). */
export function existingNodesForProbe({
  log,
  probe,
}: {
  log: readonly Command[];
  probe: number;
}): BurnNode[] {
  const nodes: BurnNode[] = [];
  for (const command of log) {
    if (command.kind === 'burn' && command.probe === probe) {
      nodes.push({ atTick: command.atTick, prograde: command.prograde, lateral: command.lateral });
    }
  }
  return nodes.sort((a, b) => a.atTick - b.atTick);
}

function nodeEquals(a: BurnNode, b: BurnNode): boolean {
  return a.atTick === b.atTick && a.prograde === b.prograde && a.lateral === b.lateral;
}

/** The nodes an amendment must actually transmit (GRV-0031, ADR-0007 §3): every node in `nodes`
 *  (the amendment session's own current, full desired list -- locked, editable and new, in one
 *  array) that has no exact value match anywhere in `existing` (the probe's already-committed
 *  nodes, `existingNodesForProbe`) -- a genuinely new node, or an edited one, whichever position it
 *  now sits at (index position alone is not reliable: a new node inserted before an untouched
 *  editable one shifts every later index without editing it, `addNode`'s own sort by `atTick`).
 *  Value equality, not index equality, so an untouched node is recognised regardless of where the
 *  sort placed it. A node dropped from `nodes` entirely (the player deleted an editable one from
 *  the panel) is simply never re-sent -- there is no way to cancel an already-queued command
 *  (sim/commands.ts has no such primitive), so the original still fires; `beginNodeDrag`/
 *  `removeNode` (src/app/planner.ts) refuse to touch a node the player hasn't added this session for
 *  exactly this reason, but this diff itself stays honest about what it *can* do: issue, never
 *  retract. `integrateGhost`'s own amend path and `commitPlan`'s amendment commit both call this,
 *  so the ghost preview and what actually gets sent are the same set of commands by construction. */
export function diffAmendmentNodes({
  existing,
  nodes,
}: {
  existing: readonly BurnNode[];
  nodes: readonly BurnNode[];
}): BurnNode[] {
  return nodes.filter((node) => !existing.some((e) => nodeEquals(e, node)));
}

export function planToCommands({
  sim,
  plan,
  probeIndex,
}: {
  sim: Sim;
  plan: FlightPlan;
  probeIndex: number;
}): Command[] {
  const issueTick = issueTickFor({
    sim,
    target: { kind: 'rail', rail: plan.rail },
    atTick: plan.launchTick,
  });

  const commands: Command[] = [
    {
      tick: issueTick,
      kind: 'launch',
      rail: plan.rail,
      heading: plan.heading,
      speed: plan.speed,
    },
  ];
  for (const node of plan.nodes) {
    commands.push({
      tick: issueTick,
      kind: 'burn',
      probe: probeIndex,
      atTick: node.atTick,
      prograde: node.prograde,
      lateral: node.lateral,
    });
  }
  return commands;
}
