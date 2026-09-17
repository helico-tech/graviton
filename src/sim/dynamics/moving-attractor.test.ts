// A probe grazing a moon that itself orbits a primary (research §4.8,
// `p6_ladder_robust.py` P6b): the static single-attractor test in
// flyby-accuracy.test.ts can't see the field's time dependence, since
// during a ~2000 s encounter a Jupiter-class body on a 1 AU orbit moves
// ~26 000 km, about a third of a planetary radius. Math.* is fine here --
// tests are exempt from src/sim's determinism lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import { createBodyTable, evaluateEphemeris } from '../ephemeris/bodies.ts';
import type { EphemerisOut } from '../ephemeris/bodies.ts';
import { createContactState, createContactTable } from '../contacts.ts';
import { createHash, digest, updateFloat64 } from '../state/hash.ts';
import { createDynamicObjects, createStepScratch, stepTick } from './step.ts';
import type { DynamicObjects } from './step.ts';

// GRV-0015: this file predates fixed contacts and stays contact-free; the
// empty table needs no bodies of its own to validate against.
const NO_CONTACTS = createContactTable(
  [],
  createBodyTable([{ parent: -1, mu: 1, radius: 1, rotationPeriod: 1, axialPhaseAtEpoch: 0 }]),
);
const NO_CONTACT_STATE = createContactState(0);

const MU_SUN = 1.32712440018e20;
const MU_JUPITER = 1.26687e17;
const R_JUPITER = 7.1492e7;
const AU = 1.495978707e11;
const DT = 60;
const VINF = 2e5;
const RP = 1.05 * R_JUPITER; // grazing, same margin as every other flyby test in this unit
const R_START = 200 * RP;

// Exact hyperbolic two-body propagator, ported from `hyper_state`/`t_at_r`
// in docs/research/2026-09-03-02-simulation-numerics-probes/p4_integrator.py
// (research §3.2). Used to build the probe's initial state relative to the
// moon, as if the moon were momentarily stationary.
function hyperState(mu: number, rp: number, vinf: number, t: number) {
  const aa = mu / (vinf * vinf);
  const e = 1 + rp / aa;
  const n = Math.sqrt(mu / (aa * aa * aa));
  const M = n * t;
  let H =
    Math.abs(M) < 1e3 ? Math.asinh(M / e) : Math.sign(M) * Math.log((2 * Math.abs(M)) / e + 1.8);
  for (let i = 0; i < 200; i++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    const d = -f / fp;
    H += d;
    if (Math.abs(d) < 1e-16 * Math.max(1, Math.abs(H))) break;
  }
  const ch = Math.cosh(H);
  const sh = Math.sinh(H);
  const r = aa * (e * ch - 1);
  const x = aa * (e - ch);
  const y = aa * Math.sqrt(e * e - 1) * sh;
  const k = Math.sqrt(mu * aa) / r;
  return { x, y, vx: -k * sh, vy: k * Math.sqrt(e * e - 1) * ch };
}

function tAtR(mu: number, rp: number, vinf: number, r: number): number {
  const aa = mu / (vinf * vinf);
  const e = 1 + rp / aa;
  const H = Math.acosh((r / aa + 1) / e);
  return (e * Math.sinh(H) - H) / Math.sqrt(mu / (aa * aa * aa));
}

interface RunResult {
  objects: DynamicObjects;
  tickEnd: number;
  ephEnd: EphemerisOut;
}

/** Probe on a hyperbola relative to a Jupiter-class moon (rp = 1.05 moon
 *  radii, v_inf = 200 km/s), the moon on a circular 1 AU orbit around a
 *  solar-mass primary -- research §4.8's scenario, dt=60s and zeta=1/32
 *  matching this unit's actual shipped constants (not §4.8's own zeta=1/64
 *  reference run, which exists only to validate a target, not to be ported).
 *
 *  Deviation from `run_moving` in p6_ladder_robust.py: that reference offsets
 *  the relative hyperbola by the moon's position at t=0, regardless of t0.
 *  Ported faithfully, that put the probe ~17 million km from where the moon
 *  actually is at the start of a ~21-hour inbound leg (t0 ~ -75 000 s here),
 *  a mismatch invisible to research §4.8's own comparison (it only measures
 *  two numerical methods against each other on whatever trajectory that
 *  produces) but fatal to a "graze at 1.05 radii" scenario: periapsis landed
 *  as low as 0.98 R regardless of the nominal rp, a genuine hit. Anchoring
 *  the offset at t0 instead -- physically, "the probe starts far enough out
 *  that the moon is effectively stationary over the light-transit of that
 *  distance" -- reproduces the intended periapsis to within 5% and never
 *  hits, while keeping the field's real time dependence during the close
 *  encounter itself. */
