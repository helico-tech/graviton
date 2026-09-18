// Tests for the light-cone solvers and occlusion (ADR-0007 §2, §4, §5, §8; research §5; ports
// research's own p7_lightcone.py test approach -- a deliberately nastier-than-the-game truth
// model to stress the Newton convergence, plus the straight-line closed form). Math.* is fine
// here -- tests are exempt from src/sim's determinism lint (ADR-0002), and used deliberately as an
// independent oracle throughout (mirrors commands.test.ts's own convention).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { C, downlinkEmission, issueTickFor, segmentBlocked, uplinkArrival } from './lightcone.ts';
import { postPositionAtTime } from './post.ts';
import { railGeometry } from './rails.ts';
import { evaluateEphemeris } from './ephemeris/bodies.ts';
import { advance, createSim } from './sim.ts';
import type { Command, Scenario, Sim } from './sim.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';

const DT = 60;

// A fast, eccentric ("curved arc") rail host reaching out to tens of light-minutes from a post
// planted near the origin -- research §5.2's own "deliberately nastier than the game" fixture,
// ported as a real (if exaggerated) two-body Kepler system rather than a hand-rolled truth
// function, so the target position comes from the same production ephemeris every other test
// trusts and only the Newton loop itself is re-derived independently below.
const MU_STAR = 1.327e20;
const A = 4e11; // apoapsis ~7.2e11 m =~ 40 light-minutes
const E = 0.8; // MAX_ECCENTRICITY (ephemeris/bodies.ts)

function curvedArcScenario(): Scenario {
  return {
    dt: DT,
    capacity: 1,
    burnNodeCapacity: 0,
    bodies: [
      { parent: -1, mu: MU_STAR, radius: 7e8, rotationPeriod: 1e9, axialPhaseAtEpoch: 0 },
      {
        parent: 0,
        mu: 1e10,
        radius: 1e5,
        a: A,
        e: E,
        argPeriapsis: 0.4,
        meanAnomaly0: 1.1,
        rotationPeriod: 1e9,
        axialPhaseAtEpoch: 0,
      },
    ],
    rails: [
      {
        host: 1,
        longitude: 0,
        muzzleSpeedMin: 1,
        muzzleSpeedMax: 1e6,
        headingCone: Math.PI,
        reloadTicks: 0,
      },
    ],
    contacts: [],
    post: { host: 0, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 1, propellantMass: 1, exhaustVelocity: 1, thrust: 1 },
    streams: [],
  };
}

function makeEph(n: number) {
  return {
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
  };
}

/** Independent re-derivation of uplinkArrival's own Newton loop (lightcone.ts), with a
 *  caller-chosen iteration count -- production always uses exactly 3; this lets the test compare
 *  that choice against a many-iteration "ground truth" of the *same* formula (research §5.2's own
 *  approach, P7b), using the real, already-tested rail ephemeris as the target position oracle. */
function referenceUplink({
  sim,
  rail,
  issueTick,
  iterations,
}: {
  sim: Sim;
  rail: number;
  issueTick: number;
  iterations: number;
}): number {
  const dt = sim.scenario.dt;
  const te = issueTick * dt;
  const eph = makeEph(sim.bodies.count);
  const post = postPositionAtTime({ sim, t: te });
  const qx = post.x;
  const qy = post.y;

  const railAt = (t: number) => {
    evaluateEphemeris(sim.bodies, t, eph);
    return railGeometry({ bodies: sim.bodies, rails: sim.rails, rail, t, eph });
  };

  const starter = railAt(te);
  let t = te + Math.hypot(qx - starter.x, qy - starter.y) / C;
  for (let i = 0; i < iterations; i++) {
    const m = railAt(t);
    const dx = m.x - qx;
    const dy = m.y - qy;
    const d = Math.hypot(dx, dy);
    const g = d - C * (t - te);
    const gp = (dx * m.vx + dy * m.vy) / d - C;
    t = t - g / gp;
  }
  return t;
}

