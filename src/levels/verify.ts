// Replays a level's solution and turns the outcome into evidence (ADR-0006 §5, research 03
// §B.5 units 2-3, §B.7, docs/work/GRV-0017-level-verifier-and-evidence.md). Pure -- no fs, no
// node builtins -- so it is exercised directly by tests and by scripts/levels-verify.ts alike;
// the caller supplies the two files' hashes (sha256:<hex>, computed in the script layer with
// node:crypto) rather than this module reaching for a hash algorithm itself.
import { createSim, advance, hashSim } from '../sim/sim.ts';
import type { Command, Scenario } from '../sim/sim.ts';
import { NO_IMPACT } from '../sim/contacts.ts';
import type { ContactState } from '../sim/contacts.ts';
import type { DynamicObjects } from '../sim/dynamics/step.ts';
import { SIM_VERSION } from '../sim/version.ts';
import type { CompiledLevel } from './compile.ts';

export interface LevelSolution {
  level: string;
  simVersion: number;
  ticks: number;
  log: Command[];
}

export interface ContactEvidence {
  id: string;
  cleared: boolean;
  impactTick: number;
  /** Seconds; -1 (no impact recorded, or the hitting probe couldn't be identified -- NO_IMPACT's
   *  own convention, not a separate sentinel). */
  timeOfFlightSeconds: number;
  closingSpeed: number;
  impactEnergy: number;
  minimumImpactEnergy: number;
}

export interface DtConvergenceEntry {
  id: string;
  clearedAtDt: boolean;
  clearedAtHalfDt: boolean;
  impactTimeSecondsAtDt: number;
  impactTimeSecondsAtHalfDt: number;
  impactTimeDifferenceSeconds: number;
  closingSpeedAtDt: number;
  closingSpeedAtHalfDt: number;
}

export interface Evidence {
  level: string;
  levelHash: string;
  simVersion: number;
  solutionHash: string;
  finalStateHash: string;
  outcome: {
    contactsCleared: number;
    contactsTotal: number;
    probesLaunched: number;
    probesGranted: number;
    propellantRemaining: number[];
  };
  contacts: ContactEvidence[];
  dtConvergence: DtConvergenceEntry[];
}

export interface VerifyLevelResult {
  evidence: Evidence;
  failures: string[];
}

/** dt/2, every rail's reloadTicks doubled (ADR-0006 §4's ticks stay whole numbers either way),
 *  and historyTicks doubled too (GRV-0029, ADR-0007 §7): historyTicks covers a physical time
 *  window, so halving dt must double the tick count to keep covering the same window -- otherwise
 *  the dt/2 replay's own light-cone queries could fall outside the retained ring. Everything else
 *  untouched. New objects throughout -- `scenario` and its arrays are never mutated. */
export function halveDt(scenario: Scenario): Scenario {
  return {
    ...scenario,
    dt: scenario.dt / 2,
    historyTicks: scenario.historyTicks * 2,
    rails: scenario.rails.map((rail) => ({ ...rail, reloadTicks: rail.reloadTicks * 2 })),
  };
}

/** Every command's `tick` (and a burn's `atTick`) doubled: command times are quantised to ticks,
 *  so doubling both the log and `dt/2` keeps every command at the same physical instant the
 *  original log placed it at. A new array of new command objects -- `log` is never mutated. */
export function doubleLogTicks(log: readonly Command[]): Command[] {
  return log.map((command) =>
    command.kind === 'launch'
      ? { ...command, tick: command.tick * 2 }
      : { ...command, tick: command.tick * 2, atTick: command.atTick * 2 },
  );
}

interface ContactOutcome {
  cleared: ArrayLike<number>;
  impactTick: ArrayLike<number>;
  impactSpeed: ArrayLike<number>;
}

/** Per-contact comparison between a dt run and its dt/2 counterpart, plus whether the two agree
 *  on *which* contacts cleared -- the actual convergence check (ADR-0006 §5). Pure and synthetic-
 *  input-testable on its own: it only reads the two outcomes' dense arrays, never a `Sim`. */
export function compareDtConvergence({
  contactIds,
  dt,
  halfDt,
  atDt,
  atHalfDt,
}: {
  contactIds: readonly string[];
  dt: number;
  halfDt: number;
  atDt: ContactOutcome;
  atHalfDt: ContactOutcome;
}): { entries: DtConvergenceEntry[]; agrees: boolean } {
  const entries: DtConvergenceEntry[] = [];
  let agrees = true;

  for (let i = 0; i < contactIds.length; i++) {
    const clearedAtDt = atDt.cleared[i] === 1;
    const clearedAtHalfDt = atHalfDt.cleared[i] === 1;
    if (clearedAtDt !== clearedAtHalfDt) agrees = false;

    const tickAtDt = atDt.impactTick[i]!;
    const tickAtHalfDt = atHalfDt.impactTick[i]!;
    const impactTimeSecondsAtDt = tickAtDt === NO_IMPACT ? -1 : tickAtDt * dt;
    const impactTimeSecondsAtHalfDt = tickAtHalfDt === NO_IMPACT ? -1 : tickAtHalfDt * halfDt;
    const impactTimeDifferenceSeconds =
      tickAtDt === NO_IMPACT || tickAtHalfDt === NO_IMPACT
        ? -1
        : Math.abs(impactTimeSecondsAtDt - impactTimeSecondsAtHalfDt);

    entries.push({
      id: contactIds[i]!,
      clearedAtDt,
      clearedAtHalfDt,
      impactTimeSecondsAtDt,
      impactTimeSecondsAtHalfDt,
      impactTimeDifferenceSeconds,
      closingSpeedAtDt: atDt.impactSpeed[i]!,
      closingSpeedAtHalfDt: atHalfDt.impactSpeed[i]!,
    });
  }

  return { entries, agrees };
}