function run(): RunResult {
  const bodies = createBodyTable([
    { parent: -1, mu: MU_SUN, radius: 6.957e8, rotationPeriod: 2.2e6, axialPhaseAtEpoch: 0 },
    {
      parent: 0,
      mu: MU_JUPITER,
      radius: R_JUPITER,
      a: AU,
      e: 0,
      argPeriapsis: 0,
      meanAnomaly0: 0,
      rotationPeriod: 35730,
      axialPhaseAtEpoch: 0,
    },
  ]);
  const t0 = -tAtR(MU_JUPITER, RP, VINF, R_START);
  const rel = hyperState(MU_JUPITER, RP, VINF, t0);
  const tick0 = Math.round(t0 / DT);

  const ephAtT0: EphemerisOut = {
    x: new Float64Array(2),
    y: new Float64Array(2),
    vx: new Float64Array(2),
    vy: new Float64Array(2),
  };
  evaluateEphemeris(bodies, tick0 * DT, ephAtT0);

  const objects = createDynamicObjects(1);
  objects.count = 1;
  objects.x[0] = ephAtT0.x[1]! + rel.x;
  objects.y[0] = ephAtT0.y[1]! + rel.y;
  objects.vx[0] = ephAtT0.vx[1]! + rel.vx;
  objects.vy[0] = ephAtT0.vy[1]! + rel.vy;
  objects.hitBody[0] = -1;

  const tickEnd = -tick0;
  const scratch = createStepScratch({ bodies, contacts: NO_CONTACTS, dt: DT, capacity: 1 });
  for (let tick = tick0; tick < tickEnd; tick++) {
    stepTick({
      bodies,
      objects,
      contacts: NO_CONTACTS,
      contactState: NO_CONTACT_STATE,
      tick,
      dt: DT,
      scratch,
    });
  }

  const ephEnd: EphemerisOut = {
    x: new Float64Array(2),
    y: new Float64Array(2),
    vx: new Float64Array(2),
    vy: new Float64Array(2),
  };
  evaluateEphemeris(bodies, tickEnd * DT, ephEnd);

  return { objects, tickEnd, ephEnd };
}

/** Specific orbital energy relative to the moon's instantaneous frame. */
function relativeEnergy(objects: DynamicObjects, eph: EphemerisOut): number {
  const dx = objects.x[0]! - eph.x[1]!;
  const dy = objects.y[0]! - eph.y[1]!;
  const dvx = objects.vx[0]! - eph.vx[1]!;
  const dvy = objects.vy[0]! - eph.vy[1]!;
  const r = Math.sqrt(dx * dx + dy * dy);
  return 0.5 * (dvx * dvx + dvy * dvy) - MU_JUPITER / r;
}

describe('probe flying past a moon that orbits a primary', () => {
  test("energy relative to the moon's frame stays finite and close to its incoming value", () => {
    const { objects, ephEnd } = run();
    const rel0 = hyperState(MU_JUPITER, RP, VINF, -tAtR(MU_JUPITER, RP, VINF, R_START));
    const eStart =
      0.5 * (rel0.vx * rel0.vx + rel0.vy * rel0.vy) - MU_JUPITER / Math.hypot(rel0.x, rel0.y);
    const eEnd = relativeEnergy(objects, ephEnd);
    expect(Number.isFinite(eEnd)).toBe(true);
    // The moon-frame energy isn't exactly conserved here -- the sun
    // perturbs both the probe and the moon -- but it must stay close to
    // the incoming value, not blow up. Measured 2.15e-7 relative change
    // (docs/evidence/GRV-0006/README.md); asserted with a ~500x margin.
    expect(Math.abs(eEnd / eStart - 1)).toBeLessThan(1e-4);
    expect(objects.hitBody[0]).toBe(-1);
  });

  test('is bit-reproducible: two independent runs hash identically', () => {
    const a = run();
    const b = run();
    const hashState = (objects: DynamicObjects): string => {
      const h = createHash();
      updateFloat64(h, objects.x[0]!);
      updateFloat64(h, objects.y[0]!);
      updateFloat64(h, objects.vx[0]!);
      updateFloat64(h, objects.vy[0]!);
      return digest(h);
    };
    expect(hashState(a.objects)).toBe(hashState(b.objects));
    expect(a.objects.hitBody[0]).toBe(-1);
  });
});
