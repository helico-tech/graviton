// Graviton simulation-core probe: deterministic kernels, hashing, RNG, and a
// full tick loop benchmarked at the shape the game will actually run.
// Node 24, no dependencies.

// ---------------------------------------------------------------- bit access
const _f64 = new Float64Array(2);
const _u32 = new Uint32Array(_f64.buffer);
const LE = (() => { _f64[0] = 1; return _u32[1] === 0x3ff00000; })();
const HI = LE ? 1 : 0, LO = LE ? 0 : 1;
function hiWord(x) { _f64[0] = x; return _u32[HI]; }
function loWord(x) { _f64[0] = x; return _u32[LO]; }
function fromWords(h, l) { _u32[HI] = h >>> 0; _u32[LO] = l >>> 0; return _f64[0]; }
/** 2^k built from the exponent field. Exact, no Math.pow. */
function pow2i(k) {
  if (k >= -1022 && k <= 1023) return fromWords((k + 1023) << 20, 0);
  if (k > 1023) return Infinity;
  return fromWords((k + 1223) << 20, 0) * fromWords((1023 - 200) << 20, 0);
}

// ---------------------------------------------------------------- dsin / dcos
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
      S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
      S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02,  C2 = -1.38888888888741095749e-03,
      C3 = 2.48015872894767294178e-05,  C4 = -2.75573143513906633035e-07,
      C5 = 2.08757232129817482790e-09,  C6 = -1.13596475577881948265e-11;
function kSin(x, y, iy) {
  const z = x * x, v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
function kCos(x, y) {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const ax = x < 0 ? -x : x;
  if (ax < 0.3) return 1.0 - (0.5 * z - (z * r - x * y));
  const qx = ax > 0.78125 ? 0.28125 : fromWords(hiWord(x) - 0x00200000, 0);
  const hz = 0.5 * z - qx, a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
}
const INVPIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
let _rp_n = 0, _rp_y0 = 0, _rp_y1 = 0;
/** fdlibm __ieee754_rem_pio2, medium path. Valid for |x| < 2^19*pi/2 = 8.2355e5. */
function remPio2(x) {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) { _rp_n = 0; _rp_y0 = x; _rp_y1 = 0; return; }
  const half = x > 0 ? 0.5 : -0.5;
  const n = (x * INVPIO2 + half) | 0;
  const fn = n;
  let r = x - fn * PIO2_1, w = fn * PIO2_1T;
  const j = ix >> 20;
  let y0 = r - w;
  if (j - ((hiWord(y0) >> 20) & 0x7ff) > 16) {
    const t1 = r; w = fn * PIO2_2; r = t1 - w; w = fn * PIO2_2T - ((t1 - r) - w); y0 = r - w;
    if (j - ((hiWord(y0) >> 20) & 0x7ff) > 49) {
      const t2 = r; w = fn * PIO2_3; r = t2 - w; w = fn * PIO2_3T - ((t2 - r) - w); y0 = r - w;
    }
  }
  _rp_n = n; _rp_y0 = y0; _rp_y1 = (r - y0) - w;
}
export function dsin(x) {
  remPio2(x); const iy = _rp_n === 0 ? 0 : 1;
  switch (_rp_n & 3) {
    case 0: return kSin(_rp_y0, _rp_y1, iy);
    case 1: return kCos(_rp_y0, _rp_y1);
    case 2: return -kSin(_rp_y0, _rp_y1, iy);
    default: return -kCos(_rp_y0, _rp_y1);
  }
}
export function dcos(x) {
  remPio2(x); const iy = _rp_n === 0 ? 0 : 1;
  switch (_rp_n & 3) {
    case 0: return kCos(_rp_y0, _rp_y1);
    case 1: return -kSin(_rp_y0, _rp_y1, iy);
    case 2: return -kCos(_rp_y0, _rp_y1);
    default: return kSin(_rp_y0, _rp_y1, iy);
  }
}
export let dsinOut = 0, dcosOut = 0;
/** One reduction, both kernels. Writes dsinOut / dcosOut. */
export function dsincos(x) {
  remPio2(x); const iy = _rp_n === 0 ? 0 : 1;
  const s = kSin(_rp_y0, _rp_y1, iy), c = kCos(_rp_y0, _rp_y1);
  switch (_rp_n & 3) {
    case 0: dsinOut = s; dcosOut = c; break;
    case 1: dsinOut = c; dcosOut = -s; break;
    case 2: dsinOut = -s; dcosOut = -c; break;
    default: dsinOut = -c; dcosOut = s; break;
  }
}

