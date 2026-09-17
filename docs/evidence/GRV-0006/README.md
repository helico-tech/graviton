# GRV-0006 evidence — PEFRL integrator and the per-object substep ladder

2026-09-17, branch `GRV-0006-integrator-and-ladder`. Node v24.14.0.

## Port derivation

`src/sim/dynamics/pefrl.ts`'s `pefrlSubstep` is a line-for-line port of
`step_pefrl`/`pefrlGroup` in `p4_integrator.py`/`q5_perf2.mjs`: the same
literal PEFRL coefficients (`XI`, `LAM`, `CHI`, and `K1`/`D3` derived from
them exactly as the reference does), the same five-drift/four-kick stage
order, and the same group-shared ephemeris evaluation (one `evaluateEphemeris`
call per stage serves every object in the group, not one per object).
`src/sim/dynamics/ladder.ts`'s `dynamicalLevel`/`crossingLevel` are
line-for-line ports of `level_dyn`/`level_cross` in `p4_integrator.py` and
`levelFor` in `q5_perf2.mjs`: the same doubling/halving comparison loops, no
logarithm, no division. `src/sim/dynamics/step.ts`'s `stepTick` follows the
`tick()`/grouping pseudocode in research §3.5, built on `evaluateEphemeris`
from GRV-0005 and preallocated scratch instead of the reference's module-level
mutable arrays.

**Deviations from the reference:**

- **A fifth ephemeris evaluation per substep, for collision only.** The
  reference's `pefrlGroup` never tests collision, so it only ever evaluates
  the ephemeris at the four PEFRL stage times. This unit's collision test
  needs the bodies' position at the exact substep *endpoint*
  (`t + s*h + h`), which is not one of the four stage times: the last kick
  lands at fraction `XI + 2*CHI + D3 =~ 0.8214` of `h`, not `1.0`, because
  `pefrlSubstep`'s final stage is a drift, not a kick. `stepTick` therefore
  calls `evaluateEphemeris` once more per substep after `pefrlSubstep`
  returns, purely to get the bodies' endpoint position for
  `testCollisions`. Required by this unit's acceptance criteria ("surface
  collision tested on substep endpoints only"); the reference has no
  collision logic to compare against.
- **`hitBody`-aware drift/kick.** `pefrl.ts`'s `drift`/`kick` skip any object
  with `hitBody[i] !== -1`, freezing it at the position and velocity it had
  when it hit. The reference has no collision concept at all. This is the
  only place collision-awareness lives inside the integrator itself; group
  membership (which objects share a substep) is otherwise untouched by
  collision, matching the acceptance criterion that removing/compacting hit
  objects is a later unit.
- **Structural argument objects instead of the reference's flat module-level
  arrays and positional parameters.** `q5_perf2.mjs` is a single-scenario
  benchmark script with global mutable state; this unit generalises that into
  reusable, capacity-preallocated `DynamicObjects`/`StepScratch` structs per
  the work item's "dense arrays... iterate by index only" and "no allocation
  inside the tick" requirements, matching `bodies.ts`'s existing dense-array
  convention (GRV-0005).