describe('uplinkArrival: Newton convergence (research §5.2, P7b)', () => {
  test('exactly 3 iterations matches a 12-iteration fixed point to within 1e-9 s, over a spread of issue ticks up to ~40 light-minutes range', () => {
    const sim = createSim({ scenario: curvedArcScenario(), seed: 1 });
    let checked = 0;
    let worst = 0;
    for (let k = 0; k < 3000; k++) {
      const issueTick = Math.floor(k * 251.7); // research §5.3's own irrational-ish stride
      const ref3 = referenceUplink({ sim, rail: 0, issueTick, iterations: 3 });
      const ref12 = referenceUplink({ sim, rail: 0, issueTick, iterations: 12 });
      const diff = Math.abs(ref3 - ref12);
      if (diff > worst) worst = diff;
      checked++;
    }
    expect(checked).toBe(3000);
    expect(worst).toBeLessThan(1e-9);
  });

  test("production uplinkArrival's quantised tick matches the reference solver's own 3-iteration result", () => {
    const sim = createSim({ scenario: curvedArcScenario(), seed: 1 });
    for (let k = 0; k < 500; k++) {
      const issueTick = Math.floor(k * 613.3);
      const production = uplinkArrival({ sim, target: { kind: 'rail', rail: 0 }, issueTick });
      const reference = referenceUplink({ sim, rail: 0, issueTick, iterations: 3 });
      expect(production).toBe(Math.ceil(reference / DT));
    }
  });
});

describe('uplinkArrival: straight-line case against the closed form', () => {
  // An object target moves at constant velocity from the sim's own "now" (lightcone.ts's own
  // documented ballistic model for an object target) -- a genuine straight line, so the uplink
  // equation |x0 + v*(t-tref) - q| = c*(t-te) is an exact quadratic in t, solvable directly.
  function closedFormUplink({
    x0,
    y0,
    vx,
    vy,
    tref,
    qx,
    qy,
    te,
  }: {
    x0: number;
    y0: number;
    vx: number;
    vy: number;
    tref: number;
    qx: number;
    qy: number;
    te: number;
  }): number {
    const ax = x0 - qx;
    const ay = y0 - qy;
    const s0 = te - tref; // the "s" (= t - tref) at which t = te
    const v2 = vx * vx + vy * vy;
    const A = v2 - C * C;
    const B = 2 * (ax * vx + ay * vy + C * C * s0);
    const Cc = ax * ax + ay * ay - C * C * s0 * s0;
    const disc = B * B - 4 * A * Cc;
    const sqrtDisc = Math.sqrt(disc);
    const s1 = (-B - sqrtDisc) / (2 * A);
    const s2 = (-B + sqrtDisc) / (2 * A);
    // Causality: t_a > t_e, i.e. s > s0; A < 0 always (v << c), pick whichever root satisfies it.
    const s = s1 > s0 ? s1 : s2;
    return tref + s;
  }

  test('matches uplinkArrival to within 1e-6 s across a spread of speeds, directions and ranges', () => {
    const scenario = curvedArcScenario();
    const sim = createSim({ scenario, seed: 1 });
    // Seeded directly (mirrors sim.test.ts's own "fixed contacts" seedAimedProbe convention)
    // rather than through a real launch command: this test is about the uplink solve for an
    // already-existing object, not about launch-time validation (occlusion, cone, ...).
    sim.objects.count = 1;
    sim.objects.x[0] = 5e10;
    sim.objects.y[0] = 3e10;
    sim.objects.hitBody[0] = -1;
    sim.objects.hitContact[0] = -1;

    const speeds = [1000, 50_000, 200_000, 299_000];
    const angles = [0, 0.7, Math.PI / 2, Math.PI, 4.2];
    const issueTicks = [1, 100, 10_000];

    for (const speed of speeds) {
      for (const angle of angles) {
        for (const issueTick of issueTicks) {
          sim.objects.vx[0] = speed * Math.cos(angle);
          sim.objects.vy[0] = speed * Math.sin(angle);

          const production = uplinkArrival({
            sim,
            target: { kind: 'object', object: 0 },
            issueTick,
          });

          const tref = sim.tick * DT;
          const post = postPositionAtTime({ sim, t: issueTick * DT });
          const closedFormT = closedFormUplink({
            x0: sim.objects.x[0]!,
            y0: sim.objects.y[0]!,
            vx: sim.objects.vx[0]!,
            vy: sim.objects.vy[0]!,
            tref,
            qx: post.x,
            qy: post.y,
            te: issueTick * DT,
          });

          expect(Math.abs(closedFormT - production * DT)).toBeLessThan(DT + 1e-6);
          // The production tick is ceil(t/dt); the closed-form instant itself must land within
          // one tick of it, not just be "close" on an absolute scale.
          expect(Math.ceil(closedFormT / DT)).toBe(production);
        }
      }
    }
  });
});

