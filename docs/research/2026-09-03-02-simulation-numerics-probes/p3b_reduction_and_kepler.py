"""
P3e (corrected) + P3f: exactness bound of the Cody-Waite constant, and the
Kepler solver running on top of dsincos rather than libm.
"""
import math, random
from fractions import Fraction
from decimal import Decimal, getcontext
import importlib.util, sys, os
spec = importlib.util.spec_from_file_location("p3", os.path.join(os.path.dirname(os.path.abspath(__file__)), "p3_dtrig.py"))
# suppress p3's own report
import io, contextlib
p3 = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(p3)

getcontext().prec = 60
random.seed(7)

print("=" * 92)
print("P3e (corrected)  For which n is  n * PIO2_1  exact?  (powers of two are")
print("                 trivially exact, so test worst-case odd n)")
print("=" * 92)
PIO2_1 = p3.PIO2_1
sig_bits = 53 - ((Fraction(PIO2_1).denominator.bit_length() - 1) and 0)  # informative only
print(f"  PIO2_1 = {PIO2_1.hex()}   -> 33 significant bits\n")
print(f"{'n bits':>8}{'trials':>8}{'all exact':>12}{'max rel round-off':>20}")
for nb in range(1, 27):
    lo, hi = 1 << (nb - 1), (1 << nb) - 1
    allex, mx = True, 0.0
    for _ in range(3000):
        n = random.randrange(lo, hi + 1) | 1
        prod = float(n) * PIO2_1
        ex = Fraction(n) * Fraction(PIO2_1)
        if Fraction(prod) != ex:
            allex = False
            mx = max(mx, abs(float((Fraction(prod) - ex) / ex)))
    print(f"{nb:>8}{3000:>8}{str(allex):>12}{mx:>20.3e}")
print("\n  -> exact for all |n| < 2^20; fdlibm's own medium-path guard is")
print("     |x| < 2^19 * pi/2 = 8.2355e5 rad, which caps |n| at 2^19. Safe.")

print()
print("=" * 92)
print("P3f  Kepler solver on dsincos (no libm anywhere), 60-digit reference")
print("=" * 92)

# reference from p2
DPI = Decimal("3.14159265358979323846264338327950288419716939937510582097494")
def dsin_dec(x):
    t, s, x2, k = x, x, x * x, 1
    while True:
        t = -t * x2 / Decimal((2*k)*(2*k+1)); s += t; k += 1
        if abs(t) < Decimal(10) ** -55: return s
def kepler_ref(M, e):
    Md, ed = Decimal(M), Decimal(e)
    E = Md + ed * dsin_dec(Md)
    for _ in range(90):
        Er = E
        while Er > DPI:  Er -= 2*DPI
        while Er < -DPI: Er += 2*DPI
        f  = E - ed * dsin_dec(Er) - Md
        fp = 1 - ed * dsin_dec(DPI/2 - Er)
        dE = -f/fp; E += dE
        if abs(dE) < Decimal(10) ** -52: break
    return E

TWO_PI = 6.283185307179586

def solve_kepler(M, e, iters=3):
    """M already reduced to [0, 2pi).  Danby starter + `iters` Danby-Burkardt
    corrections.  Returns (E, sinE, cosE).  Trig pairs used = iters."""
    # sign(sin M) without any trig: positive iff M < pi
    E = M + (0.85 * e if M < 3.141592653589793 else -0.85 * e)
    sE = cE = 0.0
    for _ in range(iters):
        sE, cE = p3.dsincos(E)
        f0 = E - e * sE - M
        f1 = 1.0 - e * cE
        f2 = e * sE
        f3 = e * cE
        d1 = -f0 / f1
        d2 = -f0 / (f1 + 0.5 * d1 * f2)
        d3 = -f0 / (f1 + 0.5 * d2 * f2 + d2 * d2 * f3 / 6.0)
        E = E + d3
    sE, cE = p3.dsincos(E)      # final pair is the one the state vector needs
    return E, sE, cE

