"""
P2: Kepler's equation  M = E - e*sin(E)  with a FIXED iteration count.

Reference solution computed in 60-digit Decimal (stdlib only) by Newton to
convergence; the candidate solvers all run in IEEE-754 double.

Starters tested
  S_M      E0 = M                                    (trivial)
  S_lin    E0 = M + e*sin(M)                          (first order in e)
  S_danby  E0 = M + 0.85*e*sign(sin M)                Danby (1987)
  S_mik    Mikkola (1987) cubic starter
  S_ng     E0 = M + e*sinM / (1 - sin(M+e) + sin(M))  Ng (1979)-style

Correctors tested (per iteration = ONE sin/cos pair)
  N   Newton              order 2
  H   Halley              order 3
  D   Danby-Burkardt      order 4   (three nested corrections, one trig pair)

Sources
  J.M.A. Danby, "The solution of Kepler's equation III", Celest. Mech. 40 (1987) 303.
  J.M.A. Danby & T.M. Burkardt, "The solution of Kepler's equation I",
      Celest. Mech. 31 (1983) 95.
  S. Mikkola, "A cubic approximation for Kepler's equation",
      Celest. Mech. 40 (1987) 329.
  F.T. Markley, "Kepler equation solver", Celest. Mech. Dyn. Astr. 63 (1996) 101.
"""
import math
from decimal import Decimal, getcontext

getcontext().prec = 60
DPI = Decimal("3.14159265358979323846264338327950288419716939937510582097494")

def dsin_dec(x):
    # x reduced to [-pi, pi] by caller; plain Taylor at 60 digits
    term = x
    s = x
    x2 = x * x
    n = 1
    while True:
        term = -term * x2 / Decimal((2 * n) * (2 * n + 1))
        s += term
        if abs(term) < Decimal(10) ** -58:
            return s
        n += 1

def kepler_ref(M, e):
    """60-digit reference E for M in [0, 2pi), e in [0,1)."""
    Md = Decimal(repr(M)) if isinstance(M, float) else Decimal(M)
    ed = Decimal(repr(e)) if isinstance(e, float) else Decimal(e)
    E = Md + ed * dsin_dec(Md)
    for _ in range(80):
        # reduce E into [-pi,pi] for the Taylor sin
        Er = E
        while Er > DPI:
            Er -= 2 * DPI
        while Er < -DPI:
            Er += 2 * DPI
        sE = dsin_dec(Er)
        cE = dsin_dec(DPI / 2 - Er)
        f = E - ed * sE - Md
        fp = 1 - ed * cE
        dE = -f / fp
        E = E + dE
        if abs(dE) < Decimal(10) ** -55:
            break
    return E

# ---------------- double-precision candidates ----------------

def s_M(M, e):        return M
def s_lin(M, e):      return M + e * math.sin(M)
def s_danby(M, e):
    s = math.sin(M)
    return M + (0.85 * e if s >= 0.0 else -0.85 * e)
def s_ng(M, e):
    sM = math.sin(M)
    den = 1.0 - math.sin(M + e) + sM
    return M + e * sM / den
def s_mik(M, e):
    # Mikkola 1987 cubic starter (elliptic branch)
    alpha = (1.0 - e) / (4.0 * e + 0.5)
    beta = 0.5 * M / (4.0 * e + 0.5)
    z = beta / (abs(beta) + math.sqrt(alpha ** 3 + beta * beta)) if (alpha**3 + beta*beta) > 0 else 0.0
    z = math.copysign((abs(beta) + math.sqrt(alpha ** 3 + beta * beta)) ** (1.0 / 3.0), beta) if beta != 0 else 0.0
    if z == 0.0:
        s = 0.0
    else:
        s = z - alpha / z
    s5 = s * s * s * s * s
    ds = -0.078 * s5 / (1.0 + e)
    s = s + ds
    return M + e * (3.0 * s - 4.0 * s * s * s)

