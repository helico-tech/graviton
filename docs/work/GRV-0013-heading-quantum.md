---
id: GRV-0013
epic: EPIC-04
status: todo
---
# GRV-0013 Launch heading in 1/2^32 turn

Picks up `docs/issues/2026-09-17-heading-quantum-too-coarse-for-intercepts.md` (P1).

**Goal.** The command log can express a launch precisely enough to hit a capture radius
(ADR-0006 §4).

**Files.** `src/sim/commands.ts`, tests, `tests/golden/flyby-burn.json`.

**Acceptance.**
- Heading is an integer in `[0, 2^32)`, one unit = `1/2^32` turn; the angle is computed so that a
  heading that is a multiple of 65536 gives the bit-identical direction the old unit gave.
- The golden's heading is multiplied by 65536 and its `expectedHash` does not move, in Node,
  Chromium and Firefox.
- A test shows two adjacent headings differ by under 1 km of miss after an eleven-day coast at
  200 km/s, and that the old quantum differed by thousands of kilometres.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm headless tests/golden/flyby-burn.json`.
