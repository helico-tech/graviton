---
id: GRV-0028
epic: EPIC-06
status: todo
---
# GRV-0028 EPIC-06 review fixes

Post-epic review findings: `2026-09-18-commit-plan-uses-stale-launch-tick.md` (P1),
`2026-09-18-reintegrate-skips-validate-plan.md` (P1), `2026-09-18-plot-event-labels-overlap-at-impact.md` (P2).

**Goal.** The ghost never lies and commit never throws: every draft the planner integrates is a
valid plan for the present, and what the player commits is what the ghost showed.

**Files.** `src/app/{planner,app,main}.ts`, `src/render/ghost.ts`, `src/ui/planner.ts`, tests,
`tests/e2e/planner.spec.ts`.

**Acceptance.**
- `reintegrate` validates the plan (`validatePlan`) before integrating; an invalid plan draws no
  ghost and its issues show in the PLAN panel with Commit disabled, exactly like a launch
  rejection. `setPlan` with too many nodes, and the re-drag-past-a-node sequence, both end there.
- A draft whose launch tick falls behind the clock is re-snapped and re-integrated when time
  advances (the app's step path), not only when the player edits; `endDrag` re-snaps too.
  A node whose `atTick` would precede the new launch tick is reported, never silently dropped.
- `commitPlan` re-snaps and revalidates first, commits the exact draft the ghost was integrated
  from, and never throws on a stale draft; the Commit handler surfaces any remaining issue in the
  panel instead of the console (the console gate stays clean).
- Ghost-invariant e2e: plan → let 50 ticks pass → commit → `warpTo` the ghost's predicted impact
  tick → the contact's live impact tick equals the prediction the panel showed just before commit.
- On the plot, an impact mark suppresses a closest-approach label for the same contact within a
  few pixels; a render test covers it.

**Verification.** `pnpm check`, `pnpm e2e`, screenshots of the invalid-plan panel and a direct hit.
