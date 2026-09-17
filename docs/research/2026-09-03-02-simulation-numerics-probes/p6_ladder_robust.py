"""
P6a: the ladder's blind spot. L is chosen from the state at the START of a tick.
     An object that falls a long way inside one tick gets under-refined.
     Fix tested: evaluate the ladder at a PESSIMISTIC radius
        r_probe = max(r - v*dt, r_floor)
     which bounds below the radius reachable inside the tick.

P6b: time-dependent field. Star at the origin plus a Jupiter-class planet on a
     circular 1 AU orbit; the probe grazes the planet. Reference is PEFRL with
     the ladder forced to Lmax = 14 and dt = 1 s, which P4 showed reaches the
     double-precision floor.
"""
import math, sys
sys.path.insert(0, "/tmp/claude-1000/-data-workspaces-graviton/7c7024cb-f4e8-4a5f-afde-578dfab9af2c/scratchpad/research/sim-probe")
from p4_integrator import (MU_J, R_J, MU_E, R_E, hyper_state, t_at_r,
                           level_dyn, level_cross, step_pefrl, step_verlet)
MU_SUN = 1.32712440018e20
AU = 1.495978707e11
DAY = 86400.0

# ---------------------------------------------------------------- P6a
def level_pick(r, v, dt, eta, zeta, k_dyn, Lmax, pessimistic, r_floor):
    rr = max(r - v * dt, r_floor) if pessimistic else r
    return max(level_dyn(rr, k_dyn, Lmax), level_cross(rr, v, dt, zeta, Lmax))

def run_ellipse(mu, rp, ra, dt, Lmax, eta, zeta, pessimistic, norb, phase0):
    """Highly eccentric orbit, start at apoapsis offset by phase0 * dt so that
       periapsis lands mid-tick. Error measured as drift in periapsis radius."""
    a = 0.5 * (rp + ra); e = 1.0 - rp / a
    T = 2 * math.pi * math.sqrt(a ** 3 / mu)
    k_dyn = mu * (dt / eta) ** 2
    # start at apoapsis
    x, y = -ra, 0.0
    vy = -math.sqrt(mu * (1 - e) / (a * (1 + e)))
    vx = 0.0
    E0 = -mu / (2 * a)
    t = phase0 * dt; tend = t + norb * T
    substeps = 0; Lseen = 0; rmin_seen = 1e30
    while t < tend - 1e-9:
        h_tick = min(dt, tend - t)
        r = math.sqrt(x*x + y*y); v = math.sqrt(vx*vx + vy*vy)
        L = level_pick(r, v, dt, eta, zeta, k_dyn, Lmax, pessimistic, rp * 0.5)
        Lseen = max(Lseen, L); n = 1 << L; h = h_tick / n
        for _ in range(n):
            x, y, vx, vy, _ = step_pefrl(x, y, vx, vy, h, mu)
            rr = math.sqrt(x*x + y*y)
            if rr < rmin_seen: rmin_seen = rr
        substeps += n; t += h_tick
    r = math.sqrt(x*x + y*y); v2 = vx*vx + vy*vy
    E = 0.5 * v2 - mu / r
    # specific angular momentum -> osculating periapsis, the number a player would see
    Lz = x * vy - y * vx
    a2 = -mu / (2 * E); e2 = math.sqrt(max(0.0, 1 + 2 * E * Lz * Lz / (mu * mu)))
    rp2 = a2 * (1 - e2)
    return abs(E / E0 - 1.0), rp2 - rp, substeps, Lseen, T

