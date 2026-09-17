// Golden replay (docs/domain/simulation-determinism.md's required tests,
// docs/work/GRV-0008): a launch + mid-course burn + gas-giant flyby that
// replays to a stored hash, including with every banned Math member stubbed
// to throw (ADR-0002 guard-rail 4). Math.* is fine here -- tests are exempt
// from src/sim's determinism lint (ADR-0002); the banned-Math stubbing test
// is exactly what exercises that exemption's flip side in production code.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { computeKDyn, substepLevel } from '../../src/sim/dynamics/ladder.ts';
import { evaluateEphemeris } from '../../src/sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../../src/sim/ephemeris/bodies.ts';
import { checkGoldenVector, KERNEL_GOLDEN } from '../../src/sim/selfcheck.ts';
import { advance, createSim, hashSim } from '../../src/sim/sim.ts';
import type { Command, Scenario, Sim } from '../../src/sim/sim.ts';

// eslint.config.js has no type declarations and this repo doesn't turn on
// allowJs, so the list is replicated rather than imported -- kept in sync
// with eslint.config.js's own BANNED_MATH (ADR-0002 guard-rail 2).
const BANNED_MATH = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'hypot',
  'cbrt',
  'random',
];

interface GoldenFile {
  scenario: Scenario;
  seed: number;
  log: Command[];
  ticks: number;
  expectedHash: string;
  simVersion: number;
}

function loadGolden(name: string): GoldenFile {
  const file = path.join(import.meta.dirname, name);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GoldenFile;
}

function replay(golden: GoldenFile): string {
  const sim = createSim({ scenario: golden.scenario, seed: golden.seed });
  advance({ sim, log: golden.log, ticks: golden.ticks });
  return hashSim(sim);
}

/** Mirrors substepLevel's own inputs from live state at each tick boundary
 *  (production doesn't persist a level; research §8.3 marks it advisory,
 *  renderer-only). Used only to prove the golden really exercises the
 *  ladder, never to drive the replay itself. */
function maxSubstepLevel(golden: GoldenFile): number {
  const sim = createSim({ scenario: golden.scenario, seed: golden.seed });
  const kDyn = computeKDyn(sim.bodies, sim.scenario.dt);
  const eph: EphemerisOut = {
    x: new Float64Array(sim.bodies.count),
    y: new Float64Array(sim.bodies.count),
    vx: new Float64Array(sim.bodies.count),
    vy: new Float64Array(sim.bodies.count),
  };
  let max = 0;
  for (let t = 0; t < golden.ticks; t++) {
    advance({ sim, log: golden.log, ticks: 1 });
    for (let i = 0; i < sim.objects.count; i++) {
      if (sim.objects.hitBody[i] !== -1) continue;
      evaluateEphemeris(sim.bodies, sim.tick * sim.scenario.dt, eph);
      const level = substepLevel({
        bodies: sim.bodies,
        kDyn,
        dt: sim.scenario.dt,
        x: sim.objects.x[i]!,
        y: sim.objects.y[i]!,
        vx: sim.objects.vx[i]!,
        vy: sim.objects.vy[i]!,
        eph,
        burning: sim.objects.burning[i]!,
        mass: sim.objects.mass[i]!,
        dryMass: sim.objects.dryMass[i]!,
        thrust: sim.objects.thrust[i]!,
        exhaustVelocity: sim.objects.exhaustVelocity[i]!,
        burnTarget: sim.objects.burnTarget[i]!,
        burnDelivered: sim.objects.burnDelivered[i]!,
      });
      if (level > max) max = level;
    }
  }
  return max;
}

describe('golden replay: flyby-burn', () => {
  const golden = loadGolden('flyby-burn.json');

  test('replays to the stored hash', () => {
    expect(replay(golden)).toBe(golden.expectedHash);
  });

  test('the flyby genuinely exercises the substep ladder above level 0', () => {
    expect(maxSubstepLevel(golden)).toBeGreaterThan(0);
  });

  test('the burn node is scheduled, waits for its activation tick and completes', () => {
    const sim: Sim = createSim({ scenario: golden.scenario, seed: golden.seed });
    advance({ sim, log: golden.log, ticks: golden.ticks });
    expect(sim.objects.burning[0]).toBe(0); // armed and finished within the run
    expect(sim.objects.burnDelivered[0]).toBeGreaterThan(0);
    expect(sim.objects.hitBody[0]).toBe(-1); // the flyby never collides
  });

  test('replays to the same hash with every banned Math member stubbed to throw', () => {
    const originals = new Map<string, unknown>();
    for (const name of BANNED_MATH) {
      originals.set(name, (Math as unknown as Record<string, unknown>)[name]);
      (Math as unknown as Record<string, unknown>)[name] = () => {
        throw new Error(`Math.${name} is banned in src/sim (ADR-0002)`);
      };
    }
    try {
      // The startup self-check must run clean under the stubs too: it only
      // ever touches dsin/dcos/datan2/dexp/dlog/solveKepler, none of which
      // call a banned Math member.
      expect(() => checkGoldenVector(KERNEL_GOLDEN)).not.toThrow();
      expect(replay(golden)).toBe(golden.expectedHash);
    } finally {
      for (const [name, original] of originals) {
        (Math as unknown as Record<string, unknown>)[name] = original;
      }
    }
  });
});
