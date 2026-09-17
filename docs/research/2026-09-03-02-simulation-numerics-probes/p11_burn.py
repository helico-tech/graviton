"""
P11: finite burn at maximum thrust with mass depletion.

A burn node is (t_act, dv_prograde, dv_lateral). Mapping to the integrator:

  dv_target = sqrt(dvp^2 + dvl^2)
  u_hat     = velocity direction at t_act, FROZEN for the burn's duration
  l_hat     = (-u_hat.y, u_hat.x)
  n_hat     = (dvp*u_hat + dvl*l_hat) / dv_target        thrust direction
  mdot      = T / v_e                                    constant at max thrust
  t_burn    = (m0 / mdot) * (1 - exp(-dv_target / v_e))   rocket equation, needs dexp
  t_end     = t_act + t_burn

Per substep [t0, t1) with h = t1 - t0 the thrust is weighted by the overlap
fraction  f = clamp((min(t_end,t1) - max(t_act,t0)) / h, 0, 1),  and the mass is
depleted by  mdot * f * h.  Acceleration contribution is  (f * T / m) * n_hat.

Question measured here: how accurately is dv_target delivered, and does forcing
a minimum substep level during a burn tick matter?
"""
import math

VE = 30000.0       # effective exhaust velocity, m/s (nuclear-electric-ish)
T  = 4000.0        # max thrust, N
M_DRY = 600.0
M_PROP = 900.0

def dv_available(m0, mdry, ve): return ve * math.log(m0 / mdry)

def burn_time(m0, dv, ve, thrust):
    mdot = thrust / ve
    return (m0 / mdot) * (1.0 - math.exp(-dv / ve))

def integrate_burn(m0, dv_target, dt, L, t_act_offset):
    """Integrate the burn in a field-free setting so the only error is the
       burn discretisation. Returns delivered dv and final mass."""
    mdot = T / VE
    t_burn = burn_time(m0, dv_target, VE, T)
    t_act = t_act_offset
    t_end = t_act + t_burn
    h = dt / (1 << L)
    m = m0
    dv = 0.0
    t = 0.0
    # run until well past the end of the burn
    nsteps = int(math.ceil((t_end + 2 * dt) / h))
    for _ in range(nsteps):
        t1 = t + h
        lo = max(t_act, t); hi = min(t_end, t1)
        f = (hi - lo) / h
        if f < 0.0: f = 0.0
        if f > 1.0: f = 1.0
        if f > 0.0:
            # midpoint mass over the thrusting part of the substep
            m_mid = m - 0.5 * mdot * f * h
            dv += (T / m_mid) * f * h
            m -= mdot * f * h
        t = t1
    return dv, m, t_burn

print("=" * 100)
print("P11a  Probe budget from the rocket equation")
print("=" * 100)
m0 = M_DRY + M_PROP
print(f"  m_wet = {m0:.0f} kg, m_dry = {M_DRY:.0f} kg, v_e = {VE/1e3:.0f} km/s, T = {T:.0f} N")
print(f"  total dv       = v_e * ln(m_wet/m_dry) = {dv_available(m0, M_DRY, VE)/1e3:.3f} km/s")
print(f"  a at full mass = T/m_wet = {T/m0:.3f} m/s^2")
print(f"  a at dry mass  = T/m_dry = {T/M_DRY:.3f} m/s^2")
print(f"  mdot           = T/v_e   = {T/VE:.4f} kg/s")
print(f"  burn time for the whole budget = {burn_time(m0, dv_available(m0,M_DRY,VE), VE, T):.0f} s "
      f"= {burn_time(m0, dv_available(m0,M_DRY,VE), VE, T)/3600:.2f} h")
print()
print(f"{'dv target (m/s)':>17}{'burn time (s)':>15}{'burn ticks @dt=60':>20}{'prop used (kg)':>17}")
for dv in (10, 50, 200, 1000, 5000):
    tb = burn_time(m0, dv, VE, T)
    print(f"{dv:>17}{tb:>15.2f}{tb/60.0:>20.3f}{(T/VE)*tb:>17.3f}")

print()
print("=" * 100)
print("P11b  Delivered dv vs target, fractional-overlap weighting, dt = 60 s")
print("      t_act offset 0.37 of a tick so the burn straddles substep boundaries.")
print("=" * 100)
print(f"{'dv target':>11}{'burn time s':>13}", end="")
for L in (0, 2, 4, 6): print(f"{('L='+str(L)+' rel err'):>17}", end="")
print()
for dv in (10.0, 50.0, 200.0, 1000.0, 5000.0):
    tb = burn_time(m0, dv, VE, T)
    print(f"{dv:>11.0f}{tb:>13.2f}", end="")
    for L in (0, 2, 4, 6):
        got, mfin, _ = integrate_burn(m0, dv, 60.0, L, 0.37 * 60.0)
        print(f"{abs(got/dv - 1.0):>17.3e}", end="")
    print()

