---
id: GRV-0006
epic: EPIC-02
status: todo
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