describe('issueTickFor: tested against uplinkArrival', () => {
  test('the returned tick always arrives at or before atTick, for a rail target', () => {
    // Not necessarily the mathematically latest possible tick -- issueTickFor also steps back
    // through an occluded instant (this module's own doc), which can leave some slack -- but it
    // must never hand back a tick whose arrival misses the deadline.
    const sim = createSim({ scenario: curvedArcScenario(), seed: 1 });
    // atTick must leave room for a real delay: at atTick 0 there is no non-negative issue tick
    // that could possibly arrive by then (delay is always > 0 for a genuinely separated target).
    for (const atTick of [500, 12_345, 500_000]) {
      const issueTick = issueTickFor({ sim, target: { kind: 'rail', rail: 0 }, atTick });
      const arrival = uplinkArrival({ sim, target: { kind: 'rail', rail: 0 }, issueTick });
      expect(arrival).toBeLessThanOrEqual(atTick);
    }
  });

  test('is exactly the latest issue tick when nothing forces it earlier (a clear, unhurried case)', () => {
    // A rail on the post's own host and longitude (zero delay, no occlusion at all -- the T00/L01
    // levels' own arrangement): issuing one tick later than issueTickFor's own answer must arrive
    // after atTick, proving tightness in the case nothing else complicates it.
    const scenario: Scenario = {
      ...curvedArcScenario(),
      rails: [
        {
          host: 0,
          longitude: 0,
          muzzleSpeedMin: 1,
          muzzleSpeedMax: 1e6,
          headingCone: Math.PI,
          reloadTicks: 0,
        },
      ],
    };
    const sim = createSim({ scenario, seed: 1 });
    for (const atTick of [500, 12_345, 500_000]) {
      const issueTick = issueTickFor({ sim, target: { kind: 'rail', rail: 0 }, atTick });
      expect(issueTick).toBe(atTick);
    }
  });

  test("a launch on the post's own host and longitude issues exactly at atTick (zero delay)", () => {
    const scenario: Scenario = {
      ...curvedArcScenario(),
      rails: [
        {
          host: 0,
          longitude: 0,
          muzzleSpeedMin: 1,
          muzzleSpeedMax: 1e6,
          headingCone: Math.PI,
          reloadTicks: 0,
        },
      ],
    };
    const sim = createSim({ scenario, seed: 1 });
    for (const atTick of [0, 1, 1000, 999_999]) {
      expect(issueTickFor({ sim, target: { kind: 'rail', rail: 0 }, atTick })).toBe(atTick);
    }
  });
});

