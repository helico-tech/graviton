"""
P8: exposure model.

    rate(r, psi) = k / r^2 * chi(psi)          for r <= R_halo, else 0
    chi(psi)     = chi0 + (1 - chi0) * |sin psi|

psi is the angle between the probe's long axis (slaved to its velocity) and the
line to the source, so |sin psi| = b/r on a straight-line pass with miss
distance b. chi0 = A_nose / A_side.

Closed form for a straight pass at speed v, miss distance b, through a halo of
radius R (b <= R), integrating over the full chord:

    I2 = INT dt / r^2   = (2 / (b v)) * atan(L / b),        L = sqrt(R^2 - b^2)
    I3 = INT dt / r^3   = (2 / (b^2 v)) * (L / R)

    E(b, v) = (k / (b v)) * [ 2 chi0 atan(L/b) + 2 (1 - chi0) L / R ]

Deep-pass limit R >> b:

    E  ->  (k / (b v)) * [ chi0 * pi + 2 (1 - chi0) ]  ==  K / (b v)
    K  =  k * (chi0 * pi + 2 * (1 - chi0))

so survivability is a single hyperbola  b * v = K  in the plane the planner
draws. A terminating pass (the probe hits at r_hit instead of passing through)
carries half the chord plus the near-target tail:

    E_hit(v) = (k / v) * (1 / r_hit - 1 / R) * chi0  +  (grazing term)
"""
import math

def rate(r, b, k, chi0):
    if r <= 0: return float('inf')
    s = min(1.0, b / r)
    return k / (r * r) * (chi0 + (1.0 - chi0) * s)

def exposure_numeric(b, v, R, k, chi0, n=4_000_001):
    """Trapezoid over the chord, deliberately over-resolved."""
    if b >= R: return 0.0
    L = math.sqrt(R * R - b * b)
    T = L / v
    h = 2 * T / (n - 1)
    tot = 0.0
    for i in range(n):
        t = -T + i * h
        r = math.hypot(b, v * t)
        w = 0.5 if (i == 0 or i == n - 1) else 1.0
        tot += w * rate(r, b, k, chi0)
    return tot * h

def exposure_closed(b, v, R, k, chi0):
    if b >= R: return 0.0
    L = math.sqrt(R * R - b * b)
    I2 = (2.0 / (b * v)) * math.atan(L / b)
    I3 = (2.0 / (b * b * v)) * (L / R)
    return k * (chi0 * I2 + (1.0 - chi0) * b * I3)

print("=" * 100)
print("P8a  Closed form vs over-resolved numerical integration")
print("=" * 100)
R = 3.0e7; k = 2.63e11; chi0 = 0.25
print(f"  R_halo = {R/1e3:.0f} km, k = {k:.3e} m^2/s, chi0 = {chi0}")
print(f"{'b (km)':>10}{'v (km/s)':>10}{'E closed':>14}{'E numeric':>14}{'rel diff':>12}")
for bkm in (300.0, 1000.0, 3000.0, 10000.0, 25000.0):
    for vk in (100.0, 300.0):
        b = bkm * 1e3; v = vk * 1e3
        ec = exposure_closed(b, v, R, k, chi0)
        en = exposure_numeric(b, v, R, k, chi0, 400001)
        print(f"{bkm:>10.0f}{vk:>10.0f}{ec:>14.6f}{en:>14.6f}{abs(ec-en)/en:>12.2e}")

print()
print("=" * 100)
print("P8b  Deep-pass constant K and the lethal-miss hyperbola  b*v = K")
print("=" * 100)
K = k * (chi0 * math.pi + 2.0 * (1.0 - chi0))
print(f"  K = k*(chi0*pi + 2*(1-chi0)) = {K:.4e} m^2/s")
print(f"{'v (km/s)':>10}{'b_lethal (km)':>16}{'E at b=3000 km':>17}{'E at b=10000 km':>18}")
for vk in (50.0, 100.0, 150.0, 200.0, 250.0, 300.0):
    v = vk * 1e3
    bl = K / v
    print(f"{vk:>10.0f}{bl/1e3:>16.0f}{exposure_closed(3.0e6, v, R, k, chi0):>17.3f}"
          f"{exposure_closed(1.0e7, v, R, k, chi0):>18.3f}")

