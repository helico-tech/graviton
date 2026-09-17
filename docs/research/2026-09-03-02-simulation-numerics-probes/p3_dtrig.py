"""
P3: deterministic dsin / dcos / datan2 / dexp / dlog built ONLY from
+ - * / sqrt floor comparisons and bit reinterpretation, measured against a
60-digit Decimal reference.

Python floats are IEEE-754 binary64 with no FMA and no extended-precision
accumulation on x86-64, exactly like JavaScript Numbers, so an error measured
here is the error the TypeScript port will have.

Coefficients are fdlibm's (Sun Microsystems, public domain, 1993) as shipped in
musl libm and in Go's math package. Kernels reproduced here so we can measure.
"""
import math, struct
from decimal import Decimal, getcontext
getcontext().prec = 70

DPI = Decimal("3.1415926535897932384626433832795028841971693993751058209749445923078164")

def dec_sin(x):
    # exact-ish for any x: reduce mod 2pi at 70 digits first
    n = int(x / (2 * DPI))
    x = x - n * 2 * DPI
    while x > DPI:  x -= 2 * DPI
    while x < -DPI: x += 2 * DPI
    t, s, x2, k = x, x, x * x, 1
    while True:
        t = -t * x2 / Decimal((2 * k) * (2 * k + 1)); s += t; k += 1
        if abs(t) < Decimal(10) ** -68: return s
def dec_cos(x):  return dec_sin(DPI / 2 - x)
def dec_atan(x):
    # atan via arctan series with range reduction atan(x)=2*atan(x/(1+sqrt(1+x^2)))
    negate = x < 0
    x = abs(x)
    red = 0
    while x > Decimal("0.05"):
        x = x / (1 + (1 + x * x).sqrt()); red += 1
    t, s, x2, k = x, x, x * x, 1
    while True:
        t = -t * x2; term = t / (2 * k + 1); s += term; k += 1
        if abs(term) < Decimal(10) ** -68: break
    s = s * (2 ** red)
    return -s if negate else s
def dec_exp(x):
    n = int(x / DPI * 0)  # no reduction needed for our ranges; use direct series w/ scaling
    k = int(x)
    r = x - k
    t, s, j = Decimal(1), Decimal(1), 1
    while True:
        t = t * r / j; s += t; j += 1
        if abs(t) < Decimal(10) ** -68: break
    E = Decimal("2.718281828459045235360287471352662497757247093699959574966967627724077")
    return s * (E ** k)
def dec_log(x):
    # atanh series: log(x) = 2*atanh((x-1)/(x+1)) after scaling by powers of 2
    L2 = Decimal("0.69314718055994530941723212145817656807550013436025525412068000949339362")
    k = 0
    while x > 2: x /= 2; k += 1
    while x < Decimal("0.5"): x *= 2; k -= 1
    s = (x - 1) / (x + 1)
    t, acc, s2, j = s, s, s * s, 1
    while True:
        t = t * s2; term = t / (2 * j + 1); acc += term; j += 1
        if abs(term) < Decimal(10) ** -68: break
    return 2 * acc + k * L2

# ---------------------------------------------------------------- bit helpers
def hi32(x):  return struct.unpack('>II', struct.pack('>d', x))[0]
def lo32(x):  return struct.unpack('>II', struct.pack('>d', x))[1]
def from32(h, l): return struct.unpack('>d', struct.pack('>II', h & 0xffffffff, l & 0xffffffff))[0]
def scalbn_pow2(k):
    """2^k as a double, built from the exponent field only. -1000 <= k <= 1000."""
    if k >= -1022:
        return from32((k + 1023) << 20, 0)
    return from32((k + 1023 + 200) << 20, 0) * from32((1023 - 200) << 20, 0)

# ---------------------------------------------------------------- dsin / dcos
S1 = -1.66666666666666324348e-01; S2 =  8.33333333332248946124e-03
S3 = -1.98412698298579493134e-04; S4 =  2.75573137070700676789e-06
S5 = -2.50507602534068634195e-08; S6 =  1.58969099521155010221e-10
C1 =  4.16666666666666019037e-02; C2 = -1.38888888888741095749e-03
C3 =  2.48015872894767294178e-05; C4 = -2.75573143513906633035e-07
C5 =  2.08757232129817482790e-09; C6 = -1.13596475577881948265e-11

def kernel_sin(x, y, iy):
    z = x * x; v = z * x
    r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
    if iy == 0:
        return x + v * (S1 + z * r)
    return x - ((z * (0.5 * y - v * r) - y) - v * S1)

