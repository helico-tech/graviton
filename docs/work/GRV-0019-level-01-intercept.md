---
id: GRV-0019
epic: EPIC-04
status: done
---
# GRV-0019 Level 01: Intercept

**Goal.** The first campaign beat exists as data, is solved by the solver and verified in CI
(GAME-0001 §6 beat 1: fixed contact, one rail, gravity negligible).

**Files.** `levels/L01-intercept.level.yaml` (+ compiled, solution, evidence),
`scripts/levels-verify.ts`, docs.

**Acceptance.**
- An invented system in the setting's voice (ADR-0001, GAME-0002 for naming tone): one rail, one
  probe type, one fixed contact, a flight of hours where the path bends by well under a degree;
  the evidence records the closest approach the same launch would have had with all `mu` set to
  a negligible value, to show gravity is not the lesson here.
- Brief and debrief are one terse paragraph each; no characters, no dialogue.
- The solution comes from `pnpm levels:solve L01-intercept --write` unchanged; evidence committed.
- Campaign levels (`L` prefix) without a solution fail `levels:verify`; fixtures (`T` prefix) are
  only reported. `pnpm check` therefore proves every campaign level solvable.
- `docs/README.md` gains a `levels/` paragraph: naming, what is source and what is generated,
  and the three commands.

**Verification.** `pnpm check`, `pnpm levels:solve L01-intercept` reproducing the committed solution.

**Delivered.** `levels/L01-intercept.level.yaml` (Corvai/Meskel/Yarune, gravity negligible at
0.0076 deg over the flight, measured against a 1e-6-`mu` run), solved deterministically by
`pnpm levels:solve L01-intercept --write` and verified; `levels-verify.ts` now fails an `L`-prefix
campaign level with no solution (test-first); `docs/README.md` gained a `Levels` section. Evidence:
`docs/evidence/GRV-0019/README.md`.
