"""
P4: integrator comparison and substep-ladder validation.

Reference is the EXACT hyperbolic Kepler solution (universal-variable-free,
hyperbolic anomaly), so there is no reference-integrator error to confound the
measurement.

Metric of record is not local truncation error but DOWNSTREAM MISS: the
distance by which the probe's impact point moves, days later, because of the
error the flyby introduced. That is the number the game cares about.
"""
import math

MU_J = 1.26686534e17;  R_J = 7.1492e7      # Jupiter-class
MU_E = 3.986004418e14; R_E = 6.3781e6      # Earth-class
MU_S = 3.7931187e16;   R_S = 6.0268e7      # Saturn-class

# ------------------------------------------------------------- exact hyperbola
def hyper_state(mu, rp, vinf, t):
    """State at time t from periapsis, perifocal frame, periapsis on +x."""
    aa = mu / (vinf * vinf)                 # |a|
    e = 1.0 + rp / aa
    n = math.sqrt(mu / (aa ** 3))
    M = n * t
    # solve M = e sinh H - H  (double precision, iterate to convergence: reference only)
    H = math.asinh(M / e) if abs(M) < 1e3 else math.copysign(math.log(2.0*abs(M)/e + 1.8), M)
    for _ in range(200):
        f = e * math.sinh(H) - H - M
        fp = e * math.cosh(H) - 1.0
        d = -f / fp
        H += d
        if abs(d) < 1e-16 * max(1.0, abs(H)):
            break
    ch, sh = math.cosh(H), math.sinh(H)
    r = aa * (e * ch - 1.0)
    x = aa * (e - ch)
    y = aa * math.sqrt(e * e - 1.0) * sh
    k = math.sqrt(mu * aa) / r
    vx = -k * sh
    vy = k * math.sqrt(e * e - 1.0) * ch
    return x, y, vx, vy, r, e

def t_at_r(mu, rp, vinf, r):
    aa = mu / (vinf * vinf); e = 1.0 + rp / aa
    H = math.acosh((r / aa + 1.0) / e)
    return (e * math.sinh(H) - H) / math.sqrt(mu / aa ** 3)

# -------------------------------------------------------------- force (static)
def accel_single(x, y, mu):
    r2 = x * x + y * y
    r = math.sqrt(r2)
    k = -mu / (r2 * r)
    return k * x, k * y, r

# ------------------------------------------------------------- the substep ladders
def level_doc(r, r_ref, Lmax):
    """docs/domain: L = clamp(floor(log2(r_ref/r)), 0, Lmax), via comparison loop."""
    L = 0; s = r
    while L < Lmax and s * 2.0 <= r_ref:
        s *= 2.0; L += 1
    return L

def level_dyn(r, k_dyn, Lmax):
    """smallest L with 4^L * r^3 >= k_dyn,  k_dyn = mu*(dt/eta)^2.
       encodes  dt/2^L <= eta * sqrt(r^3/mu)  with no log and no cbrt."""
    L = 0; s = r * r * r
    while L < Lmax and s < k_dyn:
        s *= 4.0; L += 1
    return L

def level_cross(r, v, dt, zeta, Lmax):
    """smallest L with (dt/2^L)*v <= zeta*r."""
    L = 0; s = dt * v
    lim = zeta * r
    while L < Lmax and s > lim:
        s *= 0.5; L += 1
    return L

# ------------------------------------------------------------------ integrators
def step_verlet(x, y, vx, vy, h, mu):
    ax, ay, _ = accel_single(x, y, mu)
    vx += 0.5 * h * ax; vy += 0.5 * h * ay
    x += h * vx; y += h * vy
    ax, ay, _ = accel_single(x, y, mu)
    vx += 0.5 * h * ax; vy += 0.5 * h * ay
    return x, y, vx, vy, 2

W1 = 1.3512071919596576340476878089715
W0 = -1.7024143839193152680953756179429
YOSH = (W1, W0, W1)
def step_yoshida4(x, y, vx, vy, h, mu):
    n = 0
    for w in YOSH:
        hh = w * h
        ax, ay, _ = accel_single(x, y, mu); n += 1
        vx += 0.5 * hh * ax; vy += 0.5 * hh * ay
        x += hh * vx; y += hh * vy
        ax, ay, _ = accel_single(x, y, mu); n += 1
        vx += 0.5 * hh * ax; vy += 0.5 * hh * ay
    return x, y, vx, vy, n

# PEFRL, Omelyan, Mryglod & Folk, Comput. Phys. Commun. 146 (2002) 188
XI    =  0.1786178958448091
LAM   = -0.2123418310626054
CHI   = -0.06626458266981849
def step_pefrl(x, y, vx, vy, h, mu):
    x += XI * h * vx; y += XI * h * vy
    ax, ay, _ = accel_single(x, y, mu)
    vx += (1.0 - 2.0 * LAM) * 0.5 * h * ax; vy += (1.0 - 2.0 * LAM) * 0.5 * h * ay
    x += CHI * h * vx; y += CHI * h * vy
    ax, ay, _ = accel_single(x, y, mu)
    vx += LAM * h * ax; vy += LAM * h * ay
    x += (1.0 - 2.0 * (CHI + XI)) * h * vx; y += (1.0 - 2.0 * (CHI + XI)) * h * vy
    ax, ay, _ = accel_single(x, y, mu)
    vx += LAM * h * ax; vy += LAM * h * ay
    x += CHI * h * vx; y += CHI * h * vy
    ax, ay, _ = accel_single(x, y, mu)
    vx += (1.0 - 2.0 * LAM) * 0.5 * h * ax; vy += (1.0 - 2.0 * LAM) * 0.5 * h * ay
    x += XI * h * vx; y += XI * h * vy
    return x, y, vx, vy, 4