print()
print("  Same for the shortest burns a node can plausibly ask for:")
print(f"{'dv target':>11}{'burn time s':>13}", end="")
for L in (0, 2, 4, 6): print(f"{('L='+str(L)+' rel err'):>17}", end="")
print()
for dv in (0.5, 1.0, 2.0, 5.0):
    tb = burn_time(m0, dv, VE, T)
    print(f"{dv:>11.1f}{tb:>13.3f}", end="")
    for L in (0, 2, 4, 6):
        got, mfin, _ = integrate_burn(m0, dv, 60.0, L, 0.37 * 60.0)
        print(f"{abs(got/dv - 1.0):>17.3e}", end="")
    print()

print()
print("=" * 100)
print("P11c  Sensitivity to where t_act falls inside the tick (must be smooth, not jumpy)")
print("=" * 100)
print(f"{'offset (fraction of tick)':>26}", end="")
for L in (0, 4): print(f"{('L='+str(L)+' rel err'):>17}", end="")
print()
for off in (0.0, 0.13, 0.37, 0.5, 0.61, 0.87, 0.99):
    print(f"{off:>26.2f}", end="")
    for L in (0, 4):
        got, _, _ = integrate_burn(m0, 200.0, 60.0, L, off * 60.0)
        print(f"{abs(got/200.0 - 1.0):>17.3e}", end="")
    print()

print()
print("=" * 100)
print("P11d  Required minimum substep level during a burn tick, for 1e-4 relative dv")
print("=" * 100)
print(f"{'dv target':>11}{'burn time s':>13}{'L needed':>10}{'h (s)':>9}")
for dv in (0.5, 1.0, 5.0, 20.0, 100.0, 500.0, 2000.0):
    tb = burn_time(m0, dv, VE, T)
    Lneed = None
    for L in range(0, 13):
        got, _, _ = integrate_burn(m0, dv, 60.0, L, 0.37 * 60.0)
        if abs(got / dv - 1.0) < 1e-4:
            Lneed = L; break
    print(f"{dv:>11.1f}{tb:>13.3f}{(Lneed if Lneed is not None else -1):>10}{60.0/(1<<(Lneed or 0)):>9.3f}")

print()
print("=" * 100)
print("P11e  Alternative: cut the thrust on ACCUMULATED dv rather than a precomputed t_end")
print("      (no dexp needed, and the target is delivered to machine precision)")
print("=" * 100)
def integrate_burn_accum(m0, dv_target, dt, L, t_act_offset):
    mdot = T / VE
    h = dt / (1 << L)
    m = m0; dv = 0.0; t = 0.0
    for _ in range(int(math.ceil((3600.0) / h))):
        t1 = t + h
        lo = max(t_act_offset, t); hi = t1
        f = (hi - lo) / h
        if f <= 0.0: t = t1; continue
        if f > 1.0: f = 1.0
        m_mid = m - 0.5 * mdot * f * h
        step_dv = (T / m_mid) * f * h
        if dv + step_dv >= dv_target:
            # analytic solve for the fraction g of this substep that finishes the burn:
            # dv_remaining = ve * ln(m / (m - mdot*g*f*h))  ->  g solved directly
            rem = dv_target - dv
            g = (m / (mdot * f * h)) * (1.0 - math.exp(-rem / VE))
            m -= mdot * g * f * h
            dv = dv_target
            break
        dv += step_dv; m -= mdot * f * h
        t = t1
    return dv, m
print(f"{'dv target':>11}", end="")
for L in (0, 2, 4): print(f"{('L='+str(L)+' rel err'):>17}", end="")
print()
for dv in (0.5, 5.0, 200.0, 2000.0):
    print(f"{dv:>11.1f}", end="")
    for L in (0, 2, 4):
        got, _ = integrate_burn_accum(m0, dv, 60.0, L, 0.37 * 60.0)
        print(f"{abs(got/dv - 1.0):>17.3e}", end="")
    print()
print()
print("  Exact by construction: the accumulator stops at the target. The residual")
print("  error is then in the DIRECTION and TIMING of the delivered impulse, not its")
print("  magnitude, which is the error the substep level should be chosen to control.")
