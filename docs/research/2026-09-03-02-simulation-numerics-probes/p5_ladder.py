"""
P5: substep-ladder validation.

Cost model is EPHEMERIS EVALUATIONS, not accel() calls: in Graviton one
ephemeris evaluation (6 Kepler solves) serves every dynamic object at that
instant, so it is the dominant cost.
  velocity Verlet KDK : 1 per step (end-of-step force reused next step)
  Yoshida4 (3 x KDK)  : 3 per step
  PEFRL               : 4 per step
  RK4                 : 4 per step

Ladders
  none        L = 0
  doc         L = clamp(floor(log2(r_ref/r)), 0, Lmax)        docs/domain rule 4
  dyn         smallest L with 4^L r^3 >= mu*(dt/eta)^2        dynamical time
  cross       smallest L with (dt/2^L) v <= zeta*r            crossing time
  dyn+cross   max of the two
"""
import math, sys
sys.path.insert(0, "/tmp/claude-1000/-data-workspaces-graviton/7c7024cb-f4e8-4a5f-afde-578dfab9af2c/scratchpad/research/sim-probe")
from p4_integrator import (MU_J, R_J, MU_E, R_E, MU_S, R_S, hyper_state, t_at_r,
                           level_doc, level_dyn, level_cross,
                           step_verlet, step_yoshida4, step_pefrl, step_rk4)

EPH_COST = {"verlet": 1, "yoshida4": 3, "pefrl": 4, "rk4": 4}
STEPPERS = {"verlet": step_verlet, "yoshida4": step_yoshida4,
            "pefrl": step_pefrl, "rk4": step_rk4}
DAY = 86400.0

def pick(r, v, ladder, dt, Lmax, k_dyn, eta, zeta, r_ref):
    if ladder == "none":      return 0
    if ladder == "doc":       return level_doc(r, r_ref, Lmax)
    if ladder == "dyn":       return level_dyn(r, k_dyn, Lmax)
    if ladder == "cross":     return level_cross(r, v, dt, zeta, Lmax)
    return max(level_dyn(r, k_dyn, Lmax), level_cross(r, v, dt, zeta, Lmax))

def run(mu, rp, vinf, dt, integ, ladder, Lmax, eta=0.05, zeta=0.02,
        r_ref=1e10, r_start_mult=300.0):
    stepper = STEPPERS[integ]
    k_dyn = mu * (dt / eta) ** 2
    r_start = r_start_mult * rp
    t0 = -t_at_r(mu, rp, vinf, r_start); t1 = -t0
    x, y, vx, vy, _, _ = hyper_state(mu, rp, vinf, t0)
    t = t0; substeps = 0; Lseen = 0
    while t < t1 - 1e-9:
        h_tick = min(dt, t1 - t)
        r = math.sqrt(x*x + y*y); v = math.sqrt(vx*vx + vy*vy)
        L = pick(r, v, ladder, dt, Lmax, k_dyn, eta, zeta, r_ref)
        Lseen = max(Lseen, L); n = 1 << L; h = h_tick / n
        for _ in range(n):
            x, y, vx, vy, _ = stepper(x, y, vx, vy, h, mu)
        substeps += n; t += h_tick
    ex, ey, evx, evy, _, _ = hyper_state(mu, rp, vinf, t)
    return (math.hypot(x - ex, y - ey), math.hypot(vx - evx, vy - evy),
            substeps * EPH_COST[integ], Lseen)

BAR = 1.0   # km of downstream miss accumulated over 10 further days

print("=" * 116)
print("P5a  Ladder comparison at base dt = 60 s with PEFRL. eta = 0.05, zeta = 0.02,")
print("     doc r_ref = 1e7 km (the value in the docs/domain worked example).")
print("     Grazing flyby, periapsis = 1 body radius. Bar: miss over a further 10 d < 1 km.")
print("=" * 116)
print(f"{'body':<9}{'v_inf':>6}  {'ladder':<10}{'Lmax':>5}{'L max used':>11}"
      f"{'eph evals':>11}{'rel cost':>10}{'|dv| m/s':>12}{'miss@10d km':>13}{'':>6}")
for body, mu, rp in (("Jupiter", MU_J, R_J), ("Saturn", MU_S, R_S), ("Earth", MU_E, R_E)):
    for vk in (100e3, 200e3, 300e3):
        base = None
        for ladder, Lmax in (("none", 0), ("dyn", 10), ("cross", 10),
                             ("dyn+cross", 6), ("dyn+cross", 10), ("doc", 10)):
            dp, dv, cost, L = run(mu, rp, vk, 60.0, "pefrl", ladder, Lmax)
            if base is None: base = cost
            miss = dv * 10 * DAY / 1e3
            print(f"{body:<9}{vk/1e3:>6.0f}  {ladder:<10}{Lmax:>5}{L:>11}{cost:>11}"
                  f"{cost/base:>10.2f}{dv:>12.3e}{miss:>13.3e}"
                  f"{'  ok' if miss < BAR else '  FAIL':>6}")
        print()

