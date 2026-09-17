// Deterministic transcendental kernels, ported from fdlibm 5.3 (Sun
// Microsystems, public domain, 1993) via
// docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs
// (research §2, ADR-0005 "Transcendentals"). ECMA-262 only requires Math.sin
// and friends to be "implementation-approximated", and two production
// engines measurably disagree by a ulp on the same input; IEEE-754 mandates
// that + - * / and sqrt be correctly rounded, so that -- plus raw double
// bits for range reduction and exponent surgery -- is all this file uses.

const bits = new DataView(new ArrayBuffer(8));

function hiWord(x: number): number {
  bits.setFloat64(0, x);
  return bits.getUint32(0) | 0;
}
function loWord(x: number): number {
  bits.setFloat64(0, x);
  return bits.getUint32(4) | 0;
}
function fromWords(hi: number, lo: number): number {
  bits.setUint32(0, hi >>> 0);
  bits.setUint32(4, lo >>> 0);
  return bits.getFloat64(0);
}

/** 2^k built from the exponent field, never Math.pow. The two-step multiply
 *  for k < -1022 keeps a subnormal result exact; dexp's own domain never
 *  reaches it, but pow2i is a general building block. */
function pow2i(k: number): number {
  if (k >= -1022 && k <= 1023) return fromWords((k + 1023) << 20, 0);
  if (k > 1023) return Infinity;
  return fromWords((k + 1223) << 20, 0) * fromWords((1023 - 200) << 20, 0);
}

// ---------------------------------------------------------------- dsin / dcos
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

function kSin(x: number, y: number, iy: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

function kCos(x: number, y: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const ax = x < 0 ? -x : x;
  if (ax < 0.3) return 1.0 - (0.5 * z - (z * r - x * y));
  const qx = ax > 0.78125 ? 0.28125 : fromWords(hiWord(x) - 0x00200000, 0);
  const hz = 0.5 * z - qx;
  const a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
}

const INVPIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.0771005063039659766e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.0222662487111664558e-21;
const PIO2_3T = 8.47842766036889956997e-32;

// Mean anomaly is always reduced to [0, 2pi) before any trig call (research
// §2.2), so no legitimate caller needs a wider domain; enforcing the bound
// here turns a missing upstream reduction into a loud failure instead of a
// silently wrong medium-path reduction.
const TRIG_ARG_LIMIT = 262144; // 2^18

let reducedN = 0;
let reducedY0 = 0;
let reducedY1 = 0;

/** fdlibm __ieee754_rem_pio2, medium path only: exact for the |n| < 2^19
 *  this sim ever produces (research §2.2 measured exactness up to 2^22).
 *  Writes reducedN/Y0/Y1 instead of allocating, since dsin/dcos/dsincos are
 *  the only high-frequency trig in the simulation (Kepler's inner loop). */
function remPio2(x: number): void {
  if (x > TRIG_ARG_LIMIT || x < -TRIG_ARG_LIMIT) {
    throw new RangeError(`dsin/dcos/dsincos: |x| must be <= 2^18, got ${x}`);
  }
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    reducedN = 0;
    reducedY0 = x;
    reducedY1 = 0;
    return;
  }
  const half = x > 0 ? 0.5 : -0.5;
  const n = (x * INVPIO2 + half) | 0;
  const fn = n;
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T;
  const j = ix >> 20;
  let y0 = r - w;
  if (j - ((hiWord(y0) >> 20) & 0x7ff) > 16) {
    const t1 = r;
    w = fn * PIO2_2;
    r = t1 - w;
    w = fn * PIO2_2T - (t1 - r - w);
    y0 = r - w;
    if (j - ((hiWord(y0) >> 20) & 0x7ff) > 49) {
      const t2 = r;
      w = fn * PIO2_3;
      r = t2 - w;
      w = fn * PIO2_3T - (t2 - r - w);
      y0 = r - w;
    }
  }
  reducedN = n;
  reducedY0 = y0;
  reducedY1 = r - y0 - w;
}

export function dsin(x: number): number {
  remPio2(x);
  const iy = reducedN === 0 ? 0 : 1;
  switch (reducedN & 3) {
    case 0:
      return kSin(reducedY0, reducedY1, iy);
    case 1:
      return kCos(reducedY0, reducedY1);
    case 2:
      return -kSin(reducedY0, reducedY1, iy);
    default:
      return -kCos(reducedY0, reducedY1);
  }
}

export function dcos(x: number): number {
  remPio2(x);
  const iy = reducedN === 0 ? 0 : 1;
  switch (reducedN & 3) {
    case 0:
      return kCos(reducedY0, reducedY1);
    case 1:
      return -kSin(reducedY0, reducedY1, iy);
    case 2:
      return -kCos(reducedY0, reducedY1);
    default:
      return kSin(reducedY0, reducedY1, iy);
  }
}

export let dsinOut = 0;
export let dcosOut = 0;

/** One reduction serving both kernels: the Kepler solver's inner loop
 *  (GRV-0005) calls this rather than dsin/dcos separately, so a state-vector
 *  query pays one remPio2 instead of two. Writes dsinOut/dcosOut rather than
 *  allocating a pair, matching the reference and the rest of src/sim/state's
 *  mutate-in-place convention for hot-path state. */