def kernel_cos(x, y):
    z = x * x
    r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
    if abs(x) < 0.3:
        return 1.0 - (0.5 * z - (z * r - x * y))
    if x > 0.78125: qx = 0.28125
    else:           qx = from32(hi32(x) - 0x00200000, 0)   # x/4, top bits only
    hz = 0.5 * z - qx
    a = 1.0 - qx
    return a - (hz - (z * r - x * y))

INVPIO2 = 6.36619772367581382433e-01
PIO2_1  = 1.57079632673412561417e+00; PIO2_1T = 6.07710050650619224932e-11
PIO2_2  = 6.07710050630396597660e-11; PIO2_2T = 2.02226624879595063154e-21
PIO2_3  = 2.02226624871116645580e-21; PIO2_3T = 8.47842766036889956997e-32
TWO24   = 1.67772160000000000000e+07

def rem_pio2(x):
    """fdlibm __ieee754_rem_pio2, medium path only.
    Returns (n, y0, y1) with x - n*(pi/2) = y0 + y1 to ~151 bits, |y0| <= pi/4.
    Valid for |x| < 2^19 * pi/2 = 8.2355e5. Uses only + - * and bit reads."""
    hx = hi32(x)
    ix = hx & 0x7fffffff
    if ix <= 0x3fe921fb:                      # |x| <= pi/4
        return 0, x, 0.0
    assert ix < 0x413921fb, "argument exceeds the declared reduction bound"
    half = 0.5 if x > 0 else -0.5
    n = int(x * INVPIO2 + half)
    fn = float(n)
    r = x - fn * PIO2_1
    w = fn * PIO2_1T                          # 1st round: good to 85 bits
    j = ix >> 20
    y0 = r - w
    i = j - ((hi32(y0) >> 20) & 0x7ff)
    if i > 16:                                # 2nd round: good to 118 bits
        t = r
        w = fn * PIO2_2
        r = t - w
        w = fn * PIO2_2T - ((t - r) - w)
        y0 = r - w
        i = j - ((hi32(y0) >> 20) & 0x7ff)
        if i > 49:                            # 3rd round: good to 151 bits
            t = r
            w = fn * PIO2_3
            r = t - w
            w = fn * PIO2_3T - ((t - r) - w)
            y0 = r - w
    y1 = (r - y0) - w
    return n, y0, y1

def dsin(x):
    n, y0, y1 = rem_pio2(x)
    iy = 0 if n == 0 else 1
    q = n & 3
    if q == 0: return kernel_sin(y0, y1, iy)
    if q == 1: return kernel_cos(y0, y1)
    if q == 2: return -kernel_sin(y0, y1, iy)
    return -kernel_cos(y0, y1)

def dcos(x):
    n, y0, y1 = rem_pio2(x)
    iy = 0 if n == 0 else 1
    q = n & 3
    if q == 0: return kernel_cos(y0, y1)
    if q == 1: return -kernel_sin(y0, y1, iy)
    if q == 2: return -kernel_cos(y0, y1)
    return kernel_sin(y0, y1, iy)

def dsincos(x):
    """One reduction, both kernels -- what the Kepler solver actually calls."""
    n, y0, y1 = rem_pio2(x)
    iy = 0 if n == 0 else 1
    s = kernel_sin(y0, y1, iy); c = kernel_cos(y0, y1)
    q = n & 3
    if q == 0: return s, c
    if q == 1: return c, -s
    if q == 2: return -s, -c
    return -c, s

# ---------------------------------------------------------------- datan / datan2
aT = [3.33333333333329318027e-01, -1.99999999998764832476e-01,
      1.42857142725034663711e-01, -1.11111104054623557880e-01,
      9.09088713343650656196e-02, -7.69187620504482999495e-02,
      6.66107313738753120669e-02, -5.83357013379057348645e-02,
      4.97687799461593236017e-02, -3.65315727442169155270e-02,
      1.62858201153657823623e-02]
atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01,
          9.82793723247329054082e-01, 1.57079632679489655800e+00]
atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17,
          1.39033110312309984516e-17, 6.12323399573676603587e-17]

def datan(x):
    neg = x < 0.0
    ax = abs(x)
    if ax < 0.4375:
        idd = -1; t = ax if not neg else x
        t = x
    else:
        t = ax
        if t < 1.1875:
            if t < 0.6875: idd = 0; t = (2.0 * t - 1.0) / (2.0 + t)
            else:          idd = 1; t = (t - 1.0) / (t + 1.0)
        else:
            if t < 2.4375: idd = 2; t = (t - 1.5) / (1.0 + 1.5 * t)
            else:          idd = 3; t = -1.0 / t
    z = t * t; w = z * z
    s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))))
    s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))))
    if idd < 0:
        return t - t * (s1 + s2)
    z = atanhi[idd] - ((t * (s1 + s2) - atanlo[idd]) - t)
    return -z if neg else z

