"""
P10: what the corrected reachable set implies for clause timing and sensor range.

r_reach(dv, t_go) = dv*(t_go - dv/(2 a_max))       dv <= a_max t_go
                  = 0.5 a_max t_go^2               otherwise

Covering a box of radius r_box therefore requires a correction applied at least
t_go = r_box/dv + dv/(2 a_max) before impact, and the probe must SEE the contact
by then, so the required sensor range is v_closing * t_go.
"""
import math

def t_go_needed(r_box, dv, amax):
    """Smallest t_go with r_reach >= r_box. None if the thrust limit forbids it."""
    # dv-limited branch: dv*t - dv^2/(2a) = r_box  ->  t = r_box/dv + dv/(2a)
    t = r_box / dv + dv / (2.0 * amax)
    if dv <= amax * t:
        return t
    # thrust-limited: 0.5 a t^2 = r_box
    return math.sqrt(2.0 * r_box / amax)

print("=" * 106)
print("P10a  Correction window and required sensor range, corrected r_reach.")
print("      a_max = 3 m/s^2, closing speed 200 km/s.")
print("=" * 106)
amax = 3.0; vclose = 2.0e5
print(f"{'range':>7}{'r_box @1g':>12}{'dv budget':>11}{'t_go needed':>13}"
      f"{'sensor range needed':>22}{'':>10}")
print(f"{'(lm)':>7}{'(km)':>12}{'(km/s)':>11}{'(s)':>13}{'(km)':>22}{'':>10}")
for lm in (5, 10, 20, 40):
    tau = 2.0 * lm * 60.0
    r_box = 0.5 * 10.0 * tau * tau
    for dvk in (0.5, 2.0, 5.0, 10.0):
        dv = dvk * 1e3
        t = t_go_needed(r_box, dv, amax)
        sens = vclose * t
        note = ""
        if dv > amax * t: note = "thrust-limited"
        print(f"{lm:>7}{r_box/1e3:>12.0f}{dvk:>11.1f}{t:>13.0f}{sens/1e3:>22.0f}{note:>16}")
    print()

print("=" * 106)
print("P10b  Same for a low-agility contact (0.1 g), the early campaign.")
print("=" * 106)
for lm in (5, 10, 20, 40):
    tau = 2.0 * lm * 60.0
    r_box = 0.5 * 1.0 * tau * tau
    for dvk in (0.5, 2.0):
        dv = dvk * 1e3
        t = t_go_needed(r_box, dv, amax)
        print(f"{lm:>7}{r_box/1e3:>12.0f}{dvk:>11.1f}{t:>13.0f}{vclose*t/1e3:>22.0f}")
    print()

print("=" * 106)
print("P10c  Reachability ceiling: the largest box a probe can ever cover,")
print("      given that the correction cannot start before the probe can see the contact.")
print("      r_box_max = r_reach(dv, t_go = sensor_range / v_closing)")
print("=" * 106)
print(f"{'sensor range (km)':>19}{'t_go (s)':>10}", end="")
for dvk in (0.5, 1, 2, 5, 10): print(f"{('dv='+str(dvk)+'km/s'):>16}", end="")
print()
for sens_km in (10_000, 50_000, 100_000, 500_000, 1_000_000):
    t = sens_km * 1e3 / vclose
    print(f"{sens_km:>19}{t:>10.0f}", end="")
    for dvk in (0.5, 1, 2, 5, 10):
        dv = dvk * 1e3
        r = dv * (t - dv / (2*amax)) if dv <= amax*t else 0.5*amax*t*t
        print(f"{max(0.0,r)/1e3:>13.0f} km", end="")
    print()
print()
print("  Read across: this is the table that decides whether a level needs a")
print("  conditional clause, a wave, or neither. A box larger than every entry in")
print("  the row is unreachable by one probe at any budget.")