describe('downlinkEmission', () => {
  // Post on the rail's own host and longitude (zero-delay launch, ADR-0007 §2), so the launch
  // command itself never hits occlusion/locked -- this describe block is about the downlink solve
  // over the object's recorded history, not about launch-time validation.
  function scenarioWithPostOnRail(): Scenario {
    return { ...curvedArcScenario(), post: { host: 1, longitude: 0 } };
  }

  test('round-trips against uplinkArrival: the emission that produced a given arrival is recovered', () => {
    const sim = createSim({ scenario: scenarioWithPostOnRail(), seed: 1 });
    advance({
      sim,
      log: [{ tick: 0, kind: 'launch', rail: 0, heading: 500_000_000, speed: 150_000_000 }],
      ticks: 4000,
    });

    for (const issueTick of [0, 500, 1500, 3000]) {
      const arrivalTick = uplinkArrival({ sim, target: { kind: 'object', object: 0 }, issueTick });
      if (arrivalTick > sim.tick) continue; // downlink only ever looks at the retained past
      const emissionTick = downlinkEmission({ sim, object: 0, receiveTick: arrivalTick });
      expect(emissionTick).toBeGreaterThanOrEqual(issueTick - 1);
      expect(emissionTick).toBeLessThanOrEqual(issueTick + 1);
    }
  });

  test('returns -1 before the object existed', () => {
    const sim = createSim({ scenario: scenarioWithPostOnRail(), seed: 1 });
    advance({
      sim,
      log: [{ tick: 0, kind: 'launch', rail: 0, heading: 0, speed: 100_000_000 }],
      ticks: 50,
    });
    expect(downlinkEmission({ sim, object: 0, receiveTick: -5 })).toBe(-1);
  });
});

describe('segmentBlocked (research §5.5)', () => {
  // A body at the origin, radius 1000 m, no atmosphereMargin -- placed as scenario body 0, but
  // never the post/rail target of these segments (that's body 1, far out of the way), so only the
  // body actually being tested for occlusion matters.
  function simpleScenario(): Scenario {
    return {
      dt: DT,
      capacity: 1,
      burnNodeCapacity: 0,
      bodies: [
        { parent: -1, mu: 1e14, radius: 1000, rotationPeriod: 1e9, axialPhaseAtEpoch: 0 },
        {
          parent: 0,
          mu: 1,
          radius: 1,
          a: 1e12,
          e: 0,
          argPeriapsis: 0,
          meanAnomaly0: 0,
          rotationPeriod: 1e9,
          axialPhaseAtEpoch: 0,
        },
      ],
      rails: [],
      contacts: [],
      post: { host: 1, longitude: 0 },
      historyTicks: 4,
      probe: { dryMass: 1, propellantMass: 1, exhaustVelocity: 1, thrust: 1 },
      streams: [],
    };
  }

  test('a body directly between the endpoints blocks', () => {
    const sim = createSim({ scenario: simpleScenario(), seed: 1 });
    expect(segmentBlocked({ sim, ax: -10_000, ay: 0, bx: 10_000, by: 0, tick: 0 })).toBe(true);
  });

  test('a body beside the segment (never within its radius of the line) does not block', () => {
    const sim = createSim({ scenario: simpleScenario(), seed: 1 });
    expect(segmentBlocked({ sim, ax: -10_000, ay: 5000, bx: 10_000, by: 5000, tick: 0 })).toBe(
      false,
    );
  });

  test('a body behind both endpoints (segment recedes from it) does not block', () => {
    const sim = createSim({ scenario: simpleScenario(), seed: 1 });
    // Body at the origin; both endpoints on the +x side, segment moving further +x -- the body is
    // "behind" the whole segment, never between the two points.
    expect(segmentBlocked({ sim, ax: 10_000, ay: 0, bx: 20_000, by: 0, tick: 0 })).toBe(false);
  });

  test('a segment exactly tangent to a body (touches at one point, never crosses in) counts as blocked', () => {
    const sim = createSim({ scenario: simpleScenario(), seed: 1 });
    // Segment along y = 1000 (exactly the body's own radius): the closest-approach point sits
    // exactly on the sphere -- research §5.5's own "0 <= t1 <= 1" is inclusive of that boundary.
    expect(segmentBlocked({ sim, ax: -10_000, ay: 1000, bx: 10_000, by: 1000, tick: 0 })).toBe(
      true,
    );
  });

  test('an endpoint inside the body blocks', () => {
    const sim = createSim({ scenario: simpleScenario(), seed: 1 });
    expect(segmentBlocked({ sim, ax: 0, ay: 0, bx: 10_000, by: 0, tick: 0 })).toBe(true);
    expect(segmentBlocked({ sim, ax: -10_000, ay: 0, bx: 0, by: 0, tick: 0 })).toBe(true);
  });

  test('a post exactly on its own host surface is never self-occluded by that host', () => {
    // The general case every launch/burn command hits (commands.ts): the post sits exactly on a
    // body's surface, which floating-point rounding can put a hair inside or outside that body's
    // own sphere -- must never read as blocked by the body it stands on.
    const sim = createSim({ scenario: simpleScenario(), seed: 1 });
    const post = postPositionAtTime({ sim, t: 0 });
    expect(
      segmentBlocked({ sim, ax: post.x, ay: post.y, bx: post.x + 1e9, by: post.y, tick: 0 }),
    ).toBe(false);
  });
});

