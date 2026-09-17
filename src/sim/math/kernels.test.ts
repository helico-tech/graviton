// The 18 exact-match values are the research §2.6 cross-check: the same
// algorithm run independently in CPython 3.12 and Node 24 produced identical
// bit patterns, reproduced directly from
// docs/research/2026-09-03-02-simulation-numerics-probes/q3_crosscheck.py
// (see docs/evidence/GRV-0003/README.md for how they and the <=2ulp grid
// below were generated). Math.* is only ever used here as a loose sanity
// bound or to build test inputs -- never as a source of truth, since it is
// exactly what this file exists to not depend on.
import { describe, expect, test } from 'vitest';
import {
  dacos,
  datan,
  datan2,
  dcos,
  dcosOut,
  dexp,
  dlog,
  dsin,
  dsincos,
  dsinOut,
} from './kernels.ts';

const bits = new DataView(new ArrayBuffer(8));

function hex(x: number): string {
  bits.setFloat64(0, x);
  let out = '';
  for (let i = 0; i < 8; i++) out += bits.getUint8(i).toString(16).padStart(2, '0');
  return out;
}

function fromHex(h: string): number {
  for (let i = 0; i < 8; i++) bits.setUint8(i, parseInt(h.slice(i * 2, i * 2 + 2), 16));
  return bits.getFloat64(0);
}

// Bruce Dawson's ULPs-between-doubles trick: map IEEE-754 bits to a
// monotonic unsigned ordering, then subtract. Used only to grade the ported
// kernels against a correctly-rounded reference -- never inside kernels.ts.
function orderedBits(x: number): bigint {
  bits.setFloat64(0, x);
  const raw = bits.getBigUint64(0);
  return raw >> 63n ? ~raw & 0xffffffffffffffffn : raw | (1n << 63n);
}
function ulpDistance(a: number, b: number): number {
  const d = orderedBits(a) - orderedBits(b);
  return Number(d < 0n ? -d : d);
}

function expectHex(actual: number, expectedHex: string): void {
  expect(hex(actual)).toBe(expectedHex);
}
function expectWithinUlp(actual: number, expectedHex: string, maxUlp: number): void {
  expect(ulpDistance(actual, fromHex(expectedHex))).toBeLessThanOrEqual(maxUlp);
}

describe('range guard (research §2.2, GRV-0003 acceptance)', () => {
  const LIMIT = 262144; // 2^18

  test('dsin/dcos/dsincos accept the boundary |x| = 2^18', () => {
    expect(() => dsin(LIMIT)).not.toThrow();
    expect(() => dcos(LIMIT)).not.toThrow();
    expect(() => dsincos(LIMIT)).not.toThrow();
    expect(() => dsin(-LIMIT)).not.toThrow();
    expect(() => dcos(-LIMIT)).not.toThrow();
    expect(() => dsincos(-LIMIT)).not.toThrow();
  });

  test('dsin/dcos/dsincos throw RangeError just past |x| = 2^18', () => {
    expect(() => dsin(LIMIT + 1)).toThrow(RangeError);
    expect(() => dcos(LIMIT + 1)).toThrow(RangeError);
    expect(() => dsincos(LIMIT + 1)).toThrow(RangeError);
    expect(() => dsin(-LIMIT - 1)).toThrow(RangeError);
    expect(() => dcos(-LIMIT - 1)).toThrow(RangeError);
    expect(() => dsincos(-LIMIT - 1)).toThrow(RangeError);
  });
});

describe('cross-runtime golden bit patterns (research §2.6)', () => {
  const SIX_X = [0.1, 1, 3, 100, 10000, 123456.789];
  const SIN_HEX = [
    '3fb98eaecb8bcb2c',
    '3feaed548f090cee',
    '3fc210386db6d55b',
    'bfe03425b78c4db8',
    'bfd38f2fa75d9289',
    'bfeff50e60ab53f9',
  ];
  const COS_HEX = [
    '3fefd712f9a817c0',
    '3fe14a280fb5068c',
    'bfefae04be85e5d2',
    '3feb981dbf665fe0',
    'bfee780e88ec4409',
    '3faa74d27c41b22a',
  ];

  test('dsin/dcos match the 12 trig cross-check values exactly', () => {
    SIX_X.forEach((x, i) => {
      expectHex(dsin(x), SIN_HEX[i]!);
      expectHex(dcos(x), COS_HEX[i]!);
    });
  });

  test('dexp/dlog/datan2 match the remaining cross-check values exactly', () => {
    expectHex(dexp(2.5), '40285d6fd931e0bb');
    expectHex(dlog(7.5), '40001e85798eb9a3');
    expectHex(datan2(3, -4), '4003fc176b7a8560');
  });

  test('Danby-Kepler built from dsincos matches the cross-check E/sinE/cosE', () => {
    // solveKepler itself belongs to GRV-0005 (ephemeris), not this unit; this
    // reproduces just enough of ADR-0005's Kepler recipe, driven by our own
    // dsincos, to prove dsincos feeds a real downstream computation
    // bit-for-bit -- the actual claim research §2.6 makes for these 3 values.
    const M = 1.0;
    const e = 0.6;
    let E = M + (M < Math.PI ? 0.85 * e : -0.85 * e);
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
    expectHex(E, '3ff99891ef075f19');
    expectHex(sE + cE * d, '3feffc911cc33d00');
    expectHex(cE - sE * d, 'bf9da49742ff2801');
  });
});