print("=" * 112)
print("P6a  Ladder blind spot: eccentric orbit whose periapsis is crossed inside one tick.")
print("     Earth-class body, periapsis 1.05 R_E, apoapsis 60 R_E, dt = 60 s, PEFRL,")
print("     eta = 0.05, zeta = 1/32, Lmax = 10, 6 orbits, phase offset 0.37 tick.")
print("=" * 112)
print(f"{'ladder eval point':<24}{'L used':>8}{'substeps':>10}{'|dE/E|':>13}{'periapsis drift m':>20}")
for pess in (False, True):
    dE, drp, ns, L, T = run_ellipse(MU_E, 1.05 * R_E, 60 * R_E, 60.0, 10, 0.05, 1/32, pess, 6, 0.37)
    print(f"{('pessimistic r-v*dt' if pess else 'current r'):<24}{L:>8}{ns:>10}{dE:>13.3e}{drp:>20.3e}")
print()
print("     Same, Jupiter-class, periapsis 1.05 R_J, apoapsis 60 R_J:")
print(f"{'ladder eval point':<24}{'L used':>8}{'substeps':>10}{'|dE/E|':>13}{'periapsis drift m':>20}")
for pess in (False, True):
    dE, drp, ns, L, T = run_ellipse(MU_J, 1.05 * R_J, 60 * R_J, 60.0, 10, 0.05, 1/32, pess, 6, 0.37)
    print(f"{('pessimistic r-v*dt' if pess else 'current r'):<24}{L:>8}{ns:>10}{dE:>13.3e}{drp:>20.3e}")

print()
print("     Sensitivity to where the tick boundary falls (the determinism-relevant test):")
print(f"{'phase offset':>14}{'plain |dE/E|':>16}{'pessimistic |dE/E|':>21}")
for ph in (0.0, 0.1, 0.25, 0.37, 0.5, 0.63, 0.9):
    a1 = run_ellipse(MU_E, 1.05*R_E, 60*R_E, 60.0, 10, 0.05, 1/32, False, 6, ph)[0]
    a2 = run_ellipse(MU_E, 1.05*R_E, 60*R_E, 60.0, 10, 0.05, 1/32, True, 6, ph)[0]
    print(f"{ph:>14.2f}{a1:>16.3e}{a2:>21.3e}")

# ---------------------------------------------------------------- P6b
print()
print("=" * 112)
print("P6b  Time-dependent field: star + planet on a circular 1 AU orbit, grazing flyby.")
print("=" * 112)

N_PLANET = math.sqrt(MU_SUN / AU ** 3)          # mean motion, rad/s
def planet_pos(t):
    ang = N_PLANET * t
    return AU * math.cos(ang), AU * math.sin(ang), -AU * N_PLANET * math.sin(ang), AU * N_PLANET * math.cos(ang)

def accel_two(x, y, t):
    ax = ay = 0.0
    r2 = x*x + y*y; r = math.sqrt(r2); k = -MU_SUN / (r2 * r)
    ax += k * x; ay += k * y
    px, py, _, _ = planet_pos(t)
    dx = x - px; dy = y - py
    r2 = dx*dx + dy*dy; r = math.sqrt(r2); k = -MU_J / (r2 * r)
    ax += k * dx; ay += k * dy
    return ax, ay, r

XI = 0.1786178958448091; LAM = -0.2123418310626054; CHI = -0.06626458266981849
def pefrl_t(x, y, vx, vy, t, h):
    x += XI*h*vx; y += XI*h*vy; t1 = t + XI*h
    ax, ay, _ = accel_two(x, y, t1)
    c = (1.0 - 2.0*LAM)*0.5*h; vx += c*ax; vy += c*ay
    x += CHI*h*vx; y += CHI*h*vy; t2 = t1 + CHI*h
    ax, ay, _ = accel_two(x, y, t2)
    vx += LAM*h*ax; vy += LAM*h*ay
    d = (1.0 - 2.0*(CHI+XI))*h; x += d*vx; y += d*vy; t3 = t2 + d
    ax, ay, _ = accel_two(x, y, t3)
    vx += LAM*h*ax; vy += LAM*h*ay
    x += CHI*h*vx; y += CHI*h*vy; t4 = t3 + CHI*h
    ax, ay, _ = accel_two(x, y, t4)
    vx += c*ax; vy += c*ay
    x += XI*h*vx; y += XI*h*vy
    return x, y, vx, vy