def solve_kepler_reuse(M, e, iters=3):
    """Same, but iterations 2..n update sin/cos by small-angle addition:
       sin(E+d) = sE*cos d + cE*sin d, with 4-term series for |d| < 0.15.
       Costs ONE dsincos call in total."""
    E = M + (0.85 * e if M < 3.141592653589793 else -0.85 * e)
    sE, cE = p3.dsincos(E)
    for _ in range(iters):
        f0 = E - e * sE - M
        f1 = 1.0 - e * cE
        f2 = e * sE
        f3 = e * cE
        d1 = -f0 / f1
        d2 = -f0 / (f1 + 0.5 * d1 * f2)
        d3 = -f0 / (f1 + 0.5 * d2 * f2 + d2 * d2 * f3 / 6.0)
        E = E + d3
        d = d3; d2_ = d * d
        if abs(d) < 0.2:
            sd = d * (1.0 - d2_ * (1.0/6.0 - d2_ * (1.0/120.0 - d2_ / 5040.0)))
            cd = 1.0 - d2_ * (0.5 - d2_ * (1.0/24.0 - d2_ * (1.0/720.0 - d2_ / 40320.0)))
            sE, cE = sE * cd + cE * sd, cE * cd - sE * sd
        else:
            sE, cE = p3.dsincos(E)
    return E, sE, cE

NM = 400
MS = [TWO_PI * (i + 0.5) / NM for i in range(NM)]
AU = 1.495978707e11
print(f"{'variant':<34}{'dsincos calls':>14}", end="")
for e in (0.0, 0.2, 0.4, 0.6, 0.8, 0.9): print(f"{('e='+str(e)):>11}", end="")
print()
REF = {e: [float(kepler_ref(M, e)) for M in MS] for e in (0.0, 0.2, 0.4, 0.6, 0.8, 0.9)}
for label, fn, iters, calls in (
        ("Danby starter + 2 Danby4", solve_kepler, 2, 3),
        ("Danby starter + 3 Danby4", solve_kepler, 3, 4),
        ("  ... + addition-formula reuse", solve_kepler_reuse, 3, 1),
        ("  ... 4 iters + reuse", solve_kepler_reuse, 4, 1)):
    row = f"{label:<34}{calls:>14}"
    for e in (0.0, 0.2, 0.4, 0.6, 0.8, 0.9):
        mx = max(abs(fn(M, e, iters)[0] - REF[e][i]) for i, M in enumerate(MS))
        row += f"{mx:>11.2e}"
    print(row)

print()
print("  Same, expressed as position error on a 1 AU semi-major axis (metres):")
for label, fn, iters in (("3 Danby4, fresh dsincos", solve_kepler, 3),
                         ("3 Danby4, addition reuse", solve_kepler_reuse, 3)):
    row = f"  {label:<34}"
    for e in (0.0, 0.2, 0.4, 0.6, 0.8, 0.9):
        mx = max(abs(fn(M, e, iters)[0] - REF[e][i]) for i, M in enumerate(MS))
        row += f"{mx*AU:>11.2e}"
    print(row)

print()
print("  Consistency of the returned (sinE, cosE) with E:")
worst = 0.0
for e in (0.0, 0.3, 0.6, 0.9):
    for M in MS:
        E, sE, cE = solve_kepler(M, e, 3)
        worst = max(worst, abs(sE*sE + cE*cE - 1.0))
        # residual of Kepler's equation itself, the invariant that matters
print(f"  max |sinE^2+cosE^2-1| = {worst:.3e}")
worstres = 0.0
for e in (0.0, 0.3, 0.6, 0.9):
    for M in MS:
        E, sE, cE = solve_kepler(M, e, 3)
        worstres = max(worstres, abs(E - e*sE - M))
print(f"  max |E - e sinE - M| (Kepler residual) = {worstres:.3e} rad")