def corr_newton(E, M, e):
    sE, cE = math.sin(E), math.cos(E)
    f = E - e * sE - M
    fp = 1.0 - e * cE
    return E - f / fp
def corr_halley(E, M, e):
    sE, cE = math.sin(E), math.cos(E)
    f = E - e * sE - M
    fp = 1.0 - e * cE
    fpp = e * sE
    return E - f / (fp - 0.5 * f * fpp / fp)
def corr_danby(E, M, e):
    sE, cE = math.sin(E), math.cos(E)
    f0 = E - e * sE - M
    f1 = 1.0 - e * cE
    f2 = e * sE
    f3 = e * cE
    d1 = -f0 / f1
    d2 = -f0 / (f1 + 0.5 * d1 * f2)
    d3 = -f0 / (f1 + 0.5 * d2 * f2 + d2 * d2 * f3 / 6.0)
    return E + d3

STARTERS = [("S_M", s_M), ("S_lin", s_lin), ("S_danby", s_danby),
            ("S_ng", s_ng), ("S_mik", s_mik)]
CORRS = [("Newton", corr_newton), ("Halley", corr_halley), ("Danby4", corr_danby)]

ECCS = [0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
NM = 512
MS = [2.0 * math.pi * (i + 0.5) / NM for i in range(NM)]

print("Building 60-digit reference table (%d eccentricities x %d mean anomalies)..."
      % (len(ECCS), NM))
REF = {}
for e in ECCS:
    REF[e] = [float(kepler_ref(M, e)) for M in MS]
    # keep full Decimal too for the tightest comparisons
print("done.\n")

AU = 1.495978707e11

print("=" * 100)
print("P2a  max |E_solver - E_ref| in radians, and the position error it implies at a = 1 AU")
print("=" * 100)
hdr = f"{'starter':<9}{'corrector':<9}{'iters':>6}{'trig pairs':>11}"
for e in [0.0, 0.1, 0.2, 0.4, 0.6, 0.8, 0.9]:
    hdr += f"{('e=%.2f' % e):>11}"
print(hdr)
best = {}
for sname, sf in STARTERS:
    for cname, cf in CORRS:
        for iters in (1, 2, 3, 4):
            row = f"{sname:<9}{cname:<9}{iters:>6}{iters + (0 if sname in ('S_M','S_danby') else 1):>11}"
            worst_at_06 = 0.0
            for e in [0.0, 0.1, 0.2, 0.4, 0.6, 0.8, 0.9]:
                mx = 0.0
                for i, M in enumerate(MS):
                    E = sf(M, e)
                    for _ in range(iters):
                        E = cf(E, M, e)
                    err = abs(E - REF[e][i])
                    if err > mx:
                        mx = err
                row += f"{mx:>11.2e}"
                if e == 0.6:
                    worst_at_06 = mx
            print(row)
            best[(sname, cname, iters)] = worst_at_06
    print()

print("=" * 100)
print("P2b  Candidates achieving <= 1e-14 rad for all e <= 0.6, ranked by trig-pair cost")
print("=" * 100)
cands = []
for (sname, cname, iters), err06 in best.items():
    # recompute worst over e<=0.6
    worst = 0.0
    sf = dict(STARTERS)[sname]; cf = dict(CORRS)[cname]
    for e in [0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]:
        for i, M in enumerate(MS):
            E = sf(M, e)
            for _ in range(iters):
                E = cf(E, M, e)
            worst = max(worst, abs(E - REF[e][i]))
    trig = iters + (0 if sname in ('S_M', 'S_danby') else 1)
    if worst <= 1e-14:
        cands.append((trig, worst, sname, cname, iters))
cands.sort()
print(f"{'trig pairs':>11}{'max err rad':>13}{'  x 1 AU (m)':>14}  recipe")
for trig, worst, sname, cname, iters in cands:
    print(f"{trig:>11}{worst:>13.2e}{worst*AU:>14.2e}  {sname} + {iters} x {cname}")
