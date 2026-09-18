// Solution readout (GAME-0001 §4.6 "solution readout"): every number the planner shows the player
// derived straight from the ghost's own samples and events and the simulation's own formulas
// (docs/domain/simulation-determinism.md rule 11: "every displayed number comes from the
// simulation"), never a second model. `dlog` (sim/math/kernels.ts) is the simulation's own natural
// logarithm kernel -- the same one the sim would use if it computed a delta-v figure itself -- so
// the remaining-delta-v formula stays consistent with ADR-0005's own kernel choice rather than
// falling back to `Math.log` (which ADR-0002 bans inside `src/sim` for cross-engine determinism;
// reused here for the same reason, even though `src/planner` itself carries no such lint ban).
import { dlog } from '../sim/math/kernels.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import { contactPoint } from '../sim/contacts.ts';
import { NO_IMPACT } from '../sim/contacts.ts';
import { createBodyTable } from '../sim/ephemeris/bodies.ts';
import type { CompiledLevel } from '../levels/compile.ts';
import type { Ghost } from './ghost.ts';

export interface ContactReadout {
  closestApproach: number;
  closestTick: number;
  cleared: boolean;
  impactTick?: number;
  closingSpeed?: number;
  impactEnergy?: number;
}

export interface SolutionReadout {
  contacts: ContactReadout[];
  /** Seconds: impact tick if any contact was hit (the earliest one), else the last sampled tick. */
  timeOfFlight: number;
  /** m/s, `exhaustVelocity * ln(mass / dryMass)` (the rocket equation) evaluated at the ghost's
   *  last sample -- whatever propellant is left once every fired node has finished. */
  deltaVRemaining: number;
  /** m/s: relative speed between the probe and the contact it is closest to overall (by
   *  `closestApproach`, or the earliest impacted contact if any), at that contact's own tick. */
  arrivalSpeed: number;
}

function contactReadoutFor(ghost: Ghost, contact: number): ContactReadout {
  const approach = ghost.events.find(
    (e): e is Extract<Ghost['events'][number], { kind: 'closestApproach' }> =>
      e.kind === 'closestApproach' && e.contact === contact,
  );
  const outcome = ghost.contacts[contact];
  const impacted = outcome !== undefined && outcome.impactTick !== NO_IMPACT;

  return {
    closestApproach: approach?.distance ?? Infinity,
    closestTick: approach?.tick ?? -1,
    cleared: outcome?.cleared ?? false,
    ...(impacted
      ? {
          impactTick: outcome.impactTick,
          closingSpeed: outcome.impactSpeed,
          impactEnergy: outcome.impactEnergy,
        }
      : {}),
  };
}

/** The contact `arrivalSpeed` reports against: the earliest impacted contact if any fired, else
 *  whichever contact came closest overall. */
function primaryContact(contacts: ContactReadout[]): number | null {
  let bestImpact: { contact: number; tick: number } | null = null;
  for (let c = 0; c < contacts.length; c++) {
    const tick = contacts[c]!.impactTick;
    if (tick !== undefined && (bestImpact === null || tick < bestImpact.tick)) {
      bestImpact = { contact: c, tick };
    }
  }
  if (bestImpact) return bestImpact.contact;

  let best: { contact: number; distance: number } | null = null;
  for (let c = 0; c < contacts.length; c++) {
    if (contacts[c]!.closestTick === -1) continue;
    const distance = contacts[c]!.closestApproach;
    if (best === null || distance < best.distance) best = { contact: c, distance };
  }
  return best?.contact ?? null;
}

/** Relative speed between the ghost probe and `contact` at `tick`, from the ghost's own velocity
 *  sample and the contact's own ephemeris velocity (rails.ts's `surfacePoint` formula, the
 *  simulation's own kinematics -- never a separate model). */
function relativeSpeedAt({
  level,
  ghost,
  contact,
  tick,
}: {
  level: CompiledLevel;
  ghost: Ghost;
  contact: number;
  tick: number;
}): number {
  const index = tick - ghost.fromTick;
  if (index < 0 || index >= ghost.samples.count) return 0;

  const bodies = createBodyTable(level.scenario.bodies);
  const t = tick * level.scenario.dt;
  const eph = {
    x: new Float64Array(bodies.count),
    y: new Float64Array(bodies.count),
    vx: new Float64Array(bodies.count),
    vy: new Float64Array(bodies.count),
  };
  evaluateEphemeris(bodies, t, eph);
  // contactPoint needs a ContactTable; rebuilding it from the level's own contact defs mirrors how
  // every other reader outside src/sim (solve.ts, frame.ts) reaches a contact's kinematics -- no
  // Sim of any kind is created here, just the same static, seed-independent geometry query.
  const contacts = {
    count: level.scenario.contacts.length,
    host: Int32Array.from(level.scenario.contacts.map((c) => c.host)),
    longitude: Float64Array.from(level.scenario.contacts.map((c) => c.longitude)),
    captureRadius: Float64Array.from(level.scenario.contacts.map((c) => c.captureRadius)),
    minimumImpactEnergy: Float64Array.from(
      level.scenario.contacts.map((c) => c.minimumImpactEnergy),
    ),
  };
  const point = contactPoint({ bodies, contacts, contact, t, eph });

  const dvx = ghost.samples.vx[index]! - point.vx;
  const dvy = ghost.samples.vy[index]! - point.vy;
  return Math.sqrt(dvx * dvx + dvy * dvy);
}

/** Every solution-readout number (GAME-0001 §4.6), computed only from `ghost`'s own samples and
 *  events and the sim's own formulas -- `level` supplies just the static geometry (bodies,
 *  contacts, dt, probe) needed to re-evaluate a contact's position/velocity at a specific tick and
 *  the probe's dry mass for the delta-v formula. */
export function solutionReadout({
  ghost,
  level,
}: {
  ghost: Ghost;
  level: CompiledLevel;
}): SolutionReadout {
  const contacts = ghost.contacts.map((_, c) => contactReadoutFor(ghost, c));

  const lastIndex = ghost.samples.count - 1;
  const lastMass = lastIndex >= 0 ? ghost.samples.mass[lastIndex]! : 0;
  const deltaVRemaining =
    lastMass > 0
      ? level.scenario.probe.exhaustVelocity * dlog(lastMass / level.scenario.probe.dryMass)
      : 0;

  let earliestImpactTick: number | null = null;
  for (const c of contacts) {
    if (
      c.impactTick !== undefined &&
      (earliestImpactTick === null || c.impactTick < earliestImpactTick)
    ) {
      earliestImpactTick = c.impactTick;
    }
  }
  const lastSampledTick = ghost.fromTick + Math.max(lastIndex, 0);
  // An amendment ghost (GRV-0031) has no launch event -- the probe already exists, nothing is
  // relaunched (src/planner/ghost.ts's own amend path never pushes one) -- so time of flight is
  // measured from the ghost's own start (`fromTick`, "now") instead, the amendment's own
  // equivalent of "when this plan begins."
  const launchTick = ghost.events.find((e) => e.kind === 'launch')?.tick ?? ghost.fromTick;
  const timeOfFlight = ((earliestImpactTick ?? lastSampledTick) - launchTick) * level.scenario.dt;

  const arrivalContact = primaryContact(contacts);
  const arrivalSpeed =
    arrivalContact === null
      ? 0
      : relativeSpeedAt({
          level,
          ghost,
          contact: arrivalContact,
          tick: contacts[arrivalContact]!.impactTick ?? contacts[arrivalContact]!.closestTick,
        });

  return { contacts, timeOfFlight, deltaVRemaining, arrivalSpeed };
}