print("=" * 116)
print("P5b  Tuning zeta (crossing-time coefficient) with eta = 0.05, dt = 60 s, PEFRL,")
print("     dyn+cross ladder, Lmax = 10. Worst case over the three bodies x three speeds.")
print("=" * 116)
print(f"{'zeta':>7}{'worst miss@10d km':>20}{'worst L':>9}{'worst rel cost':>16}")
for zeta in (0.5, 0.25, 0.125, 0.0625, 0.03125, 0.02, 0.015625, 0.0078125):
    worst_miss = 0.0; worst_L = 0; worst_rc = 0.0
    for mu, rp in ((MU_J, R_J), (MU_S, R_S), (MU_E, R_E)):
        for vk in (100e3, 200e3, 300e3):
            b = run(mu, rp, vk, 60.0, "pefrl", "none", 0)[2]
            dp, dv, cost, L = run(mu, rp, vk, 60.0, "pefrl", "dyn+cross", 10, zeta=zeta)
            worst_miss = max(worst_miss, dv * 10 * DAY / 1e3)
            worst_L = max(worst_L, L); worst_rc = max(worst_rc, cost / b)
    print(f"{zeta:>7.4f}{worst_miss:>20.3e}{worst_L:>9}{worst_rc:>16.2f}")

print()
print("=" * 116)
print("P5c  Base timestep sweep, PEFRL + dyn+cross(eta=0.05, zeta=0.0625), Lmax = 10")
print("=" * 116)
print(f"{'body':<9}{'v_inf':>6}{'dt':>6}{'L used':>8}{'eph evals':>11}{'|dv| m/s':>12}{'miss@10d km':>13}{'':>6}")
for body, mu, rp in (("Jupiter", MU_J, R_J), ("Earth", MU_E, R_E)):
    for vk in (100e3, 300e3):
        for dt in (10.0, 30.0, 60.0, 120.0, 300.0):
            dp, dv, cost, L = run(mu, rp, vk, dt, "pefrl", "dyn+cross", 10, zeta=0.0625)
            miss = dv * 10 * DAY / 1e3
            print(f"{body:<9}{vk/1e3:>6.0f}{dt:>6.0f}{L:>8}{cost:>11}{dv:>12.3e}{miss:>13.3e}"
                  f"{'  ok' if miss < BAR else '  FAIL':>6}")
        print()

print("=" * 116)
print("P5d  Verlet with the same ladder, for comparison (is 4th order actually needed?)")
print("=" * 116)
print(f"{'integrator':<10}{'body':<9}{'v_inf':>6}{'zeta':>8}{'L used':>8}{'eph evals':>11}{'miss@10d km':>13}{'':>6}")
for integ in ("verlet", "pefrl"):
    for zeta in (0.0625, 0.015625, 0.00390625, 0.0009765625):
        worst = 0.0; wl = 0; wc = 0
        for mu, rp, nm in ((MU_J, R_J, "Jupiter"), (MU_E, R_E, "Earth")):
            for vk in (100e3, 300e3):
                dp, dv, cost, L = run(mu, rp, vk, 60.0, integ, "dyn+cross", 14, zeta=zeta)
                m = dv * 10 * DAY / 1e3
                if m > worst: worst, wl, wc, wb, wv = m, L, cost, nm, vk
        print(f"{integ:<10}{wb:<9}{wv/1e3:>6.0f}{zeta:>8.5f}{wl:>8}{wc:>11}{worst:>13.3e}"
              f"{'  ok' if worst < BAR else '  FAIL':>6}")
    print()

print("=" * 116)
print("P5e  Slow-object case: a debris chunk on a near-circular orbit at 1.5 body radii.")
print("     The crossing criterion is weak here; the dynamical criterion must carry it.")
print("=" * 116)
def run_circular(mu, r0, dt, integ, ladder, Lmax, eta=0.05, zeta=0.0625, norbits=20):
    stepper = STEPPERS[integ]; k_dyn = mu * (dt / eta) ** 2
    T = 2 * math.pi * math.sqrt(r0 ** 3 / mu)
    x, y, vx, vy = r0, 0.0, 0.0, math.sqrt(mu / r0)
    t = 0.0; tend = norbits * T; substeps = 0; Lseen = 0
    while t < tend - 1e-9:
        h_tick = min(dt, tend - t)
        r = math.sqrt(x*x + y*y); v = math.sqrt(vx*vx + vy*vy)
        L = pick(r, v, ladder, dt, Lmax, k_dyn, eta, zeta, 1e10)
        Lseen = max(Lseen, L); n = 1 << L; h = h_tick / n
        for _ in range(n):
            x, y, vx, vy, _ = stepper(x, y, vx, vy, h, mu)
        substeps += n; t += h_tick
    # exact: same radius, phase = 2*pi*norbits
    ang = math.sqrt(mu / r0 ** 3) * t
    ex, ey = r0 * math.cos(ang), r0 * math.sin(ang)
    return math.hypot(x - ex, y - ey), math.hypot(math.hypot(x, y) - r0, 0.0), substeps * EPH_COST[integ], Lseen, T
print(f"{'body':<9}{'r0':>10}{'period s':>11}{'ladder':<11}{'L used':>8}{'eph evals':>11}"
      f"{'pos err m':>12}{'radial drift m':>16}")
for body, mu, rp in (("Jupiter", MU_J, R_J), ("Earth", MU_E, R_E)):
    r0 = 1.5 * rp
    for ladder in ("none", "cross", "dyn", "dyn+cross"):
        dp, dr, cost, L, T = run_circular(mu, r0, 60.0, "pefrl", ladder, 10)
        print(f"{body:<9}{r0/1e6:>9.1f}M{T:>11.0f}{ladder:<11}{L:>8}{cost:>11}{dp:>12.3e}{dr:>16.3e}")
    print()
