"""
P9a: exposure with a core radius (fixes the divergence at the contact) and
     per-substep CLOSED-FORM accumulation (removes the ladder's stiffness).
P9b: uncertainty box, reachable set, and intercept confidence.
"""
import math

# ============================================================ P9a
def rate_core(r, b, k, chi0, rc):
    re = r if r > rc else rc
    s = min(1.0, b / re)
    return k / (re * re) * (chi0 + (1.0 - chi0) * s)

def E_radial(v, k, chi0, rc, R):
    """Head-on: radial approach from R down to the core, then across the core."""
    return (k * chi0 / v) * ((1.0 / rc - 1.0 / R) + 1.0 / rc)

def E_pass(b, v, R, k, chi0, rc):
    """Straight pass, closed form, with the core flattening the peak."""
    if b >= R: return 0.0
    if b >= rc:
        L = math.sqrt(R * R - b * b)
        I2 = (2.0 / (b * v)) * math.atan(L / b)
        I3 = (2.0 / (b * b * v)) * (L / R)
        return k * (chi0 * I2 + (1.0 - chi0) * b * I3)
    # b < rc: split at r = rc
    L  = math.sqrt(R * R - b * b)
    Lc = math.sqrt(rc * rc - b * b)
    I2 = (2.0 / (b * v)) * (math.atan(L / b) - math.atan(Lc / b))
    I3 = (2.0 / (b * b * v)) * (L / R - Lc / rc)
    outer = k * (chi0 * I2 + (1.0 - chi0) * b * I3)
    inner = (2.0 * Lc / v) * k / (rc * rc) * (chi0 + (1.0 - chi0) * b / rc)
    return outer + inner

# per-substep closed-form accumulation: within one substep treat the path as a
# straight chord and integrate exactly between the two endpoint parameters
def dE_substep(r0, r1, b, v, k, chi0, rc):
    """Exposure over one substep, given the along-track coordinates s0, s1
       measured from closest approach.  r_i = hypot(b, s_i)."""
    s0 = math.copysign(math.sqrt(max(0.0, r0 * r0 - b * b)), r0)
    s1 = math.copysign(math.sqrt(max(0.0, r1 * r1 - b * b)), r1)
    be = max(b, 1.0)
    a2 = (math.atan(s1 / be) - math.atan(s0 / be)) / (be * v)
    a3 = (s1 / math.sqrt(be*be + s1*s1) - s0 / math.sqrt(be*be + s0*s0)) / (be * be * v)
    return k * (chi0 * a2 + (1.0 - chi0) * be * a3)

R = 3.0e7; chi0 = 0.25
K_target = 6.0e11
k = K_target / (chi0 * math.pi + 2.0 * (1.0 - chi0))
rc = 5.0e5

print("=" * 104)
print("P9a  Exposure with a core radius r_core. Divergence at the contact removed.")
print(f"     k = {k:.4e} m^2/s, chi0 = {chi0}, R_halo = {R/1e3:.0f} km, r_core = {rc/1e3:.0f} km")
print("=" * 104)
print("  Head-on impactor (radial approach all the way in):")
print(f"{'v (km/s)':>10}{'E at impact':>14}{'outcome':>12}")
for vk in (100, 150, 200, 250, 260, 300, 400):
    e = E_radial(vk * 1e3, k, chi0, rc, R)
    print(f"{vk:>10}{e:>14.3f}{('LOST' if e >= 1.0 else 'survives'):>12}")
print()
print("  Oblique pass (probe not aimed at the contact):")
hdr = f"{'b (km)':>9}"
for vk in (50, 100, 150, 200, 300, 500): hdr += f"{('v='+str(vk)):>9}"
print(hdr + "     E; >= 1.000 = probe lost")
for bkm in (0, 100, 500, 1000, 2000, 3000, 5000, 10000, 20000):
    row = f"{bkm:>9}"
    for vk in (50, 100, 150, 200, 300, 500):
        e = E_pass(max(bkm, 1) * 1e3, vk * 1e3, R, k, chi0, rc)
        row += f"{e:>9.3f}"
    print(row)

print()
print("=" * 104)
print("P9b  Per-substep closed-form accumulation vs point sampling, dt = 60 s")
print("     Point sampling: E += rate(r_mid) * h.   Closed form: E += dE_substep(r0, r1).")
print("=" * 104)
print(f"{'b (km)':>8}{'v':>6}{'E exact':>10}", end="")
for L in (0, 2, 4, 6): print(f"{('pt L='+str(L)):>11}{('cf L='+str(L)):>11}", end="")
print()
for bkm, vk in ((3000, 200), (1000, 200), (300, 300), (100, 300)):
    b = bkm * 1e3; v = vk * 1e3
    ex = E_pass(b, v, R, k, chi0, rc)
    print(f"{bkm:>8}{vk:>6}{ex:>10.4f}", end="")
    Lm = math.sqrt(R*R - b*b); T = Lm / v
    for L in (0, 2, 4, 6):
        h = 60.0 / (1 << L)
        n = int(2 * T / h)
        pt = 0.0; cf = 0.0
        s = -T
        for i in range(n):
            t0 = -T + i * h; t1 = t0 + h
            pt += rate_core(math.hypot(b, v * (t0 + 0.5 * h)), b, k, chi0, rc) * h
            cf += dE_substep(math.copysign(math.hypot(b, v*t0), v*t0),
                             math.copysign(math.hypot(b, v*t1), v*t1), max(b, rc if b < rc else b),
                             v, k, chi0, rc) if False else dE_substep(
                             math.copysign(math.hypot(b, v*t0), v*t0),
                             math.copysign(math.hypot(b, v*t1), v*t1), b, v, k, chi0, rc)
        print(f"{pt:>11.4f}{cf:>11.4f}", end="")
    print()