// Correctly-rounded doubles from a 70-digit decimal.Decimal reference
// (docs/evidence/GRV-0003/README.md), asserted to <=2 ulp per GRV-0003's
// acceptance bar (research measured <=1.3 ulp).
const SIN_GRID: Array<{ x: number; hex: string }> = [
  { x: 0.0001, hex: '3f1a36e2ea609cc8' },
  { x: 0.5, hex: '3fdeaee8744b05f0' },
  { x: 0.7853981633974483, hex: '3fe6a09e667f3bcc' },
  { x: 1.0471975511965976, hex: '3febb67ae8584caa' },
  { x: 1.5707963267948966, hex: '3ff0000000000000' },
  { x: 2.0, hex: '3fed18f6ead1b446' },
  { x: 3.1, hex: '3fa54a0f8298102e' },
  { x: 3.141592653589793, hex: '3ca1a62633145c07' },
  { x: 4.71238898038469, hex: 'bff0000000000000' },
  { x: 6.283185307179586, hex: 'bcb1a62633145c07' },
  { x: 10.0, hex: 'bfe1689ef5f34f52' },
  { x: 50.0, hex: 'bfd0cabfe5fcdfc8' },
  { x: 200.0, hex: 'bfebf20d2c67047f' },
  { x: 1000.0, hex: '3fea75cc150a206b' },
  { x: 10000.0, hex: 'bfd38f2fa75d9289' },
  { x: 100000.0, hex: '3fa24daa9c527e96' },
  { x: 262144.0, hex: 'bfb58809c5ce39b6' },
  { x: -1.5, hex: 'bfefeb7a9b2c6d8b' },
  { x: -1000.0, hex: 'bfea75cc150a206b' },
  { x: -262144.0, hex: '3fb58809c5ce39b6' },
  { x: 123.456, hex: 'bfe9b9dadc41aeb6' },
];
const COS_GRID: Array<{ x: number; hex: string }> = [
  { x: 0.0001, hex: '3feffffffd50ce24' },
  { x: 0.5, hex: '3fec1528065b7d50' },
  { x: 0.7853981633974483, hex: '3fe6a09e667f3bcd' },
  { x: 1.0471975511965976, hex: '3fe0000000000001' },
  { x: 1.5707963267948966, hex: '3c91a62633145c07' },
  { x: 2.0, hex: 'bfdaa22657537205' },
  { x: 3.1, hex: 'bfeff8ea4756a624' },
  { x: 3.141592653589793, hex: 'bff0000000000000' },
  { x: 4.71238898038469, hex: 'bcaa79394c9e8a0a' },
  { x: 6.283185307179586, hex: '3ff0000000000000' },
  { x: 10.0, hex: 'bfead9ac890c6b1f' },
  { x: 50.0, hex: '3feee1006fc3fcfa' },
  { x: 200.0, hex: '3fdf2e1536cad6e9' },
  { x: 1000.0, hex: '3fe1ff026793f1bb' },
  { x: 10000.0, hex: 'bfee780e88ec4409' },
  { x: 100000.0, hex: 'bfeffac3841b3da7' },
  { x: 262144.0, hex: 'bfefe2f9378c3909' },
  { x: -1.5, hex: '3fb21bd54fc5f9a7' },
  { x: -1000.0, hex: '3fe1ff026793f1bb' },
  { x: -262144.0, hex: 'bfefe2f9378c3909' },
  { x: 123.456, hex: 'bfe307e5980a1558' },
];
const ATAN_GRID: Array<{ x: number; hex: string }> = [
  { x: 0.0, hex: '0000000000000000' },
  { x: 0.2, hex: '3fc94441f8f7260c' },
  { x: 0.5, hex: '3fddac670561bb4f' },
  { x: 0.9, hex: '3fe77338a80603be' },
  { x: 1.5, hex: '3fef730bd281f69b' },
  { x: 5.0, hex: '3ff5f97315254857' },
  { x: -0.2, hex: 'bfc94441f8f7260c' },
  { x: -0.5, hex: 'bfddac670561bb4f' },
  { x: -0.9, hex: 'bfe77338a80603be' },
  { x: -1.5, hex: 'bfef730bd281f69b' },
  { x: -5.0, hex: 'bff5f97315254857' },
  { x: 1000.0, hex: '3ff91de2c0e658bd' },
];
const ACOS_GRID: Array<{ x: number; hex: string }> = [
  { x: 0.0, hex: '3ff921fb54442d18' },
  { x: 0.5, hex: '3ff0c152382d7366' },
  { x: -0.5, hex: '4000c152382d7366' },
  { x: 0.999, hex: '3fa6e634e566a29e' },
  { x: -0.999, hex: '4008c66280ae928e' },
  { x: 0.999999, hex: '3f572ba46065af16' },
  { x: -1.0, hex: '400921fb54442d18' },
  { x: 1.0, hex: '0000000000000000' },
];
const ATAN2_GRID: Array<{ y: number; x: number; hex: string }> = [
  { y: 1.0, x: 1.0, hex: '3fe921fb54442d18' },
  { y: 1.0, x: -1.0, hex: '4002d97c7f3321d2' },
  { y: -1.0, x: -1.0, hex: 'c002d97c7f3321d2' },
  { y: -1.0, x: 1.0, hex: 'bfe921fb54442d18' },
  { y: 3.0, x: 4.0, hex: '3fe4978fa3269ee1' },
  { y: -3.0, x: 4.0, hex: 'bfe4978fa3269ee1' },
  { y: 0.0, x: 5.0, hex: '0000000000000000' },
  { y: 0.0, x: -5.0, hex: '400921fb54442d18' },
  { y: 5.0, x: 0.0, hex: '3ff921fb54442d18' },
  { y: -5.0, x: 0.0, hex: 'bff921fb54442d18' },
];
const EXP_GRID: Array<{ x: number; hex: string }> = [
  { x: -8.0, hex: '3f35fc21041027ad' },
  { x: -7.999, hex: '3f3601c2899b70b0' },
  { x: -5.5, hex: '3f70bd4a5aca7728' },
  { x: -1.0, hex: '3fd78b56362cef38' },
  { x: -0.0001, hex: '3fefff2e4b97d31d' },
  { x: 0.0001, hex: '3ff00068dce3484e' },
  { x: 1.0, hex: '4005bf0a8b145769' },
  { x: 3.5, hex: '40408ec721396bdb' },
  { x: 7.999, hex: '40a743f500727ca9' },
  { x: 8.0, hex: '40a749ea7d470c6e' },
];
const LOG_GRID: Array<{ x: number; hex: string }> = [
  { x: 2e-9, hex: 'c03407b5db342de9' },
  { x: 1e-6, hex: 'c02ba18a998fffa0' },
  { x: 0.001, hex: 'c01ba18a998fffa0' },
  { x: 0.5, hex: 'bfe62e42fefa39ef' },
  { x: 1.0000001, hex: '3e7ad7f2847b6492' },
  { x: 1.5, hex: '3fd9f323ecbf984c' },
  { x: 7.5, hex: '40001e85798eb9a3' },
  { x: 30.0, hex: '400b35a6f90bd69b' },
  { x: 1000.0, hex: '401ba18a998fffa0' },
  { x: 500000000.0, hex: '403407b5db342de9' },
];

