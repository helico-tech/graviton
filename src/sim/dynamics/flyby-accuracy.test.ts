// The unit's headline bar (ADR-0005, research §3.1): downstream miss under
// 1 km, ten days after a grazing flyby, against the ANALYTIC hyperbolic
// two-body solution -- not an approximation of it. Math.sinh/cosh/asinh are
// fine here -- tests are exempt from src/sim's determinism lint (ADR-0002).
import { describe, expect, test } from 'vitest';
import { createBodyTable } from '../ephemeris/bodies.ts';
import { createDynamicObjects, createStepScratch, stepTick } from './step.ts';

const DAY = 86400;
const DOWNSTREAM = 10 * DAY;
const R_START_MULT = 300; // periapsis radii, matching p4_integrator.py/p5_ladder.py

// Exact hyperbolic two-body propagator, ported from `hyper_state`/`t_at_r`
// in docs/research/2026-09-03-02-simulation-numerics-probes/p4_integrator.py
// (research §3.2): the reference is closed-form, so the measured miss is
// purely the integrator and ladder's error, with no reference-integrator
// error mixed in. Newton to convergence is fine here (unlike inside the
// simulation, which is bounded iteration by contract) because this is test
// fixture code computing a reference value, not part of the sim itself.
function hyperState(mu: number, rp: number, vinf: number, t: number) {
  const aa = mu / (vinf * vinf); // |a|
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
  return { x, y, vx: -k * sh, vy: k * Math.sqrt(e * e - 1) * ch, r, e };
}

function tAtR(mu: number, rp: number, vinf: number, r: number): number {
  const aa = mu / (vinf * vinf);
  const e = 1 + rp / aa;
  const H = Math.acosh((r / aa + 1) / e);
  return (e * Math.sinh(H) - H) / Math.sqrt(mu / (aa * aa * aa));
}

interface FlybyResult {
  missMeters: number;
  nTicks: number;
}

/** Grazing flyby (periapsis = 1.05 body radii): starts far enough out that
 *  the ladder is at level 0 (research §4.5 measures this at 300 periapsis
 *  radii), runs through periapsis and DOWNSTREAM further days, then
 *  compares the simulated state to the analytic hyperbola at the exact same
 *  elapsed time -- an actual re-integration of the downstream coast, not
 *  the linear dv*t estimate p5_ladder.py uses to keep its sweep cheap. */
function runFlyby({
  mu,
  radius,
  vinf,
  dt,
}: {
  mu: number;
  radius: number;
  vinf: number;
  dt: number;
}): FlybyResult {
  const rp = 1.05 * radius;
  const rStart = R_START_MULT * rp;
  const t0 = -tAtR(mu, rp, vinf, rStart);
  const tEnd = -t0 + DOWNSTREAM;
  const nTicks = Math.round((tEnd - t0) / dt);

  const bodies = createBodyTable([
    { parent: -1, mu, radius, rotationPeriod: 86400, axialPhaseAtEpoch: 0 },
  ]);
  const objects = createDynamicObjects(1);
  objects.count = 1;
  const init = hyperState(mu, rp, vinf, t0);
  objects.x[0] = init.x;
  objects.y[0] = init.y;
  objects.vx[0] = init.vx;
  objects.vy[0] = init.vy;
  objects.hitBody[0] = -1;
  const scratch = createStepScratch({ bodies, dt, capacity: 1 });

  for (let tick = 0; tick < nTicks; tick++) {
    stepTick({ bodies, objects, tick, dt, scratch });
  }
  expect(objects.hitBody[0]).toBe(-1); // a 1.05-radius grazing pass must never register a hit

  const physicalEnd = t0 + nTicks * dt;
  const ref = hyperState(mu, rp, vinf, physicalEnd);
  const dx = objects.x[0]! - ref.x;
  const dy = objects.y[0]! - ref.y;
  return { missMeters: Math.sqrt(dx * dx + dy * dy), nTicks };
}

const JUPITER = { name: 'Jupiter-class', mu: 1.26687e17, radius: 7.1492e7 };
const EARTH = { name: 'Earth-class', mu: 3.986e14, radius: 6.371e6 };
const SPEEDS = [100e3, 200e3, 300e3];

describe('flyby accuracy: downstream miss vs. the analytic hyperbola', () => {
  for (const body of [JUPITER, EARTH]) {
    for (const vinf of SPEEDS) {
      test(`${body.name} at ${vinf / 1e3} km/s, dt=60s: miss after 10 days < 1 km`, () => {
        const { missMeters, nTicks } = runFlyby({ mu: body.mu, radius: body.radius, vinf, dt: 60 });
        // no-console allows 'info'; this is how docs/evidence/GRV-0006/README.md's
        // measured-miss table is captured, straight from `pnpm test` output.
        console.info(
          `${body.name} v_inf=${vinf / 1e3}km/s dt=60s nTicks=${nTicks} miss=${missMeters.toFixed(3)}m`,
        );
        expect(missMeters).toBeLessThan(1000);
      });
    }
  }
});

// research §4.7 (`p5_ladder.py` P5c) measured dt=120s failing a grazing pass
// (Jupiter 100 km/s: 1.02 km; Earth 300 km/s: 2.12 km), reproduced cheaply
// here to check whether that still holds for this unit's actual shipped
// constants. It doesn't: §4.7's sweep used zeta=1/16, one step looser than
// ADR-0005's recommended zeta=1/32 (research §4.6), and that extra margin
// (measured there at ~15x headroom at dt=60) turns out to cover dt=120 too
// for every grazing case tested. Asserting a forced failure here would be
// asserting something false, so this documents the actual measurement
// instead (docs/issues/2026-09-17-dt120-clears-bar-at-zeta-1-32.md).
describe('flyby accuracy: dt=120s at the grazing cases research §4.7 measured as a failure', () => {
  test.each([
    { body: JUPITER, vinf: 100e3, vinfKm: 100 },
    { body: EARTH, vinf: 300e3, vinfKm: 300 },
  ])(
    '$body.name at $vinfKm km/s, dt=120s: zeta=1/32 clears the bar research §4.7 (zeta=1/16) missed',
    ({ body, vinf }) => {
      const { missMeters, nTicks } = runFlyby({ mu: body.mu, radius: body.radius, vinf, dt: 120 });
      console.info(
        `${body.name} v_inf=${vinf / 1e3}km/s dt=120s nTicks=${nTicks} miss=${missMeters.toFixed(3)}m`,
      );
      expect(missMeters).toBeLessThan(1000);
    },
  );
});
