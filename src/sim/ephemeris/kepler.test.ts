// The E/sinE/cosE cross-check was moved here from kernels.test.ts (GRV-0003):
// that file could only reproduce the Danby arithmetic inline, since
// solveKepler itself belongs to this unit. This exercises the real exported
// solver (research §1.1-1.2, ADR-0005 "Kepler solver").
import { describe, expect, test } from 'vitest';
import { kepCos, kepE, kepSin, solveKepler } from './kepler.ts';

const bits = new DataView(new ArrayBuffer(8));
function hex(x: number): string {
  bits.setFloat64(0, x);
  let out = '';
  for (let i = 0; i < 8; i++) out += bits.getUint8(i).toString(16).padStart(2, '0');
  return out;
}

const TWO_PI = 6.283185307179586;

describe('solveKepler', () => {
  test('reproduces the research cross-check E/sinE/cosE for M=1, e=0.6', () => {
    solveKepler(1.0, 0.6);
    expect(hex(kepE)).toBe('3ff99891ef075f19');
    expect(hex(kepSin)).toBe('3feffc911cc33d00');
    expect(hex(kepCos)).toBe('bf9da49742ff2801');
  });

  // research §1.2 measures 8.9e-16 at e=0.8, but only at 6 discrete e values;
  // the unit's own bar is 1e-15 over a full e in [0, 0.8] x 4096-M sweep.
  // Measured here: 8.881784197001252e-16 (docs/evidence/GRV-0005/README.md)
  // -- under the 1e-15 bar with no fudging needed, so it's asserted as-is.
  test('Kepler residual |E - e sinE - M| stays within the measured bound for e in [0, 0.8]', () => {
    let worst = 0;
    for (let ei = 0; ei <= 8; ei++) {
      const e = ei / 10;
      for (let i = 0; i < 4096; i++) {
        const M = (TWO_PI * (i + 0.5)) / 4096;
        solveKepler(M, e);
        const residual = Math.abs(kepE - e * kepSin - M);
        if (residual > worst) worst = residual;
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-15);
  });
});