def step_rk4(x, y, vx, vy, h, mu):
    def d(px, py, pvx, pvy):
        ax, ay, _ = accel_single(px, py, mu)
        return pvx, pvy, ax, ay
    k1 = d(x, y, vx, vy)
    k2 = d(x + 0.5*h*k1[0], y + 0.5*h*k1[1], vx + 0.5*h*k1[2], vy + 0.5*h*k1[3])
    k3 = d(x + 0.5*h*k2[0], y + 0.5*h*k2[1], vx + 0.5*h*k2[2], vy + 0.5*h*k2[3])
    k4 = d(x + h*k3[0], y + h*k3[1], vx + h*k3[2], vy + h*k3[3])
    x  += h/6.0 * (k1[0] + 2*k2[0] + 2*k3[0] + k4[0])
    y  += h/6.0 * (k1[1] + 2*k2[1] + 2*k3[1] + k4[1])
    vx += h/6.0 * (k1[2] + 2*k2[2] + 2*k3[2] + k4[2])
    vy += h/6.0 * (k1[3] + 2*k2[3] + 2*k3[3] + k4[3])
    return x, y, vx, vy, 4

INTEGRATORS = [("verlet", step_verlet, 1), ("yoshida4", step_yoshida4, 3),
               ("pefrl", step_pefrl, 4), ("rk4", step_rk4, 4)]

# ------------------------------------------------------------------ the run
def run_flyby(mu, rp, vinf, dt, stepper, ladder, Lmax, r_start_mult=300.0,
              eta=0.05, zeta=0.02, r_ref=None, k_dyn=None):
    """Integrate a grazing flyby from r_start inbound to r_start outbound.
       Returns (dpos_m, dvel_mps, defl_err_rad, force_evals, max_level)."""
    r_start = r_start_mult * rp
    t0 = -t_at_r(mu, rp, vinf, r_start)
    t1 = -t0
    x, y, vx, vy, _, _ = hyper_state(mu, rp, vinf, t0)
    t = t0
    n_force = 0
    Lseen = 0
    nticks = int(math.ceil((t1 - t0) / dt))
    for i in range(nticks):
        h_tick = min(dt, t1 - t)
        if h_tick <= 0: break
        r = math.hypot(x, y); v = math.hypot(vx, vy)
        if ladder == "none":
            L = 0
        elif ladder == "doc":
            L = level_doc(r, r_ref, Lmax)
        elif ladder == "dyn":
            L = level_dyn(r, k_dyn, Lmax)
        elif ladder == "dyn+cross":
            L = max(level_dyn(r, k_dyn, Lmax), level_cross(r, v, dt, zeta, Lmax))
        Lseen = max(Lseen, L)
        nsub = 1 << L
        h = h_tick / nsub
        for _ in range(nsub):
            x, y, vx, vy, nf = stepper(x, y, vx, vy, h, mu)
            n_force += nf
        t += h_tick
    ex, ey, evx, evy, _, _ = hyper_state(mu, rp, vinf, t)
    dpos = math.hypot(x - ex, y - ey)
    dvel = math.hypot(vx - evx, vy - evy)
    # deflection-angle error
    ang_num = math.atan2(vy, vx); ang_ref = math.atan2(evy, evx)
    da = (ang_num - ang_ref + math.pi) % (2 * math.pi) - math.pi
    return dpos, dvel, da, n_force, Lseen

if __name__ == "__main__":
    print("=" * 108)
    print("P4a  Integrator accuracy per force evaluation")
    print("     Jupiter-class grazing flyby, v_inf = 200 km/s, no substep ladder,")
    print("     integrated from r = 300 R_J inbound to 300 R_J outbound.")
    print("=" * 108)
    print(f"{'integrator':<11}{'dt (s)':>9}{'force evals':>13}{'|dx| (m)':>13}{'|dv| (m/s)':>13}"
          f"{'defl err (deg)':>16}{'miss @ 10 d (km)':>18}")
    for dt in (60.0, 30.0, 10.0, 3.0, 1.0):
        for name, stp, _ in INTEGRATORS:
            dp, dv, da, nf, L = run_flyby(MU_J, R_J, 2e5, dt, stp, "none", 0)
            print(f"{name:<11}{dt:>9.0f}{nf:>13}{dp:>13.3e}{dv:>13.3e}"
                  f"{math.degrees(da):>16.3e}{dv*864000/1e3:>18.3e}")
        print()

    print("=" * 108)
    print("P4b  Same, matched on cost: which integrator is best at a fixed force-eval budget?")
    print("=" * 108)
    print(f"{'integrator':<11}{'dt (s)':>9}{'force evals':>13}{'|dv| (m/s)':>13}{'miss @ 10 d (km)':>18}")
    rows = []
    for name, stp, _ in INTEGRATORS:
        for dt in (240.0, 120.0, 60.0, 30.0, 15.0, 7.5, 3.75, 1.875, 0.9375):
            dp, dv, da, nf, L = run_flyby(MU_J, R_J, 2e5, dt, stp, "none", 0)
            rows.append((nf, name, dt, dv, dv * 864000 / 1e3))
    rows.sort()
    for nf, name, dt, dv, miss in rows:
        print(f"{name:<11}{dt:>9.4f}{nf:>13}{dv:>13.3e}{miss:>18.3e}")