// ---------------------------------------------------------------- datan2
const aT = [3.33333333333329318027e-01, -1.99999999998764832476e-01,
  1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02,
  1.62858201153657823623e-02];
const atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01,
  9.82793723247329054082e-01, 1.57079632679489655800e+00];
const atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17,
  1.39033110312309984516e-17, 6.12323399573676603587e-17];
export function datan(x) {
  const neg = x < 0, ax = neg ? -x : x;
  let id, t;
  if (ax < 0.4375) { id = -1; t = x; }
  else if (ax < 1.1875) {
    if (ax < 0.6875) { id = 0; t = (2.0 * ax - 1.0) / (2.0 + ax); }
    else { id = 1; t = (ax - 1.0) / (ax + 1.0); }
  } else if (ax < 2.4375) { id = 2; t = (ax - 1.5) / (1.0 + 1.5 * ax); }
  else { id = 3; t = -1.0 / ax; }
  const z = t * t, w = z * z;
  const s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
  const s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
  if (id < 0) return t - t * (s1 + s2);
  const r = atanhi[id] - ((t * (s1 + s2) - atanlo[id]) - t);
  return neg ? -r : r;
}
const PI = 3.14159265358979311600e+00, PI_LO = 1.22464679914735317700e-16;
const PI_2 = 1.57079632679489655800e+00, PI_2LO = 6.12323399573676603587e-17;
export function datan2(y, x) {
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? PI_2 + 0.5 * PI_2LO : -(PI_2 + 0.5 * PI_2LO);
  if (y === 0) return x > 0 ? 0 : PI;
  const z = datan((y < 0 ? -y : y) / (x < 0 ? -x : x));
  if (x > 0) return y > 0 ? z : -z;
  return y > 0 ? PI - (z - PI_LO) : (z - PI_LO) - PI;
}
export function dacos(x) { return datan2(Math.sqrt((1.0 - x) * (1.0 + x)), x); }

// ---------------------------------------------------------------- dexp / dlog
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03,
      P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06,
      P5 = 4.13813679705723846039e-08;
const LN2HI = 6.93147180369123816490e-01, LN2LO = 1.90821492927058770002e-10;
const INVLN2 = 1.44269504088896338700e+00;
export function dexp(x) {
  if (x === 0) return 1;
  const k = (INVLN2 * x + (x > 0 ? 0.5 : -0.5)) | 0, fk = k;
  const hi = x - fk * LN2HI, lo = fk * LN2LO, xr = hi - lo;
  const t = xr * xr;
  const c = xr - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  return (1.0 + (xr * c / (2.0 - c) - lo + hi)) * pow2i(k);
}
const Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01,
      Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01,
      Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01,
      Lg7 = 1.479819860511658591e-01;
export function dlog(x) {
  const h = hiWord(x), l = loWord(x);
  let k = ((h >> 20) & 0x7ff) - 1023;
  let m = fromWords((h & 0x000fffff) | 0x3ff00000, l);
  if (m > 1.4142135623730951) { m *= 0.5; k += 1; }
  const f = m - 1.0, s = f / (2.0 + f), z = s * s, w = z * z;
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  const R = t2 + t1, hfsq = 0.5 * f * f, fk = k;
  return fk * LN2HI - ((hfsq - (s * (hfsq + R) + fk * LN2LO)) - f);
}