def verlet_t(x, y, vx, vy, t, h):
    ax, ay, _ = accel_two(x, y, t)
    vx += 0.5*h*ax; vy += 0.5*h*ay
    x += h*vx; y += h*vy
    ax, ay, _ = accel_two(x, y, t + h)
    vx += 0.5*h*ax; vy += 0.5*h*ay
    return x, y, vx, vy

def run_moving(dt, Lmax, eta, zeta, stepper, vinf, rp_mult=1.0, span_mult=200.0):
    """Probe enters the planet's neighbourhood on a hyperbola relative to the
       planet, offset into the heliocentric frame. Integrate the two-body
       (star + planet) field."""
    rp = rp_mult * R_J
    t0 = -t_at_r(MU_J, rp, vinf, span_mult * rp)
    hx, hy, hvx, hvy, _, _ = hyper_state(MU_J, rp, vinf, t0)
    px, py, pvx, pvy = planet_pos(0.0)
    x, y = px + hx, py + hy
    vx, vy = pvx + hvx, pvy + hvy
    t = t0; tend = -t0
    k_dyn_p = MU_J * (dt / eta) ** 2
    k_dyn_s = MU_SUN * (dt / eta) ** 2
    substeps = 0; Lseen = 0
    while t < tend - 1e-9:
        h_tick = min(dt, tend - t)
        ppx, ppy, ppvx, ppvy = planet_pos(t)
        rp_rel = math.hypot(x - ppx, y - ppy); v_rel = math.hypot(vx - ppvx, vy - ppvy)
        rs = math.hypot(x, y); vs = math.hypot(vx, vy)
        Lp = max(level_dyn(max(rp_rel - v_rel*dt, 0.5*R_J), k_dyn_p, Lmax),
                 level_cross(max(rp_rel - v_rel*dt, 0.5*R_J), v_rel, dt, zeta, Lmax))
        Ls = max(level_dyn(rs, k_dyn_s, Lmax), level_cross(rs, vs, dt, zeta, Lmax))
        L = max(Lp, Ls); Lseen = max(Lseen, L)
        n = 1 << L; h = h_tick / n
        for _ in range(n):
            x, y, vx, vy = stepper(x, y, vx, vy, t, h)
            t += h
        substeps += n
    return x, y, vx, vy, substeps, Lseen

print("  Reference: PEFRL, dt = 1 s, Lmax = 14, zeta = 1/64 (P4 showed this is at the")
print("  double-precision floor for the static problem).")
import time
t0 = time.time()
REF = run_moving(1.0, 14, 0.05, 1/64, pefrl_t, 2e5, span_mult=200.0)
print(f"  reference took {time.time()-t0:.1f} s, {REF[4]} substeps, Lmax used {REF[5]}\n")
rx, ry, rvx, rvy = REF[0], REF[1], REF[2], REF[3]
print(f"{'integrator':<9}{'dt':>6}{'zeta':>9}{'Lmax':>6}{'L used':>8}{'substeps':>10}"
      f"{'|dx| m':>12}{'|dv| m/s':>12}{'miss@10d km':>13}{'':>6}")
for stepper, nm in ((pefrl_t, "pefrl"), (verlet_t, "verlet")):
    for dt in (60.0, 30.0):
        for zeta in (1/16, 1/32, 1/64):
            r = run_moving(dt, 12, 0.05, zeta, stepper, 2e5, span_mult=200.0)
            dp = math.hypot(r[0]-rx, r[1]-ry); dv = math.hypot(r[2]-rvx, r[3]-rvy)
            miss = dv * 10 * DAY / 1e3
            print(f"{nm:<9}{dt:>6.0f}{zeta:>9.5f}{12:>6}{r[5]:>8}{r[4]:>10}"
                  f"{dp:>12.3e}{dv:>12.3e}{miss:>13.3e}{'  ok' if miss < 1.0 else '  FAIL':>6}")
    print()
