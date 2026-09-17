---
status: open
priority: P3
filed: 2026-09-17
filed-by: agent
---
# dt=120s clears the flyby accuracy bar at zeta=1/32, contradicting research §4.7's zeta=1/16 sweep

## Observation

GRV-0006's `flyby-accuracy.test.ts` reproduces research §4.7's dt=120s grazing
cases (Jupiter 100 km/s, Earth 300 km/s) against this unit's actual shipped
ladder constants (`eta=0.05`, `zeta=1/32`, `L_MAX=10`, from ADR-0005) and
`dt=120` does **not** exceed the 1 km / 10-day bar for either case: Jupiter
100 km/s measures 80.1 m, Earth 300 km/s measures 1.4 m. Both clear the bar
by two to three orders of magnitude.

This contradicts research §4.7's table, which reports those same two cases
FAILING at 1.02 km and 2.12 km respectively -- but that sweep (`p5_ladder.py`
P5c) used `zeta=1/16`, one notch looser than the `zeta=1/32` research §4.6
recommends and ADR-0005 adopts. §4.6 already measured zeta=1/32 giving
roughly 15x headroom over the bar at `dt=60`; that headroom appears to be
enough to also cover `dt=120` for a 1.05-body-radius grazing pass, at least
for the two cases checked here.

ADR-0005's "Base timestep" row states "`dt = 60 s` is the ceiling for cruise
levels; 120 s fails a grazing pass" -- worth re-examining once a future unit
needs the extra warp headroom `dt=120` would buy, since the ceiling may be
tighter than the shipped constants actually require. Not a bug in GRV-0006;
filed as a possible follow-up for level design / warp tuning, not a defect
to fix now.

## Resolution
