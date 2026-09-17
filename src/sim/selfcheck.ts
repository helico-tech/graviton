// Startup self-check (ADR-0005 "Startup self-check", research §8.4): the
// whole determinism strategy rests on `+ - * / sqrt floor` being identical
// everywhere, so prove the kernels and the Kepler solver still hash to a
// known constant instead of assuming it.

import { datan2, dcos, dexp, dlog, dsin } from './math/kernels.ts';
import { kepCos, kepE, kepSin, solveKepler } from './ephemeris/kepler.ts';
import { createHash, digest, updateFloat64 } from './state/hash.ts';

const VECTOR_SIZE = 256;
const TWO_PI = 6.283185307179586;
const MAX_ECCENTRICITY = 0.8; // ADR-0005 "Kepler solver"
const TRIG_DOMAIN = 200000; // well inside dsin/dcos's +-2^18 contract
const ATAN2_DOMAIN = 1e6;
const EXP_DOMAIN = 40; // dexp(40) ~= 2.35e17, nowhere near overflow
const LOG_DOMAIN = 1e6;
const LOG_MIN = 1e-6; // keeps the argument strictly positive

// (sqrt(5)-1)/2: an irrational step gives 256 well-spread samples in [0, 1)
// from a plain arithmetic recurrence -- no rng needed, so the vector is
// itself part of the deterministic core.
const GOLDEN_STEP = 0.6180339887498949;

function fraction(i: number): number {
  const v = i * GOLDEN_STEP;
  return v - Math.floor(v);
}

/** 256 fixed inputs run through dsin/dcos/datan2/dexp/dlog/solveKepler,
 *  hashed together. Every input is derived arithmetically from its index
 *  alone (research §8.4), so this function is itself deterministic and
 *  needs no stored fixture. */
export function kernelGoldenVector(): string {
  const state = createHash();
  for (let i = 0; i < VECTOR_SIZE; i++) {
    const xTrig = (fraction(i) - 0.5) * 2 * TRIG_DOMAIN;
    updateFloat64(state, dsin(xTrig));
    updateFloat64(state, dcos(xTrig));

    const y = (fraction(i * 7 + 3) - 0.5) * 2 * ATAN2_DOMAIN;
    const x = (fraction(i * 11 + 17) - 0.5) * 2 * ATAN2_DOMAIN;
    updateFloat64(state, datan2(y, x));

    const expArg = (fraction(i * 13 + 5) - 0.5) * 2 * EXP_DOMAIN;
    updateFloat64(state, dexp(expArg));

    const logArg = fraction(i * 17 + 9) * LOG_DOMAIN + LOG_MIN;
    updateFloat64(state, dlog(logArg));

    const M = fraction(i * 19 + 23) * TWO_PI;
    const e = fraction(i * 23 + 29) * MAX_ECCENTRICITY;
    solveKepler(M, e);
    updateFloat64(state, kepE);
    updateFloat64(state, kepSin);
    updateFloat64(state, kepCos);
  }
  return digest(state);
}

// Measured once from kernelGoldenVector() itself and pinned here; see
// docs/evidence/GRV-0008/README.md for how it was produced.
export const KERNEL_GOLDEN = '1886969eed8c08d6';

/** The comparison itself, exposed so a wrong `expected` is testable without
 *  monkeypatching any kernel. */
export function checkGoldenVector(expected: string): void {
  const actual = kernelGoldenVector();
  if (actual !== expected) {
    throw new Error(`kernel golden vector mismatch: expected ${expected}, got ${actual}`);
  }
}

let checked = false;

/** Runs the comparison once per process (module-level memo); createSim calls
 *  this unconditionally and relies on the memo to make repeated calls free. */
export function selfCheck(): void {
  if (checked) return;
  checkGoldenVector(KERNEL_GOLDEN);
  checked = true;
}