PI    = 3.14159265358979311600e+00
PI_LO = 1.22464679914735317700e-16
PI_2  = 1.57079632679489655800e+00
PI_2LO= 6.12323399573676603587e-17

def datan2(y, x):
    if x == 0.0 and y == 0.0: return 0.0
    if x == 0.0: return PI_2 + 0.5 * PI_2LO if y > 0 else -(PI_2 + 0.5 * PI_2LO)
    if y == 0.0: return 0.0 if x > 0 else PI
    z = datan(abs(y / x))
    if x > 0.0:  return z if y > 0 else -z
    return (PI - (z - PI_LO)) if y > 0 else ((z - PI_LO) - PI)

# ---------------------------------------------------------------- dexp / dlog
P1 =  1.66666666666666019037e-01; P2 = -2.77777777770155933842e-03
P3 =  6.61375632143793436117e-05; P4 = -1.65339022054652515390e-06
P5 =  4.13813679705723846039e-08
LN2HI = 6.93147180369123816490e-01; LN2LO = 1.90821492927058770002e-10
INVLN2 = 1.44269504088896338700e+00

def dexp(x):
    if x == 0.0: return 1.0
    k = int(INVLN2 * x + (0.5 if x > 0 else -0.5))
    fk = float(k)
    hi = x - fk * LN2HI
    lo = fk * LN2LO
    xr = hi - lo
    t = xr * xr
    c = xr - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
    y = 1.0 + (xr * c / (2.0 - c) - lo + hi)
    return y * scalbn_pow2(k)

Lg1 = 6.666666666666735130e-01; Lg2 = 3.999999999940941908e-01
Lg3 = 2.857142874366239149e-01; Lg4 = 2.222219843214978396e-01
Lg5 = 1.818357216161805012e-01; Lg6 = 1.531383769920937332e-01
Lg7 = 1.479819860511658591e-01

def dlog(x):
    h = hi32(x); l = lo32(x)
    k = ((h >> 20) & 0x7ff) - 1023
    m = from32((h & 0x000fffff) | 0x3ff00000, l)     # mantissa in [1,2)
    if m > 1.4142135623730951:
        m *= 0.5; k += 1
    f = m - 1.0
    s = f / (2.0 + f)
    z = s * s; w = z * z
    t1 = w * (Lg2 + w * (Lg4 + w * Lg6))
    t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)))
    R = t2 + t1
    hfsq = 0.5 * f * f
    fk = float(k)
    return fk * LN2HI - ((hfsq - (s * (hfsq + R) + fk * LN2LO)) - f)

# ================================================================ measurement
def ulps(got, ref_dec):
    """error in units of the last place of `got`"""
    if got == 0.0: return abs(float(ref_dec)) / 5e-324
    e = abs(Decimal(got) - ref_dec)
    ulp = abs(math.nextafter(got, math.inf) - got)
    return float(e / Decimal(ulp)) if ulp else 0.0

def relerr(got, ref_dec):
    if ref_dec == 0: return abs(got)
    return abs(float((Decimal(got) - ref_dec) / ref_dec))

import random
random.seed(20260903)

print("=" * 96)
print("P3a  dsin / dcos accuracy   (60-digit Decimal reference)")
print("=" * 96)
print(f"{'argument range':<34}{'N':>7}{'max rel err':>14}{'max ulp':>10}{'vs Math.sin ulp':>17}")
ranges = [
    ("[-pi/4, pi/4]",            lambda: random.uniform(-0.7853981633974483, 0.7853981633974483)),
    ("[-2pi, 2pi]",              lambda: random.uniform(-2*math.pi, 2*math.pi)),
    ("[0, 200]  (30 d, 1 d body)", lambda: random.uniform(0, 200)),
    ("[0, 1e4]  contract bound/100", lambda: random.uniform(0, 1e4)),
    ("[0, 1e5]  10x contract bound", lambda: random.uniform(0, 1e5)),
    ("[0, 8.2e5] fdlibm medium max", lambda: random.uniform(0, 8.23e5)),
]
for label, gen in ranges:
    mx_r = mx_u = mx_l = 0.0
    N = 4000
    for _ in range(N):
        x = gen()
        xd = Decimal(x)
        for f, ref in ((dsin, dec_sin), (dcos, dec_cos)):
            rd = ref(xd)
            g = f(x)
            mx_r = max(mx_r, relerr(g, rd)); mx_u = max(mx_u, ulps(g, rd))
        mx_l = max(mx_l, ulps(math.sin(x), dec_sin(xd)), ulps(math.cos(x), dec_cos(xd)))
    print(f"{label:<34}{N:>7}{mx_r:>14.3e}{mx_u:>10.3f}{mx_l:>17.3f}")