interface GoldenFile {
  scenario: Scenario;
  seed: number;
  log: Command[];
  ticks: number;
}

function loadFlybyBurnGolden(): GoldenFile {
  const text = fs.readFileSync(path.join(repoRoot, 'tests', 'golden', 'flyby-burn.json'), 'utf8');
  return JSON.parse(text) as GoldenFile;
}

/** The tick, found by scanning the *real* (gravity-integrated) trajectory rather than the
 *  ballistic approximation, at which the uplink equation |x_M(t) - x_P(t_e)| = c*(t - t_e)
 *  actually holds: `g` starts positive (light hasn't had time to arrive) and falls roughly at
 *  rate `c` as `t` advances while the target recedes far slower, crossing zero once -- the first
 *  tick where it goes non-positive is the true arrival tick, `ceil`-quantised the same way
 *  `uplinkArrival` itself is. */
function trueFutureArrivalTick({
  sim,
  log,
  object,
  issueTick,
  qx,
  qy,
  maxTicksAhead,
}: {
  sim: Sim;
  log: Command[];
  object: number;
  issueTick: number;
  qx: number;
  qy: number;
  maxTicksAhead: number;
}): number {
  const dt = sim.scenario.dt;
  const te = issueTick * dt;
  for (let ahead = 0; ahead <= maxTicksAhead; ahead++) {
    const t = (issueTick + ahead) * dt;
    const dx = sim.objects.x[object]! - qx;
    const dy = sim.objects.y[object]! - qy;
    const g = Math.hypot(dx, dy) - C * (t - te);
    if (g <= 0) return issueTick + ahead;
    advance({ sim, log, ticks: 1 });
  }
  throw new Error('trueFutureArrivalTick: never converged within maxTicksAhead');
}

describe('uplinkArrival: extrapolation vs a true-future replay (flyby-burn golden)', () => {
  test('agrees with the actually-integrated trajectory to within one tick', () => {
    const golden = loadFlybyBurnGolden();

    for (const issueTick of [1, 500, 1200, 2000, 2600]) {
      // One sim solves uplinkArrival's own ballistic extrapolation, live at issueTick.
      const solving = createSim({ scenario: golden.scenario, seed: golden.seed });
      advance({ sim: solving, log: golden.log, ticks: issueTick });
      const ballisticArrival = uplinkArrival({
        sim: solving,
        target: { kind: 'object', object: 0 },
        issueTick,
      });

      // A second sim replays the *real*, gravity-integrated trajectory forward from the same
      // point to find where the light cone genuinely closes.
      const replaying = createSim({ scenario: golden.scenario, seed: golden.seed });
      advance({ sim: replaying, log: golden.log, ticks: issueTick });
      const post = postPositionAtTime({ sim: replaying, t: issueTick * golden.scenario.dt });
      const trueArrival = trueFutureArrivalTick({
        sim: replaying,
        log: golden.log,
        object: 0,
        issueTick,
        qx: post.x,
        qy: post.y,
        maxTicksAhead: 200,
      });

      expect(Math.abs(ballisticArrival - trueArrival)).toBeLessThanOrEqual(1);
    }
  });
});
