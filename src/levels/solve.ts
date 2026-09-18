// Finds a command log that clears a level (ADR-0006 §5, research 03 §B.1, §B.3-B.6,
// docs/work/GRV-0018-level-solver.md): nobody can hand-author a launch to nine significant
// digits (a 1e-7 rad heading change moves an eleven-day miss by 28 km -- ADR-0006 §1), so this
// module searches for one instead. Pure -- no fs, no clock, no `Math.random` -- and every
// evaluation runs the real simulation (`createSim`/`advance`) exactly as the game and the
// verifier do; the search only ever proposes command logs, it never models the trajectory
// itself.
import { createSim, advance, checkLaunch } from '../sim/sim.ts';
import type { Command, LaunchRejection, Scenario, Sim } from '../sim/sim.ts';
import { createBodyTable, evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { railGeometry } from '../sim/rails.ts';
import { contactPoint, NO_IMPACT } from '../sim/contacts.ts';
import { HEADING_TURN } from '../sim/commands.ts';
import { verifyLevel } from './verify.ts';
import type { LevelSolution } from './verify.ts';
import type { CompiledLevel } from './compile.ts';
import { SIM_VERSION } from '../sim/version.ts';

const TWO_PI = 6.283185307179586;
const MM_PER_M = 1000;

// Penalty tiers (ADR-0006 §5 "checkLaunch rejection ... a body hit before the contact ...
// uncleared impact": ordered so a plain miss (raw metres, up to interplanetary distances) never
// outranks a body hit, which never outranks a launch the rail itself refuses).
const BODY_HIT_BASE = 1e14;
const REJECTED_BASE = 1e17;
const CONE_PENALTY_SCALE = 1e9;

function makeEph(n: number): EphemerisOut {
  return {
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
  };
}

function normalizeHeadingRad(headingRad: number): number {
  const turns = headingRad / TWO_PI;
  const frac = turns - Math.floor(turns);
  return frac * TWO_PI;
}

/** Nearest integer heading unit (1/2^32 turn, ADR-0006 §4) for a real-valued radian heading,
 *  wrapped into [0, HEADING_TURN). */
export function quantizeHeading(headingRad: number): number {
  const normalized = normalizeHeadingRad(headingRad);
  const quantized = Math.round((normalized / TWO_PI) * HEADING_TURN);
  return quantized >= HEADING_TURN ? 0 : quantized;
}

/** Nearest integer mm/s for a real-valued m/s speed (ADR-0006 §4), clamped to a non-negative
 *  command field. */
export function quantizeSpeed(speedMps: number): number {
  return Math.max(0, Math.round(speedMps * MM_PER_M));
}

interface Point {
  x: number;
  y: number;
}

/** Closest approach of the probe's position relative to the contact, on the swept segment
 *  between two tick boundaries (research §B.4: not endpoint sampling) -- the solver's own
 *  coarser echo of `step.ts`'s `testContactImpacts`, at tick resolution rather than substep
 *  resolution, so the search has a smooth landscape to climb down even between the ticks where
 *  the real simulation's own finer test would catch an impact. */
export function sweptSegmentDistance({
  probeStart,
  probeEnd,
  contactStart,
  contactEnd,
}: {
  probeStart: Point;
  probeEnd: Point;
  contactStart: Point;
  contactEnd: Point;
}): number {
  const r0x = probeStart.x - contactStart.x;
  const r0y = probeStart.y - contactStart.y;
  const r1x = probeEnd.x - contactEnd.x;
  const r1y = probeEnd.y - contactEnd.y;
  const dx = r1x - r0x;
  const dy = r1y - r0y;
  const denom = dx * dx + dy * dy;
  let s = denom === 0 ? 0 : -(r0x * dx + r0y * dy) / denom;
  if (s < 0) s = 0;
  else if (s > 1) s = 1;
  const cx = r0x + s * dx;
  const cy = r0y + s * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

/** dt multiplied, every rail's `reloadTicks` scaled to still cover at least the same physical
 *  reload time at the coarser dt (research §B.4's ladder) -- rounded up, never down, so a coarse
 *  rung never lets a rail fire sooner than the level's own `dt` would allow. */
export function coarsenScenario({
  scenario,
  multiple,
}: {
  scenario: Scenario;
  multiple: number;
}): Scenario {
  return {
    ...scenario,
    dt: scenario.dt * multiple,
    rails: scenario.rails.map((rail) => ({
      ...rail,
      reloadTicks: Math.ceil(rail.reloadTicks / multiple),
    })),
  };
}

/** A tick at the level's own (finest) `dt`, expressed in a coarser rung's own tick count.
 *  Rounds -- only used to seed a coarse rung's search grid from a fine-tick window, never to
 *  recover an exact fine tick (`toFineTick` does that, exactly). */
export function toCoarseTick(fineTick: number, multiple: number): number {
  return Math.round(fineTick / multiple);
}

/** A coarse-rung tick back to the level's own (finest) `dt` tick count -- exact, since a coarse
 *  tick's physical instant is always a whole multiple of the fine `dt` by construction. */
export function toFineTick(coarseTick: number, multiple: number): number {
  return coarseTick * multiple;
}

function sortLogByTick(log: readonly Command[]): Command[] {
  return [...log].sort((a, b) => a.tick - b.tick);
}

export interface EvaluateLaunchArgs {
  scenario: Scenario;
  seed: number;
  /** Commands for contacts already solved, applied first (ADR-0006 §5 "contacts are solved one
   *  after another in level order, respecting rail reload"). */
  priorLog: readonly Command[];
  railIndex: number;
  contactIndex: number;
  launchTick: number;
  /** Radians, any real value -- quantised internally (`quantizeHeading`), so a continuous search
   *  stage can call this directly without snapping first. */
  headingRad: number;
  /** m/s, quantised internally (`quantizeSpeed`). */
  speedMps: number;
  maxFlightTicks: number;
}

export interface EvaluateLaunchResult {
  /** Metres: the objective. A plain miss is the real swept-segment closest approach; a body hit
   *  or a rejected launch are penalised into their own tier (`BODY_HIT_BASE`/`REJECTED_BASE`)
   *  well above any real miss distance, so the search always prefers a worse miss over either. */
  distance: number;
  cleared: boolean;
  impactTick: number;
  rejection: LaunchRejection | null;
  bodyHit: boolean;
  probeIndex: number;
  command: Extract<Command, { kind: 'launch' }>;
}

function launchFeasibilityPenalty({
  sim,
  railIndex,
  launchTick,
  headingRad,
  speedMps,
  rejection,
}: {
  sim: Sim;
  railIndex: number;
  launchTick: number;
  headingRad: number;
  speedMps: number;
  rejection: LaunchRejection;
}): number {
  const rails = sim.rails;
  if (rejection === 'capacity') return REJECTED_BASE;
  if (rejection === 'reloading') {
    const last = sim.railLastLaunchTick[railIndex]!;
    const deficit = rails.reloadTicks[railIndex]! - (launchTick - last);
    return REJECTED_BASE + Math.max(deficit, 0);
  }
  if (rejection === 'speed') {
    const excess = Math.max(
      rails.muzzleSpeedMin[railIndex]! - speedMps,
      speedMps - rails.muzzleSpeedMax[railIndex]!,
      0,
    );
    return REJECTED_BASE + excess;
  }
  // 'cone': how far the launch heading sits outside the rail's cone, in cosine terms, scaled up
  // into a gradient that is meaningful next to metre-scale miss distances.
  const eph = makeEph(sim.bodies.count);
  const t = launchTick * sim.scenario.dt;
  evaluateEphemeris(sim.bodies, t, eph);
  const geometry = railGeometry({ bodies: sim.bodies, rails, rail: railIndex, t, eph });
  const normalized = normalizeHeadingRad(headingRad);
  const dot = Math.cos(normalized) * geometry.ux + Math.sin(normalized) * geometry.uy;
  const deficit = rails.cosHeadingCone[railIndex]! - dot;
  return REJECTED_BASE + Math.max(deficit, 0) * CONE_PENALTY_SCALE;
}

const RECEDE_FRACTION = 0.05;
const RECEDE_MIN_TICKS = 20;

/** Runs `priorLog` plus one trial launch through the real simulation and reports how close the
 *  launched probe came to `contactIndex` (ADR-0006 §5: "every evaluation runs the real
 *  simulation, never a separate model"). Deterministic and side-effect-free on its inputs -- a
 *  fresh `Sim` is created and advanced, never mutated in place by a caller. */
export function evaluateLaunch({
  scenario,
  seed,
  priorLog,
  railIndex,
  contactIndex,
  launchTick,
  headingRad,
  speedMps,
  maxFlightTicks,
}: EvaluateLaunchArgs): EvaluateLaunchResult {
  const heading = quantizeHeading(headingRad);
  const speed = quantizeSpeed(speedMps);
  const command = { tick: launchTick, kind: 'launch' as const, rail: railIndex, heading, speed };

  const sim = createSim({ scenario, seed });
  advance({ sim, log: sortLogByTick(priorLog), ticks: launchTick });

  const rejection = checkLaunch({ sim, command });
  if (rejection !== null) {
    const distance = launchFeasibilityPenalty({
      sim,
      railIndex,
      launchTick,
      headingRad,
      speedMps,
      rejection,
    });
    return {
      distance,
      cleared: false,
      impactTick: NO_IMPACT,
      rejection,
      bodyHit: false,
      probeIndex: -1,
      command,
    };
  }

  const probeIndex = sim.objects.count;
  const trialLog = sortLogByTick([...priorLog, command]);
  const eph = makeEph(sim.bodies.count);

  const t0 = launchTick * scenario.dt;
  evaluateEphemeris(sim.bodies, t0, eph);
  let prevContact: Point = contactPoint({
    bodies: sim.bodies,
    contacts: sim.contacts,
    contact: contactIndex,
    t: t0,
    eph,
  });
  // Position at the launch instant is a pure geometric consequence of the rail (not of heading
  // or speed, which only set velocity -- rails.ts's railGeometry), so it can be read directly
  // rather than waiting for the first tick to complete.
  const launchGeometry = railGeometry({
    bodies: sim.bodies,
    rails: sim.rails,
    rail: railIndex,
    t: t0,
    eph,
  });
  let prevProbe: Point = { x: launchGeometry.x, y: launchGeometry.y };

  let best = Infinity;
  let recedeStreak = 0;
  const recedeLimit = Math.max(RECEDE_MIN_TICKS, Math.floor(maxFlightTicks * RECEDE_FRACTION));

  for (let step = 0; step < maxFlightTicks; step++) {
    advance({ sim, log: trialLog, ticks: 1 });

    if (sim.objects.hitBody[probeIndex] !== -1) {
      return {
        distance: BODY_HIT_BASE + best,
        cleared: false,
        impactTick: NO_IMPACT,
        rejection: null,
        bodyHit: true,
        probeIndex,
        command,
      };
    }

    const t = sim.tick * scenario.dt;
    evaluateEphemeris(sim.bodies, t, eph);
    const contactNow = contactPoint({
      bodies: sim.bodies,
      contacts: sim.contacts,
      contact: contactIndex,
      t,
      eph,
    });
    const probeNow: Point = { x: sim.objects.x[probeIndex]!, y: sim.objects.y[probeIndex]! };

    const segDist = sweptSegmentDistance({
      probeStart: prevProbe,
      probeEnd: probeNow,
      contactStart: prevContact,
      contactEnd: contactNow,
    });
    if (segDist < best) {
      best = segDist;
      recedeStreak = 0;
    } else {
      recedeStreak++;
    }

    if (sim.contactState.cleared[contactIndex]) {
      return {
        distance: Math.min(best, 0),
        cleared: true,
        impactTick: sim.contactState.impactTick[contactIndex]!,
        rejection: null,
        bodyHit: false,
        probeIndex,
        command,
      };
    }

    prevProbe = probeNow;
    prevContact = contactNow;
    if (recedeStreak >= recedeLimit) break;
  }

  return {
    distance: best,
    cleared: false,
    impactTick: NO_IMPACT,
    rejection: null,
    bodyHit: false,
    probeIndex,
    command,
  };
}

// ---------------------------------------------------------------------------------------------
// Coarse-to-fine dt ladder and derivative-free search (research §B.1, §B.4, §B.6): seed each
// contact analytically, refine with a shrinking compass search, re-converge at each finer dt
// rather than trusting the coarsest rung's answer, then snap to integer units and polish.
// ---------------------------------------------------------------------------------------------

/** Every command's `tick` (and a burn's `atTick`) divided down into a coarser rung's own tick
 *  count (`toCoarseTick`) -- verify.ts's `doubleLogTicks` in reverse and generalised to any
 *  multiple, for replaying already-committed launches under a coarsened scenario. */
function scaleLogTicksDown(log: readonly Command[], multiple: number): Command[] {
  return log.map((command) =>
    command.kind === 'launch'
      ? { ...command, tick: toCoarseTick(command.tick, multiple) }
      : {
          ...command,
          tick: toCoarseTick(command.tick, multiple),
          atTick: toCoarseTick(command.atTick, multiple),
        },
  );
}

export interface SolveWindow {
  /** Ticks, at the level's own `dt`. */
  start: number;
  end: number;
}

export interface SolveLevelOptions {
  window?: SolveWindow;
  maxFlightTicks?: number;
  /** Total evaluation budget for the whole level, split across contacts and their rails. */
  budget?: number;
  /** Coarse-to-fine dt multiples; must end with 1 (the level's own `dt`). */
  dtMultiples?: readonly number[];
}

export interface ProgressEvent {
  stage: string;
  evals: number;
  bestMissKm: number;
}

export interface ContactBest {
  contactId: string;
  missKm: number;
}

export type SolveLevelResult =
  { solution: LevelSolution } | { failure: string; best: ContactBest[] };

const DEFAULT_BUDGET = 20000;
const DEFAULT_DT_MULTIPLES: readonly number[] = [16, 4, 1];
const REPLAY_MARGIN_TICKS = 5;
const MAX_VERIFY_RETRIES = 2;

function defaultDtMultiples(): readonly number[] {
  return DEFAULT_DT_MULTIPLES;
}

/** One host rotation (with margin) for the slowest-turning rail on the level, so the window
 *  covers a full launch-window cycle by default (ADR-0006 §5's own reasoning for `headingCone`
 *  being load-bearing: rotation phase is a real constraint). */
function defaultWindow(scenario: Scenario): SolveWindow {
  let widest = 100;
  for (const rail of scenario.rails) {
    const host = scenario.bodies[rail.host];
    if (!host) continue;
    widest = Math.max(widest, Math.ceil((host.rotationPeriod * 1.5) / scenario.dt));
  }
  return { start: 0, end: widest };
}

/** The actual body separation at epoch (not compile.ts's own from-the-primary bound, which sums
 *  each body's own worst-case distance from the system primary -- for two bodies close to each
 *  other in the same local subsystem, such as a rail on a moon and a contact on the planet it
 *  orbits, that bound is dominated by the planet's own distance from the star and so grossly
 *  overestimates the transfer, which in turn misleads the analytic seed's flight-time guess and
 *  the compass search's step scale) over the rail's own slowest muzzle speed, doubled for margin
 *  against eccentricity and phase drift, capped so a pathological level cannot make the default
 *  run away. */
function defaultMaxFlightTicks(scenario: Scenario): number {
  const bodies = createBodyTable(scenario.bodies);
  const eph = makeEph(bodies.count);
  evaluateEphemeris(bodies, 0, eph);

  let worstSeconds = 0;
  for (const rail of scenario.rails) {
    for (const contact of scenario.contacts) {
      const dx = eph.x[rail.host]! - eph.x[contact.host]!;
      const dy = eph.y[rail.host]! - eph.y[contact.host]!;
      const separation = Math.hypot(dx, dy) + 1;
      const minSpeed = Math.max(rail.muzzleSpeedMin, 1);
      worstSeconds = Math.max(worstSeconds, separation / minSpeed);
    }
  }
  const ticks = Math.ceil((worstSeconds * 2) / scenario.dt);
  return Math.min(Math.max(ticks, 200), 2_000_000);
}

interface CompassPoint {
  launchTick: number;
  headingRad: number;
  speedMps: number;
}

interface CompassBounds {
  windowStart: number;
  windowEnd: number;
  muzzleMin: number;
  muzzleMax: number;
}

/** Axis-aligned compass/pattern search with a shrinking step (research §B.1's "derivative-free
 *  local refinement" -- a compass search is the design's own named alternative to Nelder-Mead):
 *  tries heading +/- step and speed +/- step (and launch tick +/- step when `tickStep >= 1`),
 *  keeps any improvement, halves every step once a full pass finds none. Stops once every step
 *  is below its floor or the eval budget runs out. */
function compassSearch({
  evalHere,
  start,
  headingStep,
  speedStep,
  tickStep,
  minHeadingStep,
  minSpeedStep,
  bounds,
  maxEvals,
}: {
  evalHere: (point: CompassPoint) => EvaluateLaunchResult;
  start: CompassPoint;
  headingStep: number;
  speedStep: number;
  tickStep: number;
  minHeadingStep: number;
  minSpeedStep: number;
  bounds: CompassBounds;
  maxEvals: number;
}): { point: CompassPoint; result: EvaluateLaunchResult; evalsUsed: number } {
  const clamp = (candidate: CompassPoint): CompassPoint => ({
    launchTick: Math.min(
      bounds.windowEnd,
      Math.max(bounds.windowStart, Math.round(candidate.launchTick)),
    ),
    headingRad: candidate.headingRad,
    speedMps: Math.min(bounds.muzzleMax, Math.max(bounds.muzzleMin, candidate.speedMps)),
  });

  let point = clamp(start);
  let best = evalHere(point);
  let evalsUsed = 1;
  let hStep = headingStep;
  let sStep = speedStep;
  let tStep = tickStep >= 1 ? Math.floor(tickStep) : 0;

  while (evalsUsed < maxEvals && (hStep > minHeadingStep || sStep > minSpeedStep || tStep >= 1)) {
    let improved = false;
    const moves: CompassPoint[] = [
      { ...point, headingRad: point.headingRad + hStep },
      { ...point, headingRad: point.headingRad - hStep },
      { ...point, speedMps: point.speedMps + sStep },
      { ...point, speedMps: point.speedMps - sStep },
    ];
    if (tStep >= 1) {
      moves.push({ ...point, launchTick: point.launchTick + tStep });
      moves.push({ ...point, launchTick: point.launchTick - tStep });
    }
    for (const move of moves) {
      if (evalsUsed >= maxEvals) break;
      const candidate = clamp(move);
      const result = evalHere(candidate);
      evalsUsed++;
      if (result.distance < best.distance) {
        point = candidate;
        best = result;
        improved = true;
      }
    }
    if (!improved) {
      hStep /= 2;
      sStep /= 2;
      tStep = tStep >= 1 ? Math.floor(tStep / 2) : 0;
    }
  }

  return { point, result: best, evalsUsed };
}

const SEED_GRID_COUNT = 9;
const SEED_KEEP = 5;
const HEADING_GRID_HEADINGS: number = 7;
const HEADING_GRID_SPEEDS: number = 5;
const TICK_POLISH_RADIUS = 15;
const TICK_POLISH_EVALS_PER_RESTART = 24;
// A hard ceiling on any single compassSearch call, independent of how much of the overall budget
// is left: passing `budgetLeft()` alone as `maxEvals` let one call spend nearly the *whole*
// remaining budget if it kept finding marginal improvements without its step ever shrinking below
// the floor (found running the hard-case evidence below -- a single restart ran for well over an
// hour). The overall budget is meant to buy many bounded restarts, not fund one that never
// converges.
const MAX_COMPASS_EVALS = 300;

function seedGridTicks({
  windowStart,
  windowEnd,
}: {
  windowStart: number;
  windowEnd: number;
}): number[] {
  const span = windowEnd - windowStart;
  const count = Math.min(SEED_GRID_COUNT, span + 1);
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(count === 1 ? windowStart : windowStart + Math.round((i * span) / (count - 1)));
  }
  return ticks;
}

/** Straight-line lead: aim the total inertial launch velocity at where the contact will be after
 *  the estimated flight time, iterating the flight time a few times (research §B.1, mirroring
 *  GRV-0015's and GRV-0017's own throwaway search scripts). Gravity-free -- it is a seed for the
 *  compass search that follows, not a claim of accuracy on its own. */
function analyticAim({
  bodies,
  rails,
  contacts,
  railIndex,
  contactIndex,
  dt,
  launchTick,
  muzzleMin,
  muzzleMax,
  maxFlightTicks,
}: {
  bodies: Sim['bodies'];
  rails: Sim['rails'];
  contacts: Sim['contacts'];
  railIndex: number;
  contactIndex: number;
  dt: number;
  launchTick: number;
  muzzleMin: number;
  muzzleMax: number;
  maxFlightTicks: number;
}): { headingRad: number; speedMps: number } {
  const eph = makeEph(bodies.count);
  const t0 = launchTick * dt;
  evaluateEphemeris(bodies, t0, eph);
  const launchGeom = railGeometry({ bodies, rails, rail: railIndex, t: t0, eph });

  let flightTicks = Math.max(1, Math.round(maxFlightTicks / 2));
  let headingRad = 0;
  let speedMps = (muzzleMin + muzzleMax) / 2;

  for (let iter = 0; iter < 6; iter++) {
    const tArrive = t0 + flightTicks * dt;
    evaluateEphemeris(bodies, tArrive, eph);
    const target = contactPoint({ bodies, contacts, contact: contactIndex, t: tArrive, eph });
    const dxp = target.x - launchGeom.x;
    const dyp = target.y - launchGeom.y;
    const flightSeconds = flightTicks * dt;
    if (flightSeconds <= 0) break;
    const totalVx = dxp / flightSeconds;
    const totalVy = dyp / flightSeconds;
    const muzzleVx = totalVx - launchGeom.vx;
    const muzzleVy = totalVy - launchGeom.vy;
    const muzzleSpeed = Math.hypot(muzzleVx, muzzleVy);
    headingRad = Math.atan2(muzzleVy, muzzleVx);
    speedMps = Math.min(muzzleMax, Math.max(muzzleMin, muzzleSpeed));
    if (speedMps <= 0) break;
    const distance = Math.hypot(dxp, dyp);
    const nextFlightTicks = Math.max(
      1,
      Math.min(maxFlightTicks, Math.round(distance / speedMps / dt)),
    );
    if (nextFlightTicks === flightTicks) break;
    flightTicks = nextFlightTicks;
  }

  return { headingRad, speedMps };
}

interface SearchRailResult {
  launchTick: number;
  headingRad: number;
  speedMps: number;
  distance: number;
  cleared: boolean;
  impactTick: number;
  evals: number;
}

/** One rail's whole search for one contact: seed the coarsest dt rung, refine with a compass
 *  search, re-converge down the ladder to the level's own `dt` (keeping the best result seen at
 *  the *target* scale across every rung -- research §B.4's "a rung can regress"), then a final
 *  integer-unit polish. Every point is evaluated through the real simulation
 *  (`evaluateLaunch`). */
function searchRail({
  scenario,
  seed,
  priorLog,
  railIndex,
  contactIndex,
  window,
  maxFlightTicks,
  budget,
  dtMultiples,
  stageLabel,
  onProgress,
}: {
  scenario: Scenario;
  seed: number;
  priorLog: readonly Command[];
  railIndex: number;
  contactIndex: number;
  window: SolveWindow;
  maxFlightTicks: number;
  budget: number;
  dtMultiples: readonly number[];
  stageLabel: string;
  onProgress?: (event: ProgressEvent) => void;
}): SearchRailResult {
  const rail = scenario.rails[railIndex]!;
  let evals = 0;
  const budgetLeft = (): number => Math.max(1, budget - evals);

  let currentPoint: CompassPoint | null = null;
  let globalBest: { point: CompassPoint; result: EvaluateLaunchResult } | null = null;

  for (const multiple of dtMultiples) {
    if (evals >= budget) break;
    const rungScenario = multiple === 1 ? scenario : coarsenScenario({ scenario, multiple });
    const rungPriorLog = multiple === 1 ? priorLog : scaleLogTicksDown(priorLog, multiple);
    const rungWindowStart = toCoarseTick(window.start, multiple);
    const rungWindowEnd = Math.max(rungWindowStart, toCoarseTick(window.end, multiple));
    const rungMaxFlight = Math.max(1, toCoarseTick(maxFlightTicks, multiple));
    const bounds: CompassBounds = {
      windowStart: rungWindowStart,
      windowEnd: rungWindowEnd,
      muzzleMin: rail.muzzleSpeedMin,
      muzzleMax: rail.muzzleSpeedMax,
    };

    const evalHere = (point: CompassPoint): EvaluateLaunchResult => {
      evals++;
      return evaluateLaunch({
        scenario: rungScenario,
        seed,
        priorLog: rungPriorLog,
        railIndex,
        contactIndex,
        launchTick: point.launchTick,
        headingRad: point.headingRad,
        speedMps: point.speedMps,
        maxFlightTicks: rungMaxFlight,
      });
    };

    let rungStart: CompassPoint;
    if (currentPoint === null) {
      // Stage 1: seed the coarsest rung -- an analytic lead-aim plus a small heading/speed grid
      // per candidate launch tick, keeping the best few seeds.
      const staticSim = createSim({ scenario: rungScenario, seed });
      const seeds: { point: CompassPoint; result: EvaluateLaunchResult }[] = [];
      for (const tick of seedGridTicks({
        windowStart: rungWindowStart,
        windowEnd: rungWindowEnd,
      })) {
        if (evals >= budget) break;
        const eph = makeEph(staticSim.bodies.count);
        const t0 = tick * rungScenario.dt;
        evaluateEphemeris(staticSim.bodies, t0, eph);
        const launchGeom = railGeometry({
          bodies: staticSim.bodies,
          rails: staticSim.rails,
          rail: railIndex,
          t: t0,
          eph,
        });
        const verticalHeading = Math.atan2(launchGeom.uy, launchGeom.ux);

        const aim = analyticAim({
          bodies: staticSim.bodies,
          rails: staticSim.rails,
          contacts: staticSim.contacts,
          railIndex,
          contactIndex,
          dt: rungScenario.dt,
          launchTick: tick,
          muzzleMin: rail.muzzleSpeedMin,
          muzzleMax: rail.muzzleSpeedMax,
          maxFlightTicks: rungMaxFlight,
        });
        const aimPoint = { launchTick: tick, headingRad: aim.headingRad, speedMps: aim.speedMps };
        seeds.push({ point: aimPoint, result: evalHere(aimPoint) });

        // A plain grid over heading inside the cone x a few speeds (research §B.1), alongside
        // the analytic aim above: on a long, gravity-curved transfer the straight-line lead is
        // only a starting guess, and a spread of headings across the whole firing cone gives the
        // refinement stage a much better chance of starting in the right basin.
        for (let h = 0; h < HEADING_GRID_HEADINGS && evals < budget; h++) {
          const headingFrac =
            HEADING_GRID_HEADINGS === 1 ? 0 : (h / (HEADING_GRID_HEADINGS - 1)) * 2 - 1;
          const headingRad = verticalHeading + headingFrac * rail.headingCone;
          for (let s = 0; s < HEADING_GRID_SPEEDS && evals < budget; s++) {
            const frac = HEADING_GRID_SPEEDS === 1 ? 0.5 : s / (HEADING_GRID_SPEEDS - 1);
            const speed = rail.muzzleSpeedMin + frac * (rail.muzzleSpeedMax - rail.muzzleSpeedMin);
            const gridPoint = { launchTick: tick, headingRad, speedMps: speed };
            seeds.push({ point: gridPoint, result: evalHere(gridPoint) });
          }
        }
      }

      if (seeds.length === 0) {
        rungStart = {
          launchTick: rungWindowStart,
          headingRad: 0,
          speedMps: (rail.muzzleSpeedMin + rail.muzzleSpeedMax) / 2,
        };
      } else {
        seeds.sort((a, b) => a.result.distance - b.result.distance);
        let bestRefined: { point: CompassPoint; result: EvaluateLaunchResult } | null = null;
        for (const seedPoint of seeds.slice(0, SEED_KEEP)) {
          if (evals >= budget) break;
          const refined = compassSearch({
            evalHere,
            start: seedPoint.point,
            headingStep: rail.headingCone / 3,
            speedStep: (rail.muzzleSpeedMax - rail.muzzleSpeedMin) / 6 || 1,
            tickStep: Math.max(1, Math.floor((rungWindowEnd - rungWindowStart) / 8)),
            minHeadingStep: 1e-6,
            minSpeedStep: 1e-3,
            bounds,
            maxEvals: Math.min(MAX_COMPASS_EVALS, budgetLeft()),
          });
          if (!bestRefined || refined.result.distance < bestRefined.result.distance)
            bestRefined = { point: refined.point, result: refined.result };
        }
        rungStart = (bestRefined ?? seeds[0]!).point;
      }
    } else {
      // Later rungs: keep refining from the previous rung's own result (research §B.4 -- each
      // rung re-converges rather than trusting the coarser one blindly).
      const seeded: CompassPoint = {
        launchTick: Math.min(
          rungWindowEnd,
          Math.max(rungWindowStart, toCoarseTick(currentPoint.launchTick, multiple)),
        ),
        headingRad: currentPoint.headingRad,
        speedMps: currentPoint.speedMps,
      };
      const refined = compassSearch({
        evalHere,
        start: seeded,
        headingStep: rail.headingCone / 20,
        speedStep: (rail.muzzleSpeedMax - rail.muzzleSpeedMin) / 40 || 1,
        tickStep: Math.max(1, Math.floor((rungWindowEnd - rungWindowStart) / 32)),
        minHeadingStep: 1e-7,
        minSpeedStep: 1e-4,
        bounds,
        maxEvals: Math.min(MAX_COMPASS_EVALS, budgetLeft()),
      });
      rungStart = refined.point;
    }

    // Carried forward in fine-tick units so the next (finer) rung can rescale it exactly.
    currentPoint = {
      launchTick: toFineTick(rungStart.launchTick, multiple),
      headingRad: rungStart.headingRad,
      speedMps: rungStart.speedMps,
    };

    // Compared at the *target* (level's own dt) scale every time, so a rung that regresses can
    // never displace a better earlier rung (research §B.4's own measured regression).
    evals++;
    const targetResult = evaluateLaunch({
      scenario,
      seed,
      priorLog,
      railIndex,
      contactIndex,
      launchTick: currentPoint.launchTick,
      headingRad: currentPoint.headingRad,
      speedMps: currentPoint.speedMps,
      maxFlightTicks,
    });
    if (!globalBest || targetResult.distance < globalBest.result.distance)
      globalBest = { point: currentPoint, result: targetResult };

    onProgress?.({
      stage: `${stageLabel} dt*${multiple}`,
      evals,
      bestMissKm: globalBest.result.distance / 1000,
    });
  }

  if (!globalBest) {
    const fallback = evaluateLaunch({
      scenario,
      seed,
      priorLog,
      railIndex,
      contactIndex,
      launchTick: window.start,
      headingRad: 0,
      speedMps: rail.muzzleSpeedMin,
      maxFlightTicks,
    });
    return {
      launchTick: window.start,
      headingRad: 0,
      speedMps: rail.muzzleSpeedMin,
      distance: fallback.distance,
      cleared: fallback.cleared,
      impactTick: fallback.impactTick,
      evals: evals + 1,
    };
  }

  // Stage 3: integer snapping + final polish, directly in integer units, launch tick fixed.
  const integerBounds: CompassBounds = {
    windowStart: window.start,
    windowEnd: window.end,
    muzzleMin: rail.muzzleSpeedMin,
    muzzleMax: rail.muzzleSpeedMax,
  };
  const integerEval = (point: CompassPoint): EvaluateLaunchResult => {
    evals++;
    return evaluateLaunch({
      scenario,
      seed,
      priorLog,
      railIndex,
      contactIndex,
      launchTick: point.launchTick,
      headingRad: point.headingRad,
      speedMps: point.speedMps,
      maxFlightTicks,
    });
  };
  const headingQuantum = TWO_PI / HEADING_TURN;
  const polishFrom = (
    point: CompassPoint,
    maxEvals: number,
  ): { point: CompassPoint; result: EvaluateLaunchResult } => {
    const polished = compassSearch({
      evalHere: integerEval,
      start: point,
      headingStep: headingQuantum * (1 << 18),
      speedStep: 1,
      tickStep: 0,
      minHeadingStep: headingQuantum * 0.5,
      minSpeedStep: 0.0005,
      bounds: integerBounds,
      maxEvals,
    });
    return { point: polished.point, result: polished.result };
  };

  const firstPolish = polishFrom(globalBest.point, Math.min(MAX_COMPASS_EVALS, budgetLeft()));
  if (firstPolish.result.distance < globalBest.result.distance) globalBest = firstPolish;

  // Heading/speed alone landed close but short (the linearised tick-boundary objective and the
  // real simulation's own finer substep impact test do not agree to the metre -- research §B.4):
  // the launch tick itself is also worth a fine local sweep before giving up, each nearby tick
  // repolished in heading/speed. Each restart is capped at TICK_POLISH_EVALS_PER_RESTART rather
  // than the full remaining budget, so a wide, still-unclear sweep stays bounded in wall time
  // instead of one restart spending the whole budget on a tick that was never going to clear.
  if (!globalBest.result.cleared) {
    for (
      let offset = -TICK_POLISH_RADIUS;
      offset <= TICK_POLISH_RADIUS && evals < budget;
      offset++
    ) {
      if (offset === 0) continue;
      const tick = globalBest.point.launchTick + offset;
      if (tick < window.start || tick > window.end) continue;
      const attempt = polishFrom(
        { ...globalBest.point, launchTick: tick },
        Math.min(TICK_POLISH_EVALS_PER_RESTART, budgetLeft()),
      );
      if (attempt.result.distance < globalBest.result.distance) globalBest = attempt;
      if (globalBest.result.cleared) break;
    }
  }

  onProgress?.({
    stage: `${stageLabel} polish`,
    evals,
    bestMissKm: globalBest.result.distance / 1000,
  });

  return {
    launchTick: globalBest.point.launchTick,
    headingRad: globalBest.point.headingRad,
    speedMps: globalBest.point.speedMps,
    distance: globalBest.result.distance,
    cleared: globalBest.result.cleared,
    impactTick: globalBest.result.impactTick,
    evals,
  };
}

interface SolveContactOutcome {
  command: Extract<Command, { kind: 'launch' }> | null;
  reason: string;
  missMeters: number;
  impactTick: number;
  evals: number;
}

/** The earliest tick `railIndex` may fire again given commands already committed for earlier
 *  contacts (ADR-0006 §5: "later launches respect reloadTicks on the same rail"). */
function earliestAllowedLaunchTick({
  priorLog,
  railIndex,
  reloadTicks,
  windowStart,
}: {
  priorLog: readonly Command[];
  railIndex: number;
  reloadTicks: number;
  windowStart: number;
}): number {
  let latest = -1;
  for (const command of priorLog)
    if (command.kind === 'launch' && command.rail === railIndex)
      latest = Math.max(latest, command.tick);
  return latest === -1 ? windowStart : Math.max(windowStart, latest + reloadTicks);
}

/** Solves one contact by trying every rail (whichever clears first wins; the smallest miss wins
 *  if none does) and returns either a launch command or a reason. */
function solveContact({
  scenario,
  seed,
  priorLog,
  contactIndex,
  contactId,
  window,
  maxFlightTicks,
  budget,
  dtMultiples,
  onProgress,
}: {
  scenario: Scenario;
  seed: number;
  priorLog: readonly Command[];
  contactIndex: number;
  contactId: string;
  window: SolveWindow;
  maxFlightTicks: number;
  budget: number;
  dtMultiples: readonly number[];
  onProgress?: (event: ProgressEvent) => void;
}): SolveContactOutcome {
  const perRailBudget = Math.max(50, Math.floor(budget / scenario.rails.length));
  let totalEvals = 0;
  let bestAttempt: (SearchRailResult & { railIndex: number }) | null = null;

  for (let railIndex = 0; railIndex < scenario.rails.length; railIndex++) {
    const rail = scenario.rails[railIndex]!;
    const earliest = earliestAllowedLaunchTick({
      priorLog,
      railIndex,
      reloadTicks: rail.reloadTicks,
      windowStart: window.start,
    });
    if (earliest > window.end) continue;

    const attempt = searchRail({
      scenario,
      seed,
      priorLog,
      railIndex,
      contactIndex,
      window: { start: earliest, end: window.end },
      maxFlightTicks,
      budget: perRailBudget,
      dtMultiples,
      stageLabel: `contact ${contactId} rail ${railIndex}`,
      onProgress,
    });
    totalEvals += attempt.evals;
    if (!bestAttempt || attempt.distance < bestAttempt.distance)
      bestAttempt = { ...attempt, railIndex };
    if (bestAttempt.cleared) break;
  }

  if (!bestAttempt)
    return {
      command: null,
      reason: 'no rail can reload in time within the search window',
      missMeters: Infinity,
      impactTick: NO_IMPACT,
      evals: totalEvals,
    };

  if (!bestAttempt.cleared)
    return {
      command: null,
      reason: `best miss ${(bestAttempt.distance / 1000).toFixed(1)} km across ${scenario.rails.length} rail(s), did not clear within budget`,
      missMeters: bestAttempt.distance,
      impactTick: bestAttempt.impactTick,
      evals: totalEvals,
    };

  const command = {
    tick: bestAttempt.launchTick,
    kind: 'launch' as const,
    rail: bestAttempt.railIndex,
    heading: quantizeHeading(bestAttempt.headingRad),
    speed: quantizeSpeed(bestAttempt.speedMps),
  };
  return {
    command,
    reason: '',
    missMeters: 0,
    impactTick: bestAttempt.impactTick,
    evals: totalEvals,
  };
}

/** Finds a command log that clears every fixed contact in `level`, in level order (ADR-0006 §5,
 *  docs/work/GRV-0018-level-solver.md). Deterministic: identical inputs give a byte-identical
 *  solution (no clock, no unseeded randomness -- the whole search is a fixed sequence of real
 *  simulation replays). Accepts only when the real simulation, at the level's own `dt`, reports
 *  every contact cleared *and* `verifyLevel` (including its `dt/2` replay) reports no failures;
 *  a `dt/2` disagreement retries with a larger budget rather than giving up immediately (research
 *  §B.4/ADR-0006 §5 -- minimising miss distance, not just clearing, is what keeps a solution away
 *  from that edge in the first place). A mid-course burn is not implemented (YAGNI): every level
 *  this unit had to solve -- the compiler fixture and both evidence scenarios -- cleared with a
 *  direct launch alone, matching GRV-0015's own finding for a closely analogous geometry. */
export function solveLevel({
  level,
  options = {},
  onProgress,
}: {
  level: CompiledLevel;
  options?: SolveLevelOptions;
  onProgress?: (event: ProgressEvent) => void;
}): SolveLevelResult {
  const scenario = level.scenario;
  if (level.contactIds.length === 0) return { failure: 'level has no contacts to solve', best: [] };
  if (level.contactIds.length > scenario.capacity)
    return {
      failure: `level has ${level.contactIds.length} contact(s) but only ${scenario.capacity} probe(s) granted`,
      best: [],
    };
  if (scenario.rails.length === 0)
    return { failure: 'level has no rails to launch from', best: [] };

  const window = options.window ?? defaultWindow(scenario);
  const maxFlightTicks = options.maxFlightTicks ?? defaultMaxFlightTicks(scenario);
  const totalBudget = options.budget ?? DEFAULT_BUDGET;
  const dtMultiples = options.dtMultiples ?? defaultDtMultiples();
  const perContactBudget = Math.max(200, Math.floor(totalBudget / level.contactIds.length));

  const solveOnce = (
    budgetMultiplier: number,
  ):
    | { log: Command[]; best: ContactBest[]; maxImpactTick: number }
    | { failure: string; best: ContactBest[] } => {
    const log: Command[] = [];
    const best: ContactBest[] = [];
    let maxImpactTick = 0;
    for (let c = 0; c < level.contactIds.length; c++) {
      const contactId = level.contactIds[c]!;
      const outcome = solveContact({
        scenario,
        seed: level.seed,
        priorLog: log,
        contactIndex: c,
        contactId,
        window,
        maxFlightTicks,
        budget: Math.floor(perContactBudget * budgetMultiplier),
        dtMultiples,
        onProgress,
      });
      best.push({ contactId, missKm: outcome.missMeters / 1000 });
      if (!outcome.command) return { failure: `contact "${contactId}": ${outcome.reason}`, best };
      log.push(outcome.command);
      maxImpactTick = Math.max(maxImpactTick, outcome.impactTick);
    }
    return { log, best, maxImpactTick };
  };

  let lastBest: ContactBest[] = [];
  for (let attempt = 0; attempt <= MAX_VERIFY_RETRIES; attempt++) {
    const outcome = solveOnce(3 ** attempt);
    if ('failure' in outcome) return outcome;
    lastBest = outcome.best;

    const sortedLog = sortLogByTick(outcome.log);
    const lastTick = sortedLog.reduce((m, c) => Math.max(m, c.tick), 0);
    const ticks = Math.max(lastTick, outcome.maxImpactTick) + REPLAY_MARGIN_TICKS;
    const solution: LevelSolution = {
      level: level.id,
      simVersion: SIM_VERSION,
      ticks,
      log: sortedLog,
    };

    const { failures } = verifyLevel({
      level,
      levelHash: 'sha256:solver',
      solution,
      solutionHash: 'sha256:solver',
    });
    if (failures.length === 0) return { solution };
    if (attempt === MAX_VERIFY_RETRIES)
      return {
        failure: `solution found but verifyLevel failed: ${failures.join('; ')}`,
        best: lastBest,
      };
  }

  return { failure: 'solver exhausted retries', best: lastBest };
}
