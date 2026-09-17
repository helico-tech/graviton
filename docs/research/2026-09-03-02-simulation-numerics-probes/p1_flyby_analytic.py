"""
P1: Analytic hyperbolic-flyby deflection, to confirm or correct the table in
docs/domain/signal-delay-and-uncertainty.md section 6.

Two-body hyperbolic encounter, periapsis at r_p, speed at infinity v_inf:
    e         = 1 + r_p * v_inf^2 / mu
    sin(th/2) = 1 / e            (th = total deflection of the asymptote)
    v_p       = sqrt(v_inf^2 + 2*mu/r_p)
    dv_vec    = 2 * v_inf * sin(th/2)     (magnitude of the velocity change)
Reference: Bate/Mueller/White, "Fundamentals of Astrodynamics", ch. 1 & 7;
Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed. sec. 12.4.
"""
import math

MU_SUN  = 1.32712440018e20
BODIES = {
    # name          mu (m^3/s^2)        radius (m)
    "Jupiter-class": (1.26686534e17,    7.1492e7),
    "Earth-class":   (3.986004418e14,   6.3781e6),
    "Saturn-class":  (3.7931187e16,     6.0268e7),
    "Neptune-class": (6.836529e15,      2.4764e7),
    "Luna-class":    (4.9048695e12,     1.7374e6),
}

def flyby(mu, rp, vinf):
    e = 1.0 + rp * vinf * vinf / mu
    half = math.asin(1.0 / e)
    th = 2.0 * half
    vp = math.sqrt(vinf * vinf + 2.0 * mu / rp)
    dv = 2.0 * vinf * math.sin(half)
    # time from periapsis to r = 100 * rp, for a sense of encounter duration
    a = -mu / (vinf * vinf)                  # negative semi-major axis
    return e, math.degrees(th), vp, dv, a

print("=" * 78)
print("P1a  Deflection at periapsis = 1 body radius (grazing pass)")
print("=" * 78)
print(f"{'body':<14}{'v_inf km/s':>11}{'e':>10}{'defl deg':>10}{'v_peri km/s':>13}{'|dv| km/s':>11}")
for name, (mu, R) in BODIES.items():
    for vk in (50.0, 100.0, 150.0, 200.0, 300.0):
        e, th, vp, dv, a = flyby(mu, R, vk * 1e3)
        print(f"{name:<14}{vk:>11.0f}{e:>10.4f}{th:>10.3f}{vp/1e3:>13.2f}{dv/1e3:>11.3f}")
    print()

print("=" * 78)
print("P1b  Doc table check: Jupiter-class, periapsis = 1 R_J")
print("=" * 78)
mu, R = BODIES["Jupiter-class"]
doc = {100.0: 17.3, 200.0: 4.9, 300.0: 2.2}
for vk, claimed in doc.items():
    e, th, vp, dv, a = flyby(mu, R, vk * 1e3)
    print(f"  v_inf = {vk:5.0f} km/s : computed {th:7.3f} deg, doc says {claimed:5.1f} deg"
          f"  -> {'MATCH' if abs(th - claimed) < 0.05 else 'MISMATCH'}")

print()
print("=" * 78)
print("P1c  Sensitivity: is the doc table 'v at infinity' or 'v at periapsis'?")
print("=" * 78)
# If the quoted 'cruise speed' were the periapsis speed instead, deflection differs.
for vk in (100.0, 200.0, 300.0):
    vp_target = vk * 1e3
    vinf2 = vp_target ** 2 - 2.0 * mu / R
    if vinf2 <= 0:
        print(f"  v_peri = {vk:5.0f} km/s : captured (v_inf imaginary)")
        continue
    vinf = math.sqrt(vinf2)
    e, th, vp, dv, a = flyby(mu, R, vinf)
    print(f"  v_peri = {vk:5.0f} km/s -> v_inf {vinf/1e3:7.2f} km/s, deflection {th:7.3f} deg")

print()
print("=" * 78)
print("P1d  Lever check: usable delta-v equivalent of one grazing Jupiter pass")
print("=" * 78)
for vk in (50.0, 100.0, 200.0, 300.0):
    e, th, vp, dv, a = flyby(mu, R, vk * 1e3)
    print(f"  v_inf {vk:5.0f} km/s : deflection {th:6.2f} deg, free |dv| = {dv/1e3:7.2f} km/s")

print()
print("=" * 78)
print("P1e  Encounter timescale (how long the tight part of a flyby lasts)")
print("=" * 78)
print(f"{'body':<14}{'v_inf':>8}{'r_p':>12}{'t(r<10rp) s':>14}{'t(r<3rp) s':>13}")
for name, (mu, R) in (("Jupiter-class", BODIES["Jupiter-class"]),
                      ("Earth-class",   BODIES["Earth-class"])):
    for vk in (100.0, 200.0, 300.0):
        vinf = vk * 1e3
        rp = R
        e = 1.0 + rp * vinf * vinf / mu
        a = -mu / (vinf * vinf)   # a < 0
        aa = -a                   # |a|
        def t_of_r(r):
            # hyperbolic Kepler: r = aa*(e*cosh(H) - 1); M = e*sinh(H) - H; t = M*sqrt(aa^3/mu)
            ch = (r / aa + 1.0) / e
            H = math.acosh(ch)
            M = e * math.sinh(H) - H
            return M * math.sqrt(aa ** 3 / mu)
        print(f"{name:<14}{vk:>8.0f}{rp/1e3:>12.0f}{2*t_of_r(10*rp):>14.1f}{2*t_of_r(3*rp):>13.1f}")