describe('accuracy: <=2 ulp from a correctly-rounded decimal reference', () => {
  test('dsin/dcos', () => {
    for (const { x, hex: h } of SIN_GRID) expectWithinUlp(dsin(x), h, 2);
    for (const { x, hex: h } of COS_GRID) expectWithinUlp(dcos(x), h, 2);
  });
  test('datan', () => {
    for (const { x, hex: h } of ATAN_GRID) expectWithinUlp(datan(x), h, 2);
  });
  test('dacos, including near |x| = 1 where precision is easiest to lose', () => {
    for (const { x, hex: h } of ACOS_GRID) expectWithinUlp(dacos(x), h, 2);
  });
  test('datan2', () => {
    for (const { y, x, hex: h } of ATAN2_GRID) expectWithinUlp(datan2(y, x), h, 2);
  });
  test('dexp', () => {
    for (const { x, hex: h } of EXP_GRID) expectWithinUlp(dexp(x), h, 2);
  });
  test('dlog', () => {
    for (const { x, hex: h } of LOG_GRID) expectWithinUlp(dlog(x), h, 2);
  });
});

describe('special values', () => {
  test('dsin/dcos at zero', () => {
    expect(Object.is(dsin(0), 0)).toBe(true);
    expect(Object.is(dcos(0), 1)).toBe(true);
    // The ported kernel does not preserve the sign of an exact -0 argument
    // (dsin(-0) rounds to +0, unlike Math.sin): verified identical in both
    // the Python and Node reference, see docs/evidence/GRV-0003/README.md.
    // Harmless here -- the state hash already canonicalises -0 to +0.
    expect(Object.is(dsin(-0), 0)).toBe(true);
    expect(Object.is(dcos(-0), 1)).toBe(true);
  });

  test('dsin/dcos at exact multiples of pi/2 (as the double Math.PI represents it)', () => {
    expectWithinUlp(dsin(Math.PI / 2), '3ff0000000000000', 2); // 1
    expectWithinUlp(dcos(Math.PI / 2), '3c91a62633145c07', 2); // ~0
    expectWithinUlp(dsin(Math.PI), '3ca1a62633145c07', 2); // ~0
    expectWithinUlp(dcos(Math.PI), 'bff0000000000000', 2); // -1
    expectWithinUlp(dsin((Math.PI * 3) / 2), 'bff0000000000000', 2); // -1
    expectWithinUlp(dsin(Math.PI * 2), 'bcb1a62633145c07', 2); // ~0
    expectWithinUlp(dcos(Math.PI * 2), '3ff0000000000000', 2); // 1
  });

  test('datan2 quadrants and axes', () => {
    expect(datan2(1, 1)).toBeCloseTo(Math.PI / 4, 15);
    expect(datan2(1, -1)).toBeCloseTo((3 * Math.PI) / 4, 15);
    expect(datan2(-1, -1)).toBeCloseTo((-3 * Math.PI) / 4, 15);
    expect(datan2(-1, 1)).toBeCloseTo(-Math.PI / 4, 15);
    expect(Object.is(datan2(0, 5), 0)).toBe(true);
    expect(datan2(0, -5)).toBe(Math.PI);
    expect(datan2(5, 0)).toBe(Math.PI / 2);
    expect(datan2(-5, 0)).toBe(-Math.PI / 2);
    expect(Object.is(datan2(0, 0), 0)).toBe(true);
    // Zero's sign in y is not special-cased (research §2.5: directions are
    // unit vectors inside the sim, so a signed-zero y never carries meaning).
    expect(Object.is(datan2(-0, 5), 0)).toBe(true);
  });

  test('dacos at +-1', () => {
    expect(Object.is(dacos(1), 0)).toBe(true);
    expect(dacos(-1)).toBe(Math.PI);
  });

  test('dexp/dlog round-trip away from the near-1 region where log loses precision', () => {
    // log(1+eps) subtracts two nearby doubles (fdlibm's f = m - 1), so
    // round-tripping through a point that lands log's argument close to 1
    // amplifies floating-point cancellation, not a kernel bug -- the
    // reference vs Math.log agreement above already measures dlog itself.
    for (const x of [-5, -1, 1, 3.5, 7.999, -7.999]) {
      expect(Math.abs(dlog(dexp(x)) - x)).toBeLessThan(1e-13);
    }
    for (const x of [0.5, 1, 7.5, 1000, 2e-9, 500000000]) {
      const roundTripped = dexp(dlog(x));
      expect(Math.abs(roundTripped - x) / Math.abs(x)).toBeLessThan(1e-13);
    }
  });
});

