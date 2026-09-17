# GRV-0007 evidence — finite burns with mass depletion

2026-09-17, branch `GRV-0007-finite-burns`. Node v24.14.0.

## Port derivation

`src/sim/dynamics/burn.ts`'s `startBurn` is a direct port of research §3.6's mapping from a
burn node's `(dv_prograde, dv_lateral)` to a frozen unit thrust direction: `u = v/|v|`,
`l = (-u.y, u.x)`, `n = (dvp*u + dvl*l)/dv_target`, no trig. `pefrl.ts`'s `kick` extends the
existing gravity kick with a thrust term while `burning`, cutting on the accumulated delta-v
with the final partial stage solved analytically from the rocket equation, the P11e variant of
`docs/research/2026-09-03-02-simulation-numerics-probes/p11_burn.py` that research §3.6
recommends over the precomputed-`t_end`/overlap-fraction form in §3.5's pseudocode.
`ladder.ts`'s `substepLevel` gained a burn term: `L >=` smallest `L` with `dt/2^L <=
t_burn_remaining`, `t_burn_remaining = (m/mdot)*(1 - dexp(-rem/v_e))` from state alone, same
halving-loop shape as `crossingLevel`. `DynamicObjects`/`createDynamicObjects` in `step.ts`
carry the new dense arrays (`mass`, `dryMass`, `thrust`, `exhaustVelocity`, `burnNx`, `burnNy`,
`burnTarget`, `burnDelivered`, `burning`); `stepTick`'s `substepLevel` call passes them through.

## Deviation from the reference: signed hk, not abs(hk), for mass and the accumulator

Research §3.5's `kick(idx, hk, t_stage)` pseudocode updates mass and the delta-v accumulator
with `abs(hk)` every kick, applying the resulting acceleration to velocity with the kick's own
signed `hk` (`vx[i] += hk*ax`). PEFRL's two LAM kicks are negative (`pefrl.ts`'s file header:
"two of the five drift coefficients are negative... the substep briefly steps backwards in
time"; the same holds for two of the four kick coefficients). Porting the pseudocode literally
and running it against this unit's own accuracy bar failed hard: delivered delta-v came out
40-70% off target across every probed value, not a rounding-level miss.

Hand-tracing one substep of the 0.5 m/s case (`dt = 60`, forced to `L = 9` by the ladder term,
`h ≈ 0.1172 s`) pinned it down: with `abs(hk)`, a LAM kick burns propellant *forward* (mass and
the accumulator both increase) while the velocity it actually produces goes *backward* (`hk` is
negative), because `sum(abs(hk))` over one substep's four kicks is `2*K1 + 2*|LAM| ≈ 1.849 *
h`, not `h` -- the accumulator ends up tracking a different, faster clock than the actual
velocity does. The fix ported here uses the kick's *signed* `hk` for mass depletion and the
accumulator too, so `mass_contribution = mdot*hk` and `dv_contribution = a_th*hk` stay
proportional by `ve` (the rocket equation's differential form) at every single kick, matching
whatever the velocity update receives exactly, negative kicks included. Consequence: a burn can
only *finish* (target- or tank-limited) on a positive (K1) kick, since a negative kick is a
transient "regain," not forward progress -- guarded by `hk > 0` in the kick.

A second, smaller residual showed up once the first fix landed: the delivered delta-v accuracy
test passed at machine precision, but final mass missed the unit's 1e-9 bar by roughly 50x
(measured 5.6e-8 relative for the 1000 m/s case). Cause: an ordinary (non-terminal) kick's
velocity contribution used the integrator's usual midpoint-mass estimate
(`thrust/(m - 0.5*mdot*hk)`), which is only an *approximation* of the true rocket-equation
delta-v for the mass actually consumed that kick; summed over the many ordinary kicks of a long
burn, the residual was enough to bias the final mass measurably even though the *accumulator*
(built from the same approximate per-kick value) still hit the delta-v target exactly by
construction. Since the rocket equation has an exact closed form for delta-v given a mass ratio
(`ve * ln(before/after)`, no approximation needed regardless of the interval length), every
kick's delivered amount -- ordinary, negative, or the analytic terminal stage -- is now computed
via `dlog` from the mass it actually consumes, and the midpoint-mass estimate is gone entirely.
That holds both the delta-v and the mass bar at machine precision simultaneously (measured
table below), at the cost of one `dlog` call per burning kick.

Filed **not** to fix here (research §3.6's ladder-term formula, `t_burn_remaining =
(m/mdot)*(1-dexp(-rem/ve))`, doesn't account for a burn that will run the tank dry before
reaching its target, so it can under-refine the last tick or two of a tank-limited burn; the
kick's own analytic cutoff stays exact regardless):
`docs/issues/2026-09-17-burn-ladder-term-ignores-tank-exhaustion.md` (P3).

## Test-construction finding: isolating burn accuracy from gravity

The delivered-delta-v and mass tests (`burn.test.ts`) needed a scenario where gravity
contributes nothing measurable, so the only error being measured is the burn's own. Research
§3.5 suggests either a tiny-mu primary far away, or comparing against an unburned twin in the
same field so gravity cancels to first order. Chose the tiny-mu body (`mu = 1` at `r = 1e13 m`,
giving `mu/r^2 ~ 1e-26 m/s^2`, twelve-plus orders of magnitude under the 1e-9 bar) over the twin:
a twin's trajectory diverges from the burning probe's the moment the burn starts, so its gravity
increments differ from the probe's too, leaving a second-order contamination the tiny-mu setup
never introduces.

## Measured delivered delta-v and mass, free space, tank not limiting (except the last row)

`m_wet = 1500 kg`, `m_dry = 600 kg`, `v_e = 30 km/s`, `T = 4 kN`, `dt = 60 s`, measured with the
ladder active (no forced `L`), from `burn.test.ts`'s own scenario re-run standalone for exact
values:

| dv target (m/s) | burn time (s) | delivered rel err | mass rel err vs. rocket eq |
|---|---|---|---|
| 0.5 | 0.187 | 0.000e+0 | 2.220e-16 |
| 5 | 1.875 | 1.819e-13 | 1.110e-16 |
| 50 | 18.734 | 0.000e+0 | 1.110e-16 |
| 200 | 74.751 | 0.000e+0 | 0.000e+0 |
| 1000 | 368.819 | 2.776e-15 | 0.000e+0 |
| 5000 | 1727.081 | 0.000e+0 | 0.000e+0 |
| 50000 (tank-limited) | 6773.7 (budget) | 1.665e-15 (vs. 27 488.722 m/s budget) | mass hits `dryMass` exactly |

All six orders of magnitude inside the unit's 1e-9 relative bar, and inside the
research doc's own §3.6 table for the (superseded) overlap-fraction method by several orders,
since the accumulator-cut/exact-mass design removes both the timing and the quadrature error
that method carried.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0007-finite-burns


 Test Files  15 passed (15)
      Tests  97 passed (97)
   Start at  20:48:14
   Duration  2.72s (transform 891ms, setup 0ms, import 1.56s, tests 3.75s, environment 2ms)
```

`pnpm docs:validate`: `docs: ok`.