print()
print("=" * 96)
print("P3b  dsincos (single reduction, both kernels) -- the Kepler inner loop")
print("=" * 96)
mx = 0.0
for _ in range(4000):
    x = random.uniform(0, 2 * math.pi)
    s, c = dsincos(x)
    xd = Decimal(x)
    mx = max(mx, relerr(s, dec_sin(xd)), relerr(c, dec_cos(xd)))
    # unit-circle identity, the invariant the state-vector code depends on
print(f"  max rel err over [0,2pi):            {mx:.3e}")
mxid = 0.0
for _ in range(20000):
    x = random.uniform(0, 2 * math.pi)
    s, c = dsincos(x)
    mxid = max(mxid, abs(s * s + c * c - 1.0))
print(f"  max |s^2 + c^2 - 1|:                 {mxid:.3e}")

print()
print("=" * 96)
print("P3c  datan2 accuracy")
print("=" * 96)
mx_r = mx_u = 0.0
for _ in range(6000):
    ex = random.randint(-30, 30); ey = random.randint(-30, 30)
    x = random.uniform(-1, 1) * (2.0 ** ex); y = random.uniform(-1, 1) * (2.0 ** ey)
    if x == 0 or y == 0: continue
    g = datan2(y, x)
    rd = dec_atan(Decimal(repr(y)) / Decimal(x))
    if x < 0:  rd = rd + DPI if y > 0 else rd - DPI
    mx_r = max(mx_r, relerr(g, rd)); mx_u = max(mx_u, ulps(g, rd))
print(f"  max rel err: {mx_r:.3e}    max ulp: {mx_u:.3f}")
mxd = max(abs(datan2(y, x) - math.atan2(y, x))
          for y, x in [(random.uniform(-1e6,1e6), random.uniform(-1e6,1e6)) for _ in range(20000)])
print(f"  max |datan2 - Math.atan2| (libm agreement): {mxd:.3e}")

print()
print("=" * 96)
print("P3d  dexp / dlog accuracy over the ranges the sim uses")
print("=" * 96)
print(f"{'function':<10}{'range':<28}{'max rel err':>14}{'max ulp':>10}")
mx_r = mx_u = 0.0
for _ in range(6000):
    x = random.uniform(-8, 8)          # dv/ve for any sane probe
    g = dexp(x); rd = dec_exp(Decimal(x))
    mx_r = max(mx_r, relerr(g, rd)); mx_u = max(mx_u, ulps(g, rd))
print(f"{'dexp':<10}{'[-8, 8]':<28}{mx_r:>14.3e}{mx_u:>10.3f}")
mx_r = mx_u = 0.0
for _ in range(6000):
    x = math.exp(random.uniform(-20, 20))
    g = dlog(x); rd = dec_log(Decimal(x))
    mx_r = max(mx_r, relerr(g, rd)); mx_u = max(mx_u, ulps(g, rd))
print(f"{'dlog':<10}{'[2e-9, 5e8] (mass ratios)':<28}{mx_r:>14.3e}{mx_u:>10.3f}")
mx_r = 0.0
for _ in range(6000):
    r = random.uniform(1.0, 30.0)      # m_wet/m_dry
    g = dlog(r); rd = dec_log(Decimal(r))
    mx_r = max(mx_r, relerr(g, rd))
print(f"{'dlog':<10}{'[1, 30] rocket eq':<28}{mx_r:>14.3e}")

print()
print("=" * 96)
print("P3e  exactness of the Cody-Waite reduction: is n*PIO2_1 exact?")
print("=" * 96)
from fractions import Fraction
bad = 0
worst_n = 0
for n in [1, 2, 3, 7, 100, 1000, 2**16, 2**19, 2**20, 2**20 + 1, 2**21, 2**22, 2**24]:
    p = float(n) * PIO2_1
    exact = Fraction(n) * Fraction(PIO2_1)
    ok = Fraction(p) == exact
    if not ok and worst_n == 0: worst_n = n
    print(f"  n = 2^{math.log2(n):<6.2f} = {n:>10}   n*PIO2_1 exact: {ok}")
print(f"  -> first n where the product rounds: {worst_n}  (PIO2_1 carries "
      f"{PIO2_1.hex()}, 33 significant bits)")