// Math.* is implementation-approximated (ADR-0002/ADR-0005), so this is a
// loose bound to catch a gross algorithmic error, not an accuracy claim --
// the grid above already carries the real <=2ulp assertion.
describe('loose sanity bound over a dense grid vs Math.*', () => {
  function lcg(seed: number): () => number {
    let s = seed;
    return () => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  test('dsin/dcos track Math.sin/Math.cos over the full contract range', () => {
    const next = lcg(12345);
    for (let i = 0; i < 4000; i++) {
      const x = (next() * 2 - 1) * 262144; // 2^18, the dsin/dcos contract bound
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });

  test('datan2 tracks Math.atan2', () => {
    const next = lcg(777);
    for (let i = 0; i < 4000; i++) {
      const y = (next() * 2 - 1) * 1e6;
      const x = (next() * 2 - 1) * 1e6;
      expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-9);
    }
  });

  test('dexp/dlog track Math.exp/Math.log', () => {
    const next = lcg(999);
    for (let i = 0; i < 4000; i++) {
      const u = (next() * 2 - 1) * 8;
      expect(Math.abs(dexp(u) / Math.exp(u) - 1)).toBeLessThan(1e-9);
      const w = Math.exp((next() * 2 - 1) * 20);
      expect(Math.abs(dlog(w) - Math.log(w)) / Math.abs(Math.log(w) || 1)).toBeLessThan(1e-9);
    }
  });
});