# ============================================================ P9c
C = 299792458.0
print()
print("=" * 104)
print("P9c  Uncertainty box and reachable set. The docs' r_reach is a factor ~2 low.")
print("=" * 104)
print("  r_stale = 0.5 * a_c * tau^2                                       (docs, correct)")
print("  r_meas  = sigma_ang * d(C, nearest observer)                      (docs, correct)")
print("  r_box   = r_stale + r_meas                                        (docs, correct)")
print()
print("  docs:      r_reach = 0.5 * min(a_max, dv/t_go) * t_go^2")
print("  corrected: r_reach = dv * (t_go - dv/(2*a_max))     if dv <= a_max*t_go")
print("             r_reach = 0.5 * a_max * t_go^2           otherwise")
print()
print("  The docs' formula assumes thrust spread evenly over the whole interval,")
print("  which is the worst way to spend the budget. Correcting once, as early as")
print("  the information allows, displaces the impact point twice as far.")
print()
def reach_docs(dv, tgo, amax): return 0.5 * min(amax, dv / tgo) * tgo * tgo
def reach_corr(dv, tgo, amax):
    if dv <= amax * tgo: return dv * (tgo - dv / (2.0 * amax))
    return 0.5 * amax * tgo * tgo
print(f"{'dv (m/s)':>10}{'t_go (s)':>10}{'a_max':>8}{'docs (km)':>13}{'corrected (km)':>16}{'ratio':>8}")
for dv, tgo, amax in ((500, 3600, 3.0), (500, 600, 3.0), (2000, 3600, 3.0),
                      (2000, 600, 3.0), (5000, 1200, 3.0), (100, 7200, 0.5),
                      (5000, 600, 3.0), (20000, 600, 3.0)):
    d = reach_docs(dv, tgo, amax); c2 = reach_corr(dv, tgo, amax)
    print(f"{dv:>10}{tgo:>10}{amax:>8.1f}{d/1e3:>13.1f}{c2/1e3:>16.1f}{c2/d:>8.2f}")

print()
print("=" * 104)
print("P9d  Intercept confidence: area of the box disc covered by the reach disc.")
print("     conf = area(B & Rd) / area(B), both centred on the predicted contact")
print("     position, so in v1 they are concentric and the formula collapses.")
print("=" * 104)
def lens_area(r1, r2, d):
    """Area of intersection of two discs, radii r1 r2, centre separation d."""
    if d >= r1 + r2: return 0.0
    if d <= abs(r1 - r2): return math.pi * min(r1, r2) ** 2
    a1 = math.acos((d*d + r1*r1 - r2*r2) / (2*d*r1))
    a2 = math.acos((d*d + r2*r2 - r1*r1) / (2*d*r2))
    return r1*r1*(a1 - math.sin(2*a1)/2) + r2*r2*(a2 - math.sin(2*a2)/2)
def confidence(r_box, r_reach, d_offset):
    if r_box <= 0.0: return 1.0
    return lens_area(r_box, r_reach, d_offset) / (math.pi * r_box * r_box)
print(f"{'r_reach/r_box':>15}{'offset/r_box':>14}{'confidence':>12}")
for ratio in (0.25, 0.5, 0.75, 1.0, 1.5, 2.0):
    for off in (0.0, 0.5, 1.0):
        print(f"{ratio:>15.2f}{off:>14.2f}{confidence(1.0, ratio, off if off > 0 else 1e-300):>12.4f}")
print()
print("  Concentric case (offset = 0) reduces to min(1, (r_reach/r_box)^2), which")
print("  needs no inverse trig at all. The lens formula is only needed once the")
print("  nominal aim point is offset from the predicted contact position, which")
print("  happens as soon as the probe has spent part of its budget.")
print()
print("  acos is not a separate kernel: acos(x) = datan2(sqrt(1 - x*x), x).")
print()
print("=" * 104)
print("P9e  r_box floor for the campaign's range bands, and what covers it")
print("=" * 104)
print(f"{'range (lm)':>11}{'round trip s':>14}{'r_stale @1g km':>16}"
      f"{'dv for 100% at t_go=600s':>26}{'dv docs formula':>18}")
for lm in (5, 10, 20, 40):
    tau = 2.0 * lm * 60.0
    rs = 0.5 * 10.0 * tau * tau
    tgo = 600.0; amax = 3.0
    # solve reach_corr(dv) = rs
    lo, hi = 0.0, 1e7
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if reach_corr(mid, tgo, amax) < rs: lo = mid
        else: hi = mid
    dv_corr = 0.5 * (lo + hi)
    lo, hi = 0.0, 1e9
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if reach_docs(mid, tgo, amax) < rs: lo = mid
        else: hi = mid
    dv_docs = 0.5 * (lo + hi)
    print(f"{lm:>11}{tau:>14.0f}{rs/1e3:>16.0f}{dv_corr/1e3:>23.1f} km/s"
          f"{dv_docs/1e3:>15.1f} km/s")
print()
print("  At 20 and 40 light-minutes the thrust limit binds and no delta-v closes the")
print("  box in ten minutes. That is the design's own point: past a certain range the")
print("  answer has to be a conditional clause or a wave, not more propellant.")
