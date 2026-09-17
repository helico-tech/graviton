---
id: GRV-0009
epic: EPIC-02
status: done
---
# GRV-0009 Burn node edge cases

Post-epic review finding, `docs/issues/2026-09-17-burn-node-edge-cases-crash-or-stall-the-sim.md`.

**Goal.** No command the log accepts can crash `advance` later or stall a probe's node queue.

**Files.** `src/sim/commands.ts`, `src/sim/sim.ts`, tests.

**Acceptance.**
- A burn command with zero prograde and zero lateral is rejected when applied.
- Pending nodes of a probe that has hit a body are dropped, in order, at the tick they are seen;
  the probe never arms a burn after impact.
- A probe that hits a body mid-burn stops burning.
- The golden hash does not move.

**Verification.** `pnpm check`, `pnpm headless tests/golden/flyby-burn.json`.

**Delivered.** `applyBurn` rejects zero-prograde-zero-lateral burns; `activateDueBurnNodes` drops
due nodes of a probe that has hit a body instead of arming them; `testCollisions` clears `burning`
in the same pass it sets `hitBody`. All test-first, `pnpm check` green, golden hash unchanged
(`e18434ee2785b566`). Evidence: `docs/evidence/GRV-0009/README.md`.
