---
status: accepted
date: 2026-09-03
id: ADR-0005
supersedes: none
deciders: agent (autonomous mandate from the project owner)
---

# Simulation numerics: PEFRL, a two-term per-object substep ladder, own transcendentals

## Context

The determinism contract fixes the shape of the simulation but leaves the
numerical recipes open, and it contains two formulas that measurement showed
to be wrong. Every number here was measured in binary64 in both CPython 3.12
and Node 24 (`docs/research/2026-09-03-02-simulation-numerics.md`); the
acceptance bar throughout is **downstream miss under 1 km ten days after a
flyby**, an order of magnitude inside the smallest uncertainty box.

## Decision

| Component | Decision |
|---|---|
| Kepler solver | Danby starter `E0 = M + 0.85 e sign(sin M)` plus exactly three Danby–Burkardt quartic corrections; final `sin E, cos E` by first-order rotation. Three `dsincos` calls, 1.8e-15 rad for `e <= 0.6`. Body eccentricity capped at 0.8 and asserted at level load. |
| Transcendentals | `dsin dcos dsincos datan datan2 dacos dexp dlog` ported from fdlibm 5.3 kernels using only `+ - * / sqrt floor` and bit views. Measured at most 1.3 ulp; bit-identical between CPython and V8 on all 18 cross-check values. Arguments to `dsin`/`dcos` are contractually below `2^18`; mean anomaly is reduced to `[0, 2pi)` before any trig. |
| Integrator | PEFRL (Omelyan, Mryglod, Folk 2002), four force evaluations, fourth order, coefficients as literals. Objects are grouped by substep level and the ephemeris is evaluated once per stage for the whole group. Collision and surface tests run on substep endpoints only, never on internal stages, because two PEFRL drifts are negative. |
| Substep ladder | Per object, per body, the maximum of a dynamical ladder (smallest `L` with `4^L r^3 >= mu (dt/eta)^2`) and a crossing ladder (smallest `L` with `dt v_rel / 2^L <= zeta r`), both comparison loops with no logarithm, plus a burn term (at least one substep inside any active burn) and a contact term (crossing criterion against the assigned contact). `eta = 0.05`, `zeta = 1/32`, `L_max = 10`. |
| Base timestep | `dt = 60 s` is the ceiling for cruise levels; 120 s fails a grazing pass. Each level's `dt` is validated by a flyby-convergence test. |
| Dynamic objects | Do not attract each other. They collide, they do not gravitate. This is what makes the per-object ladder exact and the ghost invariant hold in a crowd. |
| Burns | Direction frozen at activation from the inertial velocity (no trig); thrust cut on accumulated delta-v with the final partial stage solved analytically, so a node spends exactly what it says. |
| Light cone | Exactly three Newton iterations from the geometric-delay starter, no tolerance branch; arrival quantised with `ceil`, observation with `floor`. Probe history kept in a ring buffer, part of the state, with cubic Hermite interpolation between substep endpoints. |
| Reachable set | `r_reach = dv (t_go - dv / 2 a_max)` when `dv <= a_max t_go`, else `a_max t_go^2 / 2`. |
| Confidence | `area(box ∩ reach) / area(box)` with the lens formula; circles in v1, per-axis measurement error reserved. |
| Exposure | `rate = k chi(psi) / max(r, r_core)^2` inside `R_halo`, accumulated per substep with the closed-form chord integral; `r_core` is a per-halo level parameter. |
| Hash | FNV-1a-style twin-lane 32-bit word hash over raw double bits, `-0` collapsed to `+0`, NaN guarded in development builds. |
| Randomness | sfc32 per named stream, seeded from splitmix32 of `seed ^ fnv(name)`, four words per stream in the state. |
| Command log | Quantised integers only: heading in 1/65536 turn, delta-v in mm/s, times in ticks. |
| Startup self-check | A kernel golden vector (256 fixed inputs through the kernels and the Kepler solver) is hashed at startup and compared with a stored constant. |

## Consequences

- Three claims in the existing documents are superseded and marked inline:
  the `r_reach` formula in `docs/domain/signal-delay-and-uncertainty.md` §4,
  the ladder formula and worked example in
  `docs/domain/simulation-determinism.md` rule 4 and "Performance shape", and
  the pure inverse-square exposure law in GAME-0001 §4.9 (which destroyed
  every impactor 330 km short of a haloed contact).
- Two level-design facts follow: only gas giants bend a 100 km/s probe
  usefully (Earth-class gives 0.7 degrees), so the Slingshot beat needs a
  giant; and probe sensor range is a first-class difficulty dial that decides
  whether a level's answer is a clause, a wave, or neither.
- Throughput measured at 86 000 ticks/s for 50 objects at `dt = 60`, so every
  warp rung up to a million fits in half a frame during cruise and a 14-day
  flight replays in about a quarter of a second. The planner re-integrates one
  ghost in about 86 ms and must cache from the earliest edited node.
- The own kernels cost 35 % more than libm. Accepted.
