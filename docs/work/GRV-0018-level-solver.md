---
id: GRV-0018
epic: EPIC-04
status: todo
---
# GRV-0018 Level solver

**Goal.** `pnpm levels:solve <id>` finds a command log that clears a level, because nobody can
hand-author a launch to nine significant digits (ADR-0006 §5, research 03 §B.1, §B.3-B.5).

**Files.** `src/levels/solve.ts`, `scripts/levels-solve.ts`, `package.json`, tests.

**Acceptance.**
- Scope for now: one probe per fixed contact, a direct launch (rail, launch tick, heading, speed)
  and optionally one mid-course burn; contacts are solved one after another in level order,
  respecting rail reload. Levels it cannot express are rejected with a reason.
- Objective is the closest approach of the probe to the contact over the flight, measured on the
  swept segment between ticks with the simulation's own contact kinematics; a body hit or a
  launch the rail rejects is a penalty, not an exception. Every evaluation runs the real
  simulation, never a separate model.
- Staged search (research 03 §B.4): a coarse grid over launch tick, heading inside the cone and
  speed inside the band at a coarse `dt` multiple; re-convergence on a `dt` ladder down to the
  level's own `dt`, keeping the best result across rungs; derivative-free local refinement on
  the integer heading and speed; finish only when the real simulation reports the contact
  cleared and `verifyLevel` (including the `dt/2` replay) passes.
- Deterministic: same level, same result, no clock, no unseeded randomness. Progress goes to
  stderr, the solution to `levels/<id>.solution.json` with `--write`.
- Solves the compiler fixture in seconds (unit test) and a multi-day interplanetary transfer in
  minutes (recorded in the evidence, not run in the unit suite).

**Verification.** `pnpm check`, the recorded solver runs in `docs/evidence/GRV-0018/`.
