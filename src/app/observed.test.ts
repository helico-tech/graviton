// Tests for the post's picture of every dynamic object (GRV-0030, ADR-0007 §5-6) -- specifically
// the two things telemetry.test.ts (src/sim/telemetry.ts) doesn't cover: that a replayed
// prediction is exact (bit-identical to an independent cold replay to the same tick, the module's
// own "the plan is known, so the prediction is exact" design claim) and that the incremental
// per-object cache (this module's own "Cost" doc) actually resumes rather than silently doing a
// cold replay every call -- both genuinely break-able (an off-by-one in the resume delta, or a
// stale cache surviving a log that grew) and neither exercised directly by the app/e2e level.
import { describe, expect, test } from 'vitest';
import { createObservedCache, observedObjects } from './observed.ts';
import type { CompiledLevel } from './levels.ts';
import { advance, createSim } from '../sim/sim.ts';
import type { Command, Scenario } from '../sim/sim.ts';

const DT = 30;
// ~4.5e10 m between post and rail host -- light delay ~150 s, 5 ticks at dt=30 -- large enough
// that "before first light", "after", and a multi-tick incremental resume are all exercised
// without the test needing an enormous tick count.
const RAIL_DISTANCE = 4.5e10;

function scenario(): Scenario {
  return {
    dt: DT,
    capacity: 2,
    burnNodeCapacity: 0,
    bodies: [
      { parent: -1, mu: 1e20, radius: 1e6, rotationPeriod: 1e30, axialPhaseAtEpoch: 0 },
      {
        parent: 0,
        mu: 1,
        radius: 1e5,
        a: RAIL_DISTANCE,
        e: 0,
        argPeriapsis: 0,
        meanAnomaly0: 0,
        rotationPeriod: 1e30,
        axialPhaseAtEpoch: 0,
      },
    ],
    rails: [
      {
        host: 1,
        longitude: Math.PI, // facing back toward the post's own host, mirrors T01-far-post
        muzzleSpeedMin: 1,
        muzzleSpeedMax: 1_000_000,
        headingCone: Math.PI,
        reloadTicks: 0,
      },
    ],
    contacts: [],
    post: { host: 0, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: [],
  };
}

/** Mirrors app.ts's own (unexported) wrapScenarioAsLevel, restated per debug-api.test.ts's own
 *  convention -- observedObjects needs a full CompiledLevel, only its own `scenario`/`seed`. */
function wrapAsLevel({ scenario: s, seed }: { scenario: Scenario; seed: number }): CompiledLevel {
  return {
    schema: 1,
    id: '',
    name: '',
    brief: '',
    debrief: '',
    seed,
    names: { bodies: [], rails: [], contacts: [] },
    bodyIds: [],
    railIds: [],
    contactIds: [],
    bodyClasses: [],
    scenario: s,
  };
}

function launchCommand(tick = 0): Command {
  return { tick, kind: 'launch', rail: 0, heading: 0, speed: 50_000 };
}

describe('observedObjects', () => {
  test('reports no observation for a probe whose light has not yet reached the post', () => {
    const level = wrapAsLevel({ scenario: scenario(), seed: 1 });
    const log = [launchCommand(0)];
    const sim = createSim({ scenario: level.scenario, seed: level.seed });
    // Past uplink arrival (the probe now exists), but short of the extra one-way downlink delay
    // needed for the post to have seen it yet -- each leg is ~5 ticks at this scenario's distance.
    advance({ sim, log, ticks: 8 });
    expect(sim.objects.count).toBe(1); // sanity: materialised already
    const cache = createObservedCache();

    const { views } = observedObjects({ level, log, sim, cache });
    expect(views).toHaveLength(1);
    expect(views[0]!.observation).toBeNull();
    expect(views[0]!.predicted).toBeNull();
    expect(views[0]!.tail).toEqual([]);
  });

  test('the predicted present is bit-identical to an independent cold replay to the same tick', () => {
    const level = wrapAsLevel({ scenario: scenario(), seed: 1 });
    const log = [launchCommand(0)];
    const finalTick = 40;

    const sim = createSim({ scenario: level.scenario, seed: level.seed });
    advance({ sim, log, ticks: finalTick });
    const cache = createObservedCache();
    const { views } = observedObjects({ level, log, sim, cache });
    expect(views[0]!.observation).not.toBeNull(); // sanity: first light has reached the post by now

    // Ground truth: a completely independent sim, driven straight to the same tick, never touched
    // by observedObjects' own cache -- if the replay-based prediction were anything other than
    // "keep running the same committed log", this would disagree.
    const truth = createSim({ scenario: level.scenario, seed: level.seed });
    advance({ sim: truth, log, ticks: finalTick });

    expect(views[0]!.predicted).toEqual({
      x: truth.objects.x[0],
      y: truth.objects.y[0],
      vx: truth.objects.vx[0],
      vy: truth.objects.vy[0],
    });
  });

  test('a warm, tick-by-tick incremental resume agrees exactly with a cold single-shot call, and integrates far fewer ticks', () => {
    const level = wrapAsLevel({ scenario: scenario(), seed: 1 });
    const log = [launchCommand(0)];
    const finalTick = 40;

    // Warm path: one call per tick, the same way app.ts's own `step` drives it -- each call
    // resumes the previous one's cache rather than rebuilding from tick 0.
    const warmSim = createSim({ scenario: level.scenario, seed: level.seed });
    const warmCache = createObservedCache();
    let lastWarm: ReturnType<typeof observedObjects>['views'] = [];
    let lastTicksIntegrated = 0;
    for (let tick = 1; tick <= finalTick; tick++) {
      advance({ sim: warmSim, log, ticks: 1 });
      const result = observedObjects({ level, log, sim: warmSim, cache: warmCache });
      lastWarm = result.views;
      lastTicksIntegrated = result.ticksIntegrated;
    }

    // Cold path: a single call at the same final tick, empty cache -- must replay from tick 0.
    const coldSim = createSim({ scenario: level.scenario, seed: level.seed });
    advance({ sim: coldSim, log, ticks: finalTick });
    const coldCache = createObservedCache();
    const cold = observedObjects({ level, log, sim: coldSim, cache: coldCache });

    expect(lastWarm[0]!.observation).toEqual(cold.views[0]!.observation);
    expect(lastWarm[0]!.predicted).toEqual(cold.views[0]!.predicted);

    // The whole point of the cache (module doc's own "Cost" section): a warm call integrates a
    // handful of ticks (the delay changes by ~1 per app tick), a cold one integrates the full
    // observation tick (finalTick minus the one-way delay -- still most of finalTick).
    expect(lastTicksIntegrated).toBeLessThan(5);
    expect(cold.ticksIntegrated).toBeGreaterThan(lastTicksIntegrated * 5);
  });

  test('a committed log that grows invalidates the cache -- the next call replays cold, not stale', () => {
    const level = wrapAsLevel({ scenario: scenario(), seed: 1 });
    const log: Command[] = [launchCommand(0)];
    const sim = createSim({ scenario: level.scenario, seed: level.seed });
    const cache = createObservedCache();

    advance({ sim, log, ticks: 20 });
    const warm = observedObjects({ level, log, sim, cache });
    expect(warm.ticksIntegrated).toBeGreaterThan(0); // first call is necessarily a cold rebuild

    advance({ sim, log, ticks: 1 });
    const stillWarm = observedObjects({ level, log, sim, cache });
    expect(stillWarm.ticksIntegrated).toBeLessThan(5); // resumed, same log -- the normal case

    // A second probe's own launch command grows the log without moving sim.tick backward -- the
    // cache's own invalidation trigger (this module's doc: "the committed log grows").
    log.push(launchCommand(21));
    advance({ sim, log, ticks: 1 });
    const afterGrowth = observedObjects({ level, log, sim, cache });
    expect(afterGrowth.ticksIntegrated).toBeGreaterThan(15); // cold rebuild, not a stale resume
  });
});