print()
print("=" * 100)
print("P8c  Calibrating k from a chosen reference pass.")
print("     Design intent: at 200 km/s a 3000 km miss is exactly lethal (E = 1).")
print("=" * 100)
b_ref, v_ref = 3.0e6, 2.0e5
K_target = b_ref * v_ref
k_cal = K_target / (chi0 * math.pi + 2.0 * (1.0 - chi0))
print(f"  K_target = b_ref * v_ref = {K_target:.4e} m^2/s")
print(f"  k        = {k_cal:.4e} m^2/s   (for chi0 = {chi0})")
print(f"  rate at 1000 km from the source, broadside: "
      f"{rate(1.0e6, 1.0e6, k_cal, chi0):.4e} per second")
print(f"  time to E = 1 hovering at 1000 km broadside: "
      f"{1.0/rate(1.0e6, 1.0e6, k_cal, chi0):.1f} s")
print()
print(f"{'v (km/s)':>10}{'b_lethal (km)':>15}{'as multiple of r_box(5 lm, 1 g) = 1800 km':>44}")
for vk in (100.0, 150.0, 200.0, 250.0, 300.0):
    bl = K_target / (vk * 1e3)
    print(f"{vk:>10.0f}{bl/1e3:>15.0f}{bl/1.8e6:>44.2f}")

print()
print("=" * 100)
print("P8d  'Fast oblique survives, slow head-on does not' as a table of E")
print("     k calibrated above, R_halo = 30 000 km, chi0 = 0.25")
print("=" * 100)
hdr = f"{'b (km)':>9}"
for vk in (50, 100, 150, 200, 300): hdr += f"{('v='+str(vk)):>10}"
print(hdr + "     (E; > 1.000 = probe lost)")
for bkm in (500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 29000):
    row = f"{bkm:>9}"
    for vk in (50, 100, 150, 200, 300):
        e = exposure_closed(bkm * 1e3, vk * 1e3, R, k_cal, chi0)
        row += f"{e:>10.3f}" if e < 100 else f"{'--':>10}"
    print(row)

print()
print("=" * 100)
print("P8e  Terminating pass: probe strikes the contact instead of flying past.")
print("     Radial approach from R_halo to r_hit, exposure = (k*chi0/v)*(1/r_hit - 1/R).")
print("=" * 100)
print(f"{'r_hit (km)':>12}", end="")
for vk in (100, 200, 300, 500, 1000): print(f"{('v='+str(vk)):>10}", end="")
print()
for rh in (1.0, 10.0, 50.0, 200.0, 1000.0):
    print(f"{rh:>12.0f}", end="")
    for vk in (100, 200, 300, 500, 1000):
        v = vk * 1e3
        e = (k_cal * chi0 / v) * (1.0 / (rh * 1e3) - 1.0 / R)
        print(f"{e:>10.2f}" if e < 1e4 else f"{'--':>10}", end="")
    print()
print()
print("  -> a probe that actually hits a haloed contact is lost unless the halo is")
print("     weak or the closing speed is very high. That is the intended pressure")
print("     toward expensive high-energy terminal geometry; the level designer tunes")
print("     it by choosing k, not by changing the law.")

print()
print("=" * 100)
print("P8f  Stiffness: how many substeps does accumulating E to 1e-4 accuracy need?")
print("     Trapezoid over the chord at h = dt/2^L, dt = 60 s.")
print("=" * 100)
print(f"{'b (km)':>9}{'v (km/s)':>10}{'E exact':>10}", end="")
for L in (0, 2, 4, 6, 8): print(f"{('L='+str(L)):>12}", end="")
print()
for bkm, vk in ((3000, 200), (1000, 200), (300, 300), (100, 300)):
    b = bkm * 1e3; v = vk * 1e3
    ex = exposure_closed(b, v, R, k_cal, chi0)
    print(f"{bkm:>9}{vk:>10}{ex:>10.4f}", end="")
    for L in (0, 2, 4, 6, 8):
        h = 60.0 / (1 << L)
        L2 = math.sqrt(R * R - b * b); T = L2 / v
        n = int(2 * T / h)
        tot = 0.0
        for i in range(n):
            t = -T + (i + 0.5) * h
            tot += rate(math.hypot(b, v * t), b, k_cal, chi0)
        print(f"{tot*h:>12.4f}", end="")
    print()
