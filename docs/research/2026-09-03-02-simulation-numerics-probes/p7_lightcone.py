"""
P7: uplink and downlink light-cone solvers with a fixed iteration count.

Uplink   : emission at t_e from x_P(t_e); find t_a with |x_M(t_a) - x_P(t_e)| = c*(t_a - t_e)
Downlink : reception at t_r at x_P(t_r); find t_e with |x_M(t_e) - x_P(t_r)| = c*(t_r - t_e)

Both are  g(s) = |x_M(s) - q| - c*|s - t0| = 0.  Newton step:
    g'(s) = u . v_M(s) -/+ c    with u the unit vector from q to x_M(s)
so the step is well conditioned for |v_M| << c.

The truth model here is deliberately nastier than the game: the probe is on a
curved arc at up to 300 km/s AND under a 3 m/s^2 burn, at 40 light-minutes.
"""
import math

C = 299792458.0
LM = C * 60.0                     # one light-minute in metres

def probe_state(t):
    """Truth trajectory: 300 km/s cruise on a curved arc plus a thrust term."""
    w = 2.0e-7                    # rad/s, a tight curve for a cruising probe
    r0 = 40.0 * LM
    x = r0 * math.cos(w * t) + 1.5 * t * t
    y = r0 * math.sin(w * t) + 3.0e5 * t
    vx = -r0 * w * math.sin(w * t) + 3.0 * t
    vy = r0 * w * math.cos(w * t) + 3.0e5
    return x, y, vx, vy

def post_state(t):
    """Post rides a body on a 1 AU circular orbit."""
    AU = 1.495978707e11; n = 1.991e-7
    return AU * math.cos(n * t), AU * math.sin(n * t)

def solve_uplink(t_e, iters):
    qx, qy = post_state(t_e)
    # starter: geometric delay evaluated at the emission instant
    mx, my, _, _ = probe_state(t_e)
    t = t_e + math.hypot(mx - qx, my - qy) / C
    hist = []
    for _ in range(iters):
        mx, my, vx, vy = probe_state(t)
        dx, dy = mx - qx, my - qy
        d = math.sqrt(dx * dx + dy * dy)
        g = d - C * (t - t_e)
        gp = (dx * vx + dy * vy) / d - C
        t = t - g / gp
        hist.append(abs(g))
    return t, hist

def solve_downlink(t_r, iters):
    qx, qy = post_state(t_r)
    mx, my, _, _ = probe_state(t_r)
    t = t_r - math.hypot(mx - qx, my - qy) / C
    hist = []
    for _ in range(iters):
        mx, my, vx, vy = probe_state(t)
        dx, dy = mx - qx, my - qy
        d = math.sqrt(dx * dx + dy * dy)
        g = d - C * (t_r - t)
        gp = (dx * vx + dy * vy) / d + C
        t = t - g / gp
        hist.append(abs(g))
    return t, hist

print("=" * 96)
print("P7a  Residual |g| in metres after each Newton iteration, and the timing error it means")
print("=" * 96)
print(f"{'solver':<10}{'range':>10}{'iter 1':>12}{'iter 2':>12}{'iter 3':>12}{'iter 4':>12}")
for label, solver in (("uplink", solve_uplink), ("downlink", solve_downlink)):
    for tt in (0.0, 1.0e5, 5.0e5, 1.0e6):
        t, hist = solver(tt, 4)
        mx, my, _, _ = probe_state(t)
        qx, qy = post_state(tt)
        rng = math.hypot(mx - qx, my - qy)
        row = f"{label:<10}{rng/LM:>8.1f}lm"
        for h in hist: row += f"{h:>12.3e}"
        print(row)
    print()

print("=" * 96)
print("P7b  Converged answer after N iterations vs after 12 iterations (the fixed point)")
print("     Reported as |t_N - t_12| in seconds and in metres of light travel.")
print("=" * 96)
print(f"{'solver':<10}{'range':>10}{'N=1 (s)':>12}{'N=2 (s)':>12}{'N=3 (s)':>12}{'N=3 (m)':>12}")
for label, solver in (("uplink", solve_uplink), ("downlink", solve_downlink)):
    for tt in (0.0, 5.0e5, 1.0e6):
        ref = solver(tt, 12)[0]
        r1 = solver(tt, 1)[0]; r2 = solver(tt, 2)[0]; r3 = solver(tt, 3)[0]
        mx, my, _, _ = probe_state(ref); qx, qy = post_state(tt)
        rng = math.hypot(mx - qx, my - qy)
        print(f"{label:<10}{rng/LM:>8.1f}lm{abs(r1-ref):>12.3e}{abs(r2-ref):>12.3e}"
              f"{abs(r3-ref):>12.3e}{abs(r3-ref)*C:>12.3e}")
    print()

print("=" * 96)
print("P7c  Fixed-point (no derivative) variant, for reference: t <- t_e + |x_M(t) - q|/c")
print("     Contraction factor is beta = v/c, so the error falls by beta per pass.")
print("=" * 96)
def solve_uplink_fp(t_e, iters):
    qx, qy = post_state(t_e)
    mx, my, _, _ = probe_state(t_e)
    t = t_e + math.hypot(mx - qx, my - qy) / C
    errs = []
    for _ in range(iters):
        mx, my, _, _ = probe_state(t)
        t = t_e + math.hypot(mx - qx, my - qy) / C
        errs.append(t)
    return errs
ref = solve_uplink(0.0, 12)[0]
errs = solve_uplink_fp(0.0, 6)
_, _, vx, vy = probe_state(ref)
beta = math.hypot(vx, vy) / C
print(f"  beta = v/c = {beta:.3e}")
prev = None
for i, t in enumerate(errs):
    e = abs(t - ref)
    ratio = (e / prev) if prev and prev > 0 else float('nan')
    print(f"  pass {i+1}: |t - t*| = {e:.3e} s   ratio to previous: {ratio:.3e}")
    prev = e

print()
print("=" * 96)
print("P7d  Deterministic quantisation: does the residual ever change the arrival TICK?")
print("     Arrival tick = ceil(t_a / dt). Residual after 3 Newton passes vs one tick.")
print("=" * 96)
for dt in (10.0, 30.0, 60.0):
    worst = 0.0
    for k in range(4000):
        tt = k * 251.7
        ref = solve_uplink(tt, 12)[0]
        r3 = solve_uplink(tt, 3)[0]
        worst = max(worst, abs(r3 - ref))
    print(f"  dt = {dt:>4.0f} s : worst |t_3 - t*| = {worst:.3e} s = {worst/dt:.3e} of a tick")
