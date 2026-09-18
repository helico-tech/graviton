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
import { advance, createSim } from '../sim/sim.ts';
import type { Command, Sim } from '../sim/sim.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { contactPoint } from '../sim/contacts.ts';
import type { CompiledLevel } from './levels.ts';
import { sampleClosestApproach } from './events.ts';
import type { RangeTrend, SimEvent } from './events.ts';

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
      events.push({
        tick: sim.contactState.impactTick[hitContact]!,
        kind: 'impact',
        probe,
        contact: hitContact,
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
