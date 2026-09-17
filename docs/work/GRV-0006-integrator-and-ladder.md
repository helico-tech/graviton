---
id: GRV-0006
epic: EPIC-02
status: done
---
# GRV-0006 PEFRL integrator and the per-object substep ladder

**Goal.** Tier two: dynamic objects integrated in the field of the ephemeris
bodies to the ADR-0005 accuracy bar (research §3, §4).

**Files.** `src/sim/dynamics/pefrl.ts`, `src/sim/dynamics/ladder.ts`,
`src/sim/dynamics/step.ts`, tests including `flyby-accuracy.test.ts`.

**Acceptance.**
- PEFRL with literal coefficients, four force evaluations; ephemeris evaluated once per stage
  per substep-level group.
- Per object, per body: max of the dynamical and crossing ladders as comparison loops with no
  logarithm; `eta = 0.05`, `zeta = 1/32`, `L_max = 10`. Burn and contact terms land in GRV-0007.
- Surface collision tested on substep endpoints only.
- Flyby accuracy: grazing pass of a gas-giant and an Earth-class body at 100/200/300 km/s,
  `dt = 60 s`, downstream miss after 10 days under 1 km against the analytic hyperbola.
- Ghost isolation: one probe alone and among 200 others ends bit-identical.

**Verification.** `pnpm check`.

**Delivered.** `src/sim/dynamics/pefrl.ts` (`pefrlSubstep`, literal PEFRL
coefficients, group-shared ephemeris per stage), `src/sim/dynamics/ladder.ts`
(`substepLevel`, `computeKDyn`, `ETA`/`ZETA`/`L_MAX`), and
`src/sim/dynamics/step.ts` (`DynamicObjects`, `StepScratch`, `stepTick`),
tests beside each. Measured flyby misses, deviations from the reference and
test runtime in `docs/evidence/GRV-0006/README.md`. Filed
`docs/issues/2026-09-17-dt120-clears-bar-at-zeta-1-32.md` (P3): this unit's
actual `zeta=1/32` clears the 1 km bar at `dt=120s` for the grazing cases
research §4.7 measured failing at `zeta=1/16`.