/** First object that hit `contact` (GRV-0017 design: at most one is expected in practice, since a
 *  cleared contact stops testing for further impacts -- see contacts.ts/step.ts). -1 if none. */
function findHitter(objects: DynamicObjects, contact: number): number {
  for (let i = 0; i < objects.count; i++) if (objects.hitContact[i] === contact) return i;
  return -1;
}

function launchTicksInOrder(log: readonly Command[]): number[] {
  const ticks: number[] = [];
  for (const command of log) if (command.kind === 'launch') ticks.push(command.tick);
  return ticks;
}

function buildContactEvidence({
  level,
  dt,
  contactState,
  objects,
  log,
}: {
  level: CompiledLevel;
  dt: number;
  contactState: ContactState;
  objects: DynamicObjects;
  log: readonly Command[];
}): ContactEvidence[] {
  const launchTicks = launchTicksInOrder(log);
  const contacts: ContactEvidence[] = [];

  for (let i = 0; i < level.contactIds.length; i++) {
    const impactTick = contactState.impactTick[i]!;
    let timeOfFlightSeconds = -1;
    if (impactTick !== NO_IMPACT) {
      const hitter = findHitter(objects, i);
      if (hitter !== -1 && hitter < launchTicks.length) {
        timeOfFlightSeconds = (impactTick - launchTicks[hitter]!) * dt;
      }
    }
    contacts.push({
      id: level.contactIds[i]!,
      cleared: contactState.cleared[i] === 1,
      impactTick,
      timeOfFlightSeconds,
      closingSpeed: contactState.impactSpeed[i]!,
      impactEnergy: contactState.impactEnergy[i]!,
      minimumImpactEnergy: level.scenario.contacts[i]!.minimumImpactEnergy,
    });
  }

  return contacts;
}

/** Replays `solution` against `level` headless and turns the result into `evidence` (ADR-0006
 *  §5): outcome, per-contact impact facts, and a dt/2 convergence sweep. Collects every failure it
 *  can rather than stopping at the first, mirroring compile.ts's own style -- a stale simVersion
 *  and an uncleared contact are both worth reporting from the same run. A command the simulation
 *  rejects aborts the primary replay (its evidence reflects whatever ran before the rejection) and
 *  skips the dt/2 sweep, since there is no valid primary result to compare it against. */
export function verifyLevel({
  level,
  levelHash,
  solution,
  solutionHash,
}: {
  level: CompiledLevel;
  levelHash: string;
  solution: LevelSolution;
  solutionHash: string;
}): VerifyLevelResult {
  const failures: string[] = [];

  if (solution.level !== level.id)
    failures.push(`solution is for level "${solution.level}", not "${level.id}"`);
  if (solution.simVersion !== SIM_VERSION)
    failures.push(
      `solution simVersion ${solution.simVersion} does not match running sim version ${SIM_VERSION}`,
    );

  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  let replayOk = true;
  try {
    advance({ sim, log: solution.log, ticks: solution.ticks });
  } catch (err) {
    replayOk = false;
    failures.push(`command rejected: ${err instanceof Error ? err.message : String(err)}`);
  }

  const contactsTotal = sim.contacts.count;
  let contactsCleared = 0;
  for (let i = 0; i < contactsTotal; i++) if (sim.contactState.cleared[i]) contactsCleared++;
  if (contactsCleared < contactsTotal) failures.push('not all contacts cleared');

  const propellantRemaining: number[] = [];
  for (let i = 0; i < sim.objects.count; i++)
    propellantRemaining.push(sim.objects.mass[i]! - sim.objects.dryMass[i]!);

  const contacts = buildContactEvidence({
    level,
    dt: level.scenario.dt,
    contactState: sim.contactState,
    objects: sim.objects,
    log: solution.log,
  });

  let dtConvergence: DtConvergenceEntry[] = [];
  if (replayOk) {
    const halfScenario = halveDt(level.scenario);
    const halfLog = doubleLogTicks(solution.log);
    const halfSim = createSim({ scenario: halfScenario, seed: level.seed });
    advance({ sim: halfSim, log: halfLog, ticks: solution.ticks * 2 });

    const { entries, agrees } = compareDtConvergence({
      contactIds: level.contactIds,
      dt: level.scenario.dt,
      halfDt: halfScenario.dt,
      atDt: sim.contactState,
      atHalfDt: halfSim.contactState,
    });
    dtConvergence = entries;
    if (!agrees) failures.push('dt/2 replay disagreed on which contacts cleared');
  }

  const evidence: Evidence = {
    level: level.id,
    levelHash,
    simVersion: SIM_VERSION,
    solutionHash,
    finalStateHash: hashSim(sim),
    outcome: {
      contactsCleared,
      contactsTotal,
      probesLaunched: sim.objects.count,
      probesGranted: level.scenario.capacity,
      propellantRemaining,
    },
    contacts,
    dtConvergence,
  };

  return { evidence, failures };
}