export function dsincos(x: number): void {
  remPio2(x);
  const iy = reducedN === 0 ? 0 : 1;
  const s = kSin(reducedY0, reducedY1, iy);
  const c = kCos(reducedY0, reducedY1);
  switch (reducedN & 3) {
    case 0:
      dsinOut = s;
      dcosOut = c;
      break;
    case 1:
      dsinOut = c;
      dcosOut = -s;
      break;
    case 2:
      dsinOut = -s;
      dcosOut = -c;
      break;
    default:
      dsinOut = -c;
      dcosOut = s;
      break;
  }
}

// ---------------------------------------------------------------- datan(2)
const aT0 = 3.33333333333329318027e-1;
const aT1 = -1.99999999998764832476e-1;
const aT2 = 1.42857142725034663711e-1;
const aT3 = -1.1111110405462355788e-1;
const aT4 = 9.09088713343650656196e-2;
const aT5 = -7.69187620504482999495e-2;
const aT6 = 6.66107313738753120669e-2;
const aT7 = -5.83357013379057348645e-2;
const aT8 = 4.97687799461593236017e-2;
const aT9 = -3.6531572744216915527e-2;
const aT10 = 1.62858201153657823623e-2;
const atanhi = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
];
const atanlo = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];

export function datan(x: number): number {
  const neg = x < 0;
  const ax = neg ? -x : x;
  let id: number;
  let t: number;
  if (ax < 0.4375) {
    id = -1;
    t = x;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      t = (2.0 * ax - 1.0) / (2.0 + ax);
    } else {
      id = 1;
      t = (ax - 1.0) / (ax + 1.0);
    }
  } else if (ax < 2.4375) {
    id = 2;
    t = (ax - 1.5) / (1.0 + 1.5 * ax);
  } else {
    id = 3;
    t = -1.0 / ax;
  }
  const z = t * t;
  const w = z * z;
  const s1 = z * (aT0 + w * (aT2 + w * (aT4 + w * (aT6 + w * (aT8 + w * aT10)))));
  const s2 = w * (aT1 + w * (aT3 + w * (aT5 + w * (aT7 + w * aT9))));
  if (id < 0) return t - t * (s1 + s2);
  const r = atanhi[id]! - (t * (s1 + s2) - atanlo[id]! - t);
  return neg ? -r : r;
}

const PI = 3.141592653589793116;
const PI_LO = 1.2246467991473532e-16; // same double as fdlibm's 1.22464679914735317700e-16
const PI_2 = 1.570796326794896558;
const PI_2LO = 6.12323399573676603587e-17;

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? PI_2 + 0.5 * PI_2LO : -(PI_2 + 0.5 * PI_2LO);
  if (y === 0) return x > 0 ? 0 : PI;
  const z = datan((y < 0 ? -y : y) / (x < 0 ? -x : x));
  if (x > 0) return y > 0 ? z : -z;
  return y > 0 ? PI - (z - PI_LO) : z - PI_LO - PI;
}

/** Not a separate kernel: (1-x)*(1+x) rather than 1-x*x preserves precision
 *  near |x| = 1, exactly where the intercept-confidence lens formula
 *  (research §6.3) evaluates it. */
export function dacos(x: number): number {
  return datan2(Math.sqrt((1.0 - x) * (1.0 + x)), x);
}

// ---------------------------------------------------------------- dexp / dlog
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;
const LN2HI = 6.9314718036912381649e-1;
const LN2LO = 1.90821492927058770002e-10;
const INVLN2 = 1.442695040888963387;

export function dexp(x: number): number {
  if (x === 0) return 1;
  const k = (INVLN2 * x + (x > 0 ? 0.5 : -0.5)) | 0;
  const fk = k;
  const hi = x - fk * LN2HI;
  const lo = fk * LN2LO;
  const xr = hi - lo;
  const t = xr * xr;
  const c = xr - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  return (1.0 + ((xr * c) / (2.0 - c) - lo + hi)) * pow2i(k);
}

const Lg1 = 6.66666666666673513e-1;
const Lg2 = 3.999999999940941908e-1;
const Lg3 = 2.857142874366239149e-1;
const Lg4 = 2.222219843214978396e-1;
const Lg5 = 1.818357216161805012e-1;
const Lg6 = 1.531383769920937332e-1;
const Lg7 = 1.479819860511658591e-1;

export function dlog(x: number): number {
  const h = hiWord(x);
  const l = loWord(x);
  let k = ((h >> 20) & 0x7ff) - 1023;
  let m = fromWords((h & 0x000fffff) | 0x3ff00000, l);
  if (m > 1.4142135623730951) {
    m *= 0.5;
    k += 1;
  }
  const f = m - 1.0;
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  const r = t2 + t1;
  const hfsq = 0.5 * f * f;
  const fk = k;
  return fk * LN2HI - (hfsq - (s * (hfsq + r) + fk * LN2LO) - f);
}
