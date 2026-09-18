// Predicts a running (already-committed, still-flying) probe's remaining flight (GRV-0027 design
// note): a fresh, isolated Sim replays the committed log from tick 0 to `fromTick`, then keeps
// advancing with the *same* log to `horizonTick`, reading off the probe's own closest-approach and
// impact/body-hit events -- warpToEvent's own "next event" query needs these without waiting for
// them to actually happen. This is not src/planner/ghost.ts's `integrateGhost`: that always issues
// a *new* launch command for a still-being-drafted plan; a running probe has already launched and
// any future burns of its own are already in the committed log, so this only needs to keep the
// same log running, never re-issue anything. Per docs/domain/simulation-determinism.md's two-tier
// model, dynamic objects never perturb each other, so this isolated replay matches the live
// session's own trajectory for this probe bit for bit.
//
// GRV-0031's own addition: a predicted impact carries `arrivalTick`, the tick the post's own
// downlink would reveal it, computed from the predicted position at the instant it truly happens
// (`downlinkArrivalOf`, below) -- so `warpToEvent()`'s own "next event" reads the same *confirmed*
// tick a real telemetry impact event eventually carries (ADR-0007 §6, src/app/events.ts's own
// `diffObservedEvents`), never the bare true tick a player cannot actually act on any sooner than
// telemetry allows. `downlinkEmission` (sim/lightcone.ts) cannot answer this directly -- it solves
// emission from a *reception* tick by searching the object's retained history backward, and a
// predicted future tick has no history yet to search (docs/evidence/GRV-0029/README.md's own design
// decision on this same asymmetry). `downlinkArrivalOf` is the forward counterpart: the source's
// position is already known exactly (a genuine prediction, not a live guess), so this only needs
// to solve for the post's own reception tick, exactly the light-cone equation `uplinkArrival`
// solves, with the post itself playing the moving-and-analytic role `uplinkArrival` gives the rail/
// object target (both light-cone problems reduce to "one point's position is a closed-form function
// of continuous time, the other is a fixed point known exactly" -- here it is the post that varies).
import { advance, createSim } from '../sim/sim.ts';
import type { Command, Sim } from '../sim/sim.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { contactPoint } from '../sim/contacts.ts';
import { C } from '../sim/lightcone.ts';
import { postPositionAtTime } from '../sim/post.ts';
import type { CompiledLevel } from './levels.ts';
import { sampleClosestApproach } from './events.ts';
import type { RangeTrend, SimEvent } from './events.ts';

const DOWNLINK_NEWTON_ITERATIONS = 3;

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The tick the post's own downlink reveals an event that truly happens at `emissionTick`, from a
 *  KNOWN, exact source position then -- module header's "forward counterpart of downlinkEmission".
 *  Three Newton iterations from the geometric starter (matching sim/lightcone.ts's own fixed count,
 *  determinism rule 7), `ceil`-quantised like every arrival (ADR-0007 §8).
 *
 *  Pure light-cone geometry, no occlusion check (unlike `observedState`/`downlinkEmission`'s own
 *  `segmentBlocked` call): the real confirmation can land a little *later* than this whenever the
 *  direct path happens to be blocked right around the predicted tick (confirmed directly against
 *  T01-far-post's own post-impact geometry, tests/e2e/telemetry.spec.ts) -- the same *category* of
 *  gap the design already accepts elsewhere (a predicted tick that isn't necessarily where real
 *  telemetry actually lands, docs/issues/2026-09-18-warptoevent-dead-zone-for-a-delayed-post.md's
 *  own L01 precedent), not a new one. Adding occlusion awareness here would need the object's own
 *  predicted position at nearby ticks too (segmentBlocked's own per-tick snapshot), which this
 *  function's single-instant contract doesn't carry -- left as a known limitation rather than
 *  widened speculatively. */
export function downlinkArrivalOf({
  sim,
  emissionTick,
  x,
  y,
}: {
  sim: Sim;
  emissionTick: number;
  x: number;
  y: number;
}): number {
  const dt = sim.scenario.dt;
  const te = emissionTick * dt;
  const post0 = postPositionAtTime({ sim, t: te });
  let t = te + distance(x, y, post0.x, post0.y) / C;

  for (let iter = 0; iter < DOWNLINK_NEWTON_ITERATIONS; iter++) {
    const post = postPositionAtTime({ sim, t });
    const dx = post.x - x;
    const dy = post.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d === 0) break; // the post sits exactly on the source: g is already exactly 0, the root.
    const g = d - C * (t - te);
    const gp = (dx * post.vx + dy * post.vy) / d - C;
    t = t - g / gp;
  }

  return Math.ceil(t / dt);
}

function makeEph(count: number): EphemerisOut {
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
  };
}

/** Every contact's world position at `sim`'s current tick (contactPoint, mirroring src/planner/
 *  ghost.ts's own per-tick contact sampling). */
