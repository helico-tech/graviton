// Kepler solver: Danby starter plus exactly three Danby-Burkardt quartic
// corrections, ported from `solveKepler` in
// docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs
// (research §1.1-1.2, ADR-0005 "Kepler solver"). Three dsincos calls total:
// one per correction, sharing each pair between the residual and its
// derivative, with the final sin/cos found by a first-order rotation instead
// of a fourth trig call.

import { dcosOut, dsincos, dsinOut } from '../math/kernels.ts';

const PI = 3.141592653589793;

export let kepE = 0;
export let kepSin = 0;
export let kepCos = 0;

/** M must already be reduced to [0, 2pi). Writes kepE/kepSin/kepCos rather
 *  than allocating, matching dsincos's own mutate-in-place convention. */
export function solveKepler(M: number, e: number): void {
  let E = M + (M < PI ? 0.85 * e : -0.85 * e);
  let sE = 0;
  let cE = 0;
  let d = 0;
  for (let i = 0; i < 3; i++) {
    dsincos(E);
    sE = dsinOut;
    cE = dcosOut;
    const f0 = E - e * sE - M;
    const f1 = 1.0 - e * cE;
    const f2 = e * sE;
    const f3 = e * cE;
    const d1 = -f0 / f1;
    const d2 = -f0 / (f1 + 0.5 * d1 * f2);
    d = -f0 / (f1 + 0.5 * d2 * f2 + (d2 * d2 * f3) / 6.0);
    E = E + d;
  }
  // |d| after the third correction is <= ~5e-13 for e <= 0.9, so a
  // first-order rotation of (sE, cE) is exact to ~1e-25, far below one ulp.
  kepE = E;
  kepSin = sE + cE * d;
  kepCos = cE - sE * d;
}