// ---------------------------------------------------------------- Kepler
const TWO_PI = 6.283185307179586, PI_D = 3.141592653589793;
export let kepE = 0, kepSin = 0, kepCos = 0;
/** M must already be reduced to [0, 2pi). Danby starter + 3 Danby-Burkardt
 *  corrections, then one first-order sin/cos update. 3 dsincos calls. */
export function solveKepler(M, e) {
  let E = M + (M < PI_D ? 0.85 * e : -0.85 * e);
  let sE = 0, cE = 0, d = 0;
  for (let i = 0; i < 3; i++) {
    dsincos(E); sE = dsinOut; cE = dcosOut;
    const f0 = E - e * sE - M, f1 = 1.0 - e * cE, f2 = e * sE, f3 = e * cE;
    const d1 = -f0 / f1;
    const d2 = -f0 / (f1 + 0.5 * d1 * f2);
    d = -f0 / (f1 + 0.5 * d2 * f2 + d2 * d2 * f3 / 6.0);
    E = E + d;
  }
  // |d| after the third correction is <= ~5e-13 for e <= 0.9, so a first-order
  // rotation of (sE, cE) is exact to ~1e-25, far below one ulp.
  kepE = E; kepSin = sE + cE * d; kepCos = cE - sE * d;
}

// ---------------------------------------------------------------- hashing
/** FNV-1a style 64-bit hash over the raw bit patterns of a Float64Array.
 *  Two 32-bit lanes with distinct offset bases. -0 is canonicalised to +0. */
export function hashF64(arr, n) {
  let a = 0x811c9dc5 | 0, b = 0x01000193 | 0;
  for (let i = 0; i < n; i++) {
    let v = arr[i];
    if (v === 0) v = 0;                    // collapse -0 to +0
    _f64[0] = v;
    const h = _u32[HI] | 0, l = _u32[LO] | 0;
    a = Math.imul(a ^ l, 0x01000193); a = Math.imul(a ^ h, 0x01000193);
    b = Math.imul(b ^ h, 0x85ebca6b); b = Math.imul(b ^ l, 0x85ebca6b);
  }
  return ((a >>> 0).toString(16).padStart(8, '0')) + ((b >>> 0).toString(16).padStart(8, '0'));
}
export function hashU32(arr, n) {
  let a = 0x811c9dc5 | 0;
  for (let i = 0; i < n; i++) a = Math.imul(a ^ (arr[i] | 0), 0x01000193);
  return (a >>> 0);
}

// ---------------------------------------------------------------- RNG
export function splitmix32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}
/** sfc32, four uint32 words of state, seeded from splitmix32. */
export function makeStream(levelSeed, name) {
  let nameHash = 0x811c9dc5 | 0;
  for (let i = 0; i < name.length; i++)
    nameHash = Math.imul(nameHash ^ name.charCodeAt(i), 0x01000193);
  const sm = splitmix32((levelSeed ^ nameHash) | 0);
  const st = new Uint32Array(4);
  st[0] = sm(); st[1] = sm(); st[2] = sm(); st[3] = sm();
  for (let i = 0; i < 12; i++) sfc32(st);       // discard, warm up
  return st;
}
export function sfc32(st) {
  const a = st[0], b = st[1], c = st[2], d = st[3];
  const t = (a + b | 0) + d | 0;
  st[3] = d + 1 | 0;
  st[0] = b ^ (b >>> 9);
  st[1] = c + (c << 3) | 0;
  st[2] = (c << 21) | (c >>> 11);
  st[2] = st[2] + t | 0;
  return t >>> 0;
}
/** Uniform in [0,1) from one 32-bit draw. Exact division by 2^32. */
export function sfcUnit(st) { return sfc32(st) * 2.3283064365386963e-10; }
