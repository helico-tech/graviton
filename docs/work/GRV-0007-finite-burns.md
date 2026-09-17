---
id: GRV-0007
epic: EPIC-02
status: todo
---
# GRV-0007 Finite burns with mass depletion

Split on 2026-09-17: the tick loop, command log and determinism tests moved to GRV-0008 so
each unit solves one problem.

**Goal.** A burn node spends exactly the delta-v it says, as a finite burn at maximum thrust
inside the PEFRL kicks (ADR-0005 "Burns", research §3.5-3.6).

**Files.** `src/sim/dynamics/burn.ts`, changes to `pefrl.ts`, `ladder.ts`, `step.ts`, tests.

**Acceptance.**
- Objects carry mass, thrust, exhaust velocity and an active burn (frozen unit direction,
  target and accumulated delta-v). Activation happens at a tick boundary.
- Direction frozen at activation from the inertial velocity, prograde + lateral, no trig.
- Thrust cut on accumulated delta-v with the final partial stage solved analytically;
  delivered delta-v within 1e-9 relative of the request at L = 0 and with the ladder active.
- Mass follows the rocket equation to 1e-9 relative; a burn larger than the tank ends when
  propellant runs out and reports what it delivered.
- Ladder burn term: during a burn, `L >=` smallest `L` with `dt / 2^L <= t_burn`, from state alone.
- The flyby-accuracy, ghost-isolation and batch-invariance tests stay green; a burning probe
  alone and in a crowd stays bit-identical.

**Verification.** `pnpm check`.