- **No burn or contact terms**, per the work item ("Burn and contact terms
  land in GRV-0007"). `DynamicObjects` carries only `x y vx vy hitBody` --
  no unused fields, no flags reserved for a later unit (YAGNI).

## Test-construction finding: the moving-attractor scenario's t=0 anchor

`p6_ladder_robust.py`'s `run_moving` builds the probe's initial state by
adding a relative hyperbola (computed as if the moon were stationary) to the
moon's position at `t=0`, regardless of how far in the past the hyperbola's
own `t0` is. Porting that literally into `moving-attractor.test.ts` (research
§4.8's scenario, `rp_mult=1.05`, `span_mult=200`, `v_inf=200` km/s) gives
`t0 ~= -75000` s -- about 21 hours before periapsis, during which the moon
(circular 1 AU orbit, ~29.8 km/s) actually moves about 17 million km, six
orders of magnitude more than the ~26 000 km research §4.8 quotes for the
close-encounter window itself. Anchoring the offset at `t=0` instead of `t0`
is invisible to research §4.8's own measurement (P6b only compares two
numerical methods against each other on whatever trajectory the construction
produces) but is fatal to a scenario that wants a specific, non-colliding
periapsis: measured actual closest approach ranged from 0.98 R to 1.02 R
*regardless of the nominal `rp_mult` tried* (swept 1.05 through 8), i.e. a
near-miss or a genuine hit almost independent of the intended grazing
distance, because the construction's own error dominates. Anchoring the
offset at `t0` instead (`evaluateEphemeris(bodies, tick0*dt, ...)`) reproduces
the intended periapsis to within 5% (measured 1.0519 R for a nominal 1.05 R)
and never hits. Not a bug in `pefrl.ts`/`ladder.ts`/`step.ts` -- confirmed by
reproducing the same near-1-R clustering independent of `rp_mult` from 1.05 to
8, which a real physics bug in the integrator would not produce -- purely a
test-fixture construction issue, fixed in the test.

## Measured flyby misses

`flyby-accuracy.test.ts`, downstream miss after the flyby span plus 10 further
days, against the exact analytic hyperbola (not the linear `dv*t` estimate
`p5_ladder.py` uses):

| body | v_inf | dt | ticks | miss @ 10 d | bar | |
|---|---|---|---|---|---|---|
| Jupiter-class | 100 km/s | 60 s | 21 884 | 67.878 m | < 1000 m | ok |
| Jupiter-class | 200 km/s | 60 s | 18 150 | 33.405 m | < 1000 m | ok |
| Jupiter-class | 300 km/s | 60 s | 16 901 | 30.755 m | < 1000 m | ok |
| Earth-class | 100 km/s | 60 s | 15 069 | 2.956 m | < 1000 m | ok |
| Earth-class | 200 km/s | 60 s | 14 734 | 2.430 m | < 1000 m | ok |
| Earth-class | 300 km/s | 60 s | 14 623 | 2.507 m | < 1000 m | ok |
| Jupiter-class | 100 km/s | 120 s | 10 942 | 80.070 m | < 1000 m | ok (§4.7 predicted FAIL at zeta=1/16) |
| Earth-class | 300 km/s | 120 s | 7 311 | 1.362 m | < 1000 m | ok (§4.7 predicted FAIL at zeta=1/16) |

Every case clears the 1 km bar by one to three orders of magnitude at
`dt=60s`, the unit's specified base timestep. The two `dt=120s` rows are
research §4.7's own predicted failures, reproduced against this unit's actual
`zeta=1/32` rather than that sweep's `zeta=1/16`: both pass, see
`docs/issues/2026-09-17-dt120-clears-bar-at-zeta-1-32.md`.

## Moving-attractor scenario (research §4.8)

`moving-attractor.test.ts`, Jupiter-class moon on a circular 1 AU orbit, probe
grazing at 1.05 body radii, `v_inf=200` km/s, `dt=60s`, `zeta=1/32`:

| Check | Measured | Asserted bound |
|---|---|---|
| Actual closest approach vs. nominal 1.05 R (t0-anchored construction) | 1.0519 R | not flagged as a hit |
| Relative change in moon-frame specific energy, incoming vs. outgoing | 2.15e-7 | `< 1e-4` |
| Hash of final state, two independent runs | bit-identical | bit-identical |

## Ladder boundary checks

`ladder.test.ts` probes the dynamical ladder's `4^L r^3 >= k_dyn` flip and the
crossing ladder's `dt*vRel <= zeta*r` flip at independently-derived boundaries
(`Math.cbrt`, never used in production code) with a `1e-6` relative margin on
each side; both land on the predicted integer level with no off-by-one.
Mass sensitivity (gas giant vs. moonlet, same range), the `L_MAX=10` clamp,
and "crossing uses velocity relative to the body, not the object's raw
velocity" (an object matching its body's velocity exactly measures level 0
despite ~29.8 km/s of absolute speed; a stationary object next to the same
body measures a non-zero level despite zero absolute speed) all pass.

## Test runtime

`src/sim/dynamics` (this unit's own tests, 4 files, 19 tests): 262 ms.
Full suite (`pnpm test`, 14 files, 79 tests, includes GRV-0003/0004/0005's
tests too): well under the 20 s pre-push budget.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0006-integrator-and-ladder


 Test Files  14 passed (14)
      Tests  79 passed (79)
   Start at  20:19:25
   Duration  2.67s (transform 431ms, setup 0ms, import 817ms, tests 3.72s, environment 1ms)
```
