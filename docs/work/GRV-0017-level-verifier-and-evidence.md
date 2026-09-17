---
id: GRV-0017
epic: EPIC-04
status: todo
---
# GRV-0017 Level verifier and evidence report

**Goal.** `pnpm levels:verify` replays each `<id>.solution.json` headless, asserts outcome and final hash, and writes `<id>.evidence.json` including the per-level `dt` convergence sweep (ADR-0006 §5).

**Acceptance.**
- Refined when the unit is picked up.

**Verification.** `pnpm check`.
