// Tests for the post's picture of a dynamic object (ADR-0007 §5-6, research §5.4). Math.* is fine
// here -- tests are exempt from src/sim's determinism lint (ADR-0002). Objects are seeded directly
// into the history ring (mirrors history.test.ts's own convention) rather than flown through a
// real launch/advance: this unit is about `observedState`'s own downlink-plus-occlusion wiring,
// not about launch-time validation or integration, and history.ts's own Hermite sampling is exact
// for constant velocity, so a straight-line object gives exactly predictable expected values.
import { describe, expect, test } from 'vitest';
import { createSim } from './sim.ts';
import type { Scenario, Sim } from './sim.ts';
import { recordHistory } from './history.ts';
import { downlinkEmission } from './lightcone.ts';
import { postPositionAtTime } from './post.ts';
import { observedState } from './telemetry.ts';

const DT = 30;

/** Primary at the origin hosting the post (longitude 0, axialPhaseAtEpoch 0 -- the post sits at
 *  exactly `(hostRadius, 0)` at every `t`, no rotation to account for), plus whatever extra bodies
 *  a test needs (e.g. an occluding one). No rails/contacts/probes: `observedState` never reads
 *  them. */
function scenario(extraBodies: Scenario['bodies'] = []): Scenario {
  return {
    dt: DT,
    capacity: 1,
    burnNodeCapacity: 0,
    bodies: [
      { parent: -1, mu: 1e18, radius: 1e5, rotationPeriod: 1e30, axialPhaseAtEpoch: 0 },
      ...extraBodies,
    ],
    rails: [],
    contacts: [],
    post: { host: 0, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 1, propellantMass: 1, exhaustVelocity: 1, thrust: 1 },
    streams: [],
  };
}

/** Records a straight-line, constant-velocity object's history for ticks `0..lastTick`
 *  (inclusive) starting at `(x0, y0)`. */
function recordStraightLine({
  sim,
  x0,
  y0,
  vx,
  vy,
  lastTick,
}: {
  sim: Sim;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  lastTick: number;
}): void {
  for (let tick = 0; tick <= lastTick; tick++) {
    recordHistory({
      history: sim.history,
      object: 0,
      tick,
      x: x0 + vx * tick * DT,
      y: y0 + vy * tick * DT,
      vx,
      vy,
    });
  }
}

describe('observedState', () => {
  test('returns null before the object has any retained history', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    expect(observedState({ sim, object: 0, atTick: 5 })).toBeNull();
  });

  test('returns null before the object’s first light has reached the post', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    // The object is 1e10 m out -- about 33 s, one tick at dt=30 -- of light delay from the post.
    // Recorded starting at tick 40, so a downlink solved for tick 40 itself has nothing earlier to
    // resolve to.
    for (let tick = 40; tick <= 90; tick++) {
      recordHistory({ history: sim.history, object: 0, tick, x: 1e10, y: 0, vx: 0, vy: 0 });
    }
    expect(observedState({ sim, object: 0, atTick: 40 })).toBeNull();
  });

  test('a stationary object’s observation matches downlinkEmission and the recorded state exactly', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    recordStraightLine({ sim, x0: 1e10, y0: 0, vx: 0, vy: 0, lastTick: 60 });

    const observed = observedState({ sim, object: 0, atTick: 50 });
    expect(observed).not.toBeNull();
    const expectedEmission = downlinkEmission({ sim, object: 0, receiveTick: 50 });
    expect(observed!.emissionTick).toBe(expectedEmission);
    expect(observed!.x).toBeCloseTo(1e10, 0);
    expect(observed!.y).toBeCloseTo(0, 6);
    expect(observed!.delaySeconds).toBeCloseTo((50 - expectedEmission) * DT, 9);
    // ~33 s of light delay rounds up to one tick at dt=30 -- never zero for an object this far out.
    expect(observed!.delaySeconds).toBeGreaterThan(0);
  });

  test('a receding object’s delay grows with range, and its observed position matches its recorded position at the emission tick', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const speed = 2_000_000; // m/s, receding along +x (unrealistically fast, but this is synthetic
    // history, not a flown trajectory -- chosen only so the range crosses enough light-seconds
    // between the two sample ticks below for the delay to visibly grow by a whole extra tick).
    recordStraightLine({ sim, x0: 1e8, y0: 0, vx: speed, vy: 0, lastTick: 200 });

    const early = observedState({ sim, object: 0, atTick: 60 })!;
    const late = observedState({ sim, object: 0, atTick: 150 })!;
    expect(late.delaySeconds).toBeGreaterThan(early.delaySeconds);

    // The observed state is exactly the recorded straight-line position at the emission tick
    // (Hermite is exact for constant velocity -- history.ts's own doc).
    expect(late.x).toBeCloseTo(1e8 + speed * late.emissionTick * DT, 3);
    expect(late.y).toBeCloseTo(0, 6);
    expect(late.vx).toBeCloseTo(speed, 6);
  });

  test('a body directly between the object and the post at the emission tick blocks the observation', () => {
    // A blocker orbiting the primary at a=5e9 m, e=0, meanAnomaly0=0 sits at exactly (5e9, 0) at
    // every t (a circular orbit's radius is constant) -- directly on the post-object line, both
    // near the +x axis (see scenario()'s own doc). Radius generous enough to swallow the
    // sub-metre offset from the post's own tiny (hostRadius, 0) surface offset.
    const blocked = (meanAnomaly0: number): Sim =>
      createSim({
        scenario: scenario([
          {
            parent: 0,
            mu: 1,
            radius: 1e8,
            a: 5e9,
            e: 0,
            argPeriapsis: 0,
            meanAnomaly0,
            rotationPeriod: 1e30,
            axialPhaseAtEpoch: 0,
          },
        ]),
        seed: 1,
      });

    const inTheWay = blocked(0);
    recordStraightLine({ sim: inTheWay, x0: 1e10, y0: 0, vx: 0, vy: 0, lastTick: 60 });
    expect(observedState({ sim: inTheWay, object: 0, atTick: 50 })).toBeNull();

    // Sanity check: the same geometry with the blocker moved well clear (a quarter-orbit away) is
    // not blocked.
    const clear = blocked(Math.PI / 2);
    recordStraightLine({ sim: clear, x0: 1e10, y0: 0, vx: 0, vy: 0, lastTick: 60 });
    expect(observedState({ sim: clear, object: 0, atTick: 50 })).not.toBeNull();
  });

  test('the post’s own position at the emission tick, not the reception tick, is what the delay is measured against', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    recordStraightLine({ sim, x0: 1e10, y0: 0, vx: 0, vy: 0, lastTick: 60 });
    const observed = observedState({ sim, object: 0, atTick: 50 })!;
    const post = postPositionAtTime({ sim, t: observed.emissionTick * DT });
    expect(post.x).toBeCloseTo(1e5, 0); // scenario()'s own host radius
  });

  // GRV-0030 acceptance's primary call shape is `atTick === sim.tick` ("what does the post see
  // right now") -- docs/issues/2026-09-18-downlink-emission-throws-at-current-tick.md, resolved.
  test('observedState at atTick equal to the object’s last recorded history tick (the "right now" call)', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    recordStraightLine({ sim, x0: 1e9, y0: 0, vx: 2_000_000, vy: 0, lastTick: 60 });
    const observed = observedState({ sim, object: 0, atTick: 60 });
    expect(observed).not.toBeNull();
    expect(observed!.emissionTick).toBeLessThan(60);
    expect(observed!.delaySeconds).toBeGreaterThan(0);
  });
});
