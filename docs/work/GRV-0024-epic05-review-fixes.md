---
id: GRV-0024
epic: EPIC-05
status: todo
---
# GRV-0024 EPIC-05 review fixes

Post-epic review findings: `2026-09-18-warp-label-sticks-on-eased-value.md` (P1),
`2026-09-18-real-loop-has-no-e2e-test.md` (P2), `2026-09-18-adr-0004-loadrun-renamed-run.md`,
`2026-09-18-duplicate-no-debug-e2e-test.md`, `2026-09-18-timeline-label-collides-with-build-tag.md`.

**Goal.** The status bar never shows a number the simulation did not produce, and the loop every
player runs is under test.

**Files.** `src/app/main.ts`, `src/ui/{status,timeline}.ts`, `src/app/styles.css`,
`tests/e2e/{loop,shell,parity}.spec.ts`, `docs/adr/2026-09-03-0004-headless-validation-and-evidence.md`.

**Acceptance.**
- When the warp ease ends the label shows exactly the target rung; a unit test on the ease
  helper covers the last frame landing anywhere in the window.
- `tests/e2e/loop.spec.ts` loads the built page WITHOUT `?debug=1`, presses `]` to the top rung,
  waits real time, asserts `status.time` advanced by a whole multiple of `dt`, `status.warp`
  reads the rung and `status.warp.effective` reads the achieved multiple; presses space and
  asserts time freezes and `status.warp` reads `0x` after the ease; both browsers, strict gate.
- The build tag moves to the status bar's right edge; the timeline's cursor label no longer
  collides with anything at 1280x720 (screenshot in the evidence).
- ADR-0004's `loadRun` line is marked superseded; the duplicate no-debug test is removed from
  `parity.spec.ts`.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm screenshot --debug`.