function contactPositionsAt(sim: Sim, eph: EphemerisOut): { x: number; y: number }[] {
  const t = sim.tick * sim.scenario.dt;
  evaluateEphemeris(sim.bodies, t, eph);
  const points: { x: number; y: number }[] = new Array(sim.contacts.count);
  for (let c = 0; c < sim.contacts.count; c++) {
    points[c] = contactPoint({ bodies: sim.bodies, contacts: sim.contacts, contact: c, t, eph });
  }
  return points;
}

/** `probe`'s predicted closest-approach/impact/body-hit events between `fromTick` and
 *  `horizonTick`, replaying `log` (every command already committed) on a fresh, isolated Sim --
 *  `[]` if the probe doesn't exist yet at `fromTick` or is already expended (an expended object
 *  never moves again, ADR-0005 "Burns"; prediction stops at the probe's own first impact/body hit,
 *  same as ghost.ts's own runLoop). */
export function predictProbe({
  level,
  log,
  probe,
  fromTick,
  horizonTick,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  probe: number;
  fromTick: number;
  horizonTick: number;
}): SimEvent[] {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  advance({ sim, log, ticks: fromTick });
  if (probe >= sim.objects.count) return [];
  if (sim.objects.hitBody[probe] !== -1 || sim.objects.hitContact[probe] !== -1) return [];

  const contactCount = sim.contacts.count;
  const eph = makeEph(sim.bodies.count);
  const trends: (RangeTrend | null)[] = new Array(contactCount).fill(null);
  const events: SimEvent[] = [];

  while (sim.tick < horizonTick) {
    advance({ sim, log, ticks: 1 });
    const tick = sim.tick;

    if (contactCount > 0) {
      const positions = contactPositionsAt(sim, eph);
      const px = sim.objects.x[probe]!;
      const py = sim.objects.y[probe]!;
      for (let c = 0; c < contactCount; c++) {
        if (sim.contactState.cleared[c]) continue;
        const range = Math.hypot(px - positions[c]!.x, py - positions[c]!.y);
        const { trend, event } = sampleClosestApproach({
          prior: trends[c]!,
          tick,
          probe,
          contact: c,
          range,
        });
        trends[c] = trend;
        if (event) events.push(event);
      }
    }

    const hitContact = sim.objects.hitContact[probe]!;
    const hitBody = sim.objects.hitBody[probe]!;
    if (hitContact !== -1) {
      const impactTick = sim.contactState.impactTick[hitContact]!;
      // The predicted position AT the impact tick, not sim's own (already past it) current one --
      // the object never moves again once expended (ADR-0005 "Burns"), so its position now equals
      // its position then, but reading straight from a known-good sample is honest either way.
      events.push({
        tick: impactTick,
        kind: 'impact',
        probe,
        contact: hitContact,
        arrivalTick: downlinkArrivalOf({
          sim,
          emissionTick: impactTick,
          x: sim.objects.x[probe]!,
          y: sim.objects.y[probe]!,
        }),
      });
      break;
    }
    if (hitBody !== -1) {
      events.push({ tick: tick - 1, kind: 'bodyHit', probe, body: hitBody });
      break;
    }
  }

  return events;
}

/** `probe`'s predicted position every tick from `fromTick` to `horizonTick`, replaying `log` on a
 *  fresh, isolated Sim -- the same exact-future replay `predictProbe` itself performs, reading off
 *  positions instead of events (GRV-0031's own uplink-availability band, src/ui/timeline.ts's
 *  `computeUplinkWindows`, "for the drafted or SELECTED probe": a selected, not-being-drafted-or-
 *  amended probe has no ghost of its own to sample). `[]` past the probe's own creation tick or
 *  once it is expended, mirroring `predictProbe`'s own stopping rules. */
export function predictProbePath({
  level,
  log,
  probe,
  fromTick,
  horizonTick,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  probe: number;
  fromTick: number;
  horizonTick: number;
}): { tick: number; x: number; y: number }[] {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  advance({ sim, log, ticks: fromTick });
  // `fromTick` may precede the probe's own materialisation (GRV-0031's own `uplinkWindows()`
  // wants a whole-flight path, launch to horizon, not "now" -- src/app/app.ts's own
  // `computeCurrentUplinkWindows`) -- advance to wherever it actually starts existing rather than
  // reporting an empty path.
  while (probe >= sim.objects.count && sim.tick < horizonTick) advance({ sim, log, ticks: 1 });
  if (probe >= sim.objects.count) return [];
  if (sim.objects.hitBody[probe] !== -1 || sim.objects.hitContact[probe] !== -1) return [];

  const path: { tick: number; x: number; y: number }[] = [
    { tick: sim.tick, x: sim.objects.x[probe]!, y: sim.objects.y[probe]! },
  ];
  while (sim.tick < horizonTick) {
    advance({ sim, log, ticks: 1 });
    path.push({ tick: sim.tick, x: sim.objects.x[probe]!, y: sim.objects.y[probe]! });
    if (sim.objects.hitBody[probe] !== -1 || sim.objects.hitContact[probe] !== -1) break;
  }
  return path;
}
