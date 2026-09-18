---
status: triaged
priority: P2
filed: 2026-09-18
filed-by: agent
work: GRV-0024
---
# The non-debug render loop has no automated test

## Observation

EPIC-05 review. Every Playwright spec loads `?debug=1`, which disables the rAF loop by design,
so the tick-budget clamp, the fixed-step frame and the warp ease have never run under a test.
That is how the warp-label bug shipped. Add a non-debug spec that presses keys, waits real time
and asserts `status.time` advances in whole `dt` multiples and `status.warp` settles.

## Resolution
