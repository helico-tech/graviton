---
status: resolved
priority: P1
filed: 2026-09-18
filed-by: agent
work: GRV-0024
---
# status.warp sticks on an arbitrary eased value after a large warp change

## Observation

EPIC-05 review, demonstrated in Chromium with the real rAF loop. The warp-label ease writes
`round(eased)` every frame and, when 150 ms elapse, clears the animation assuming the last frame
landed on the target; for a 10000x -> 0x jump it never does, so the label froze on 200x, 380x and
1093x in three runs and stayed there. The simulation itself was paused correctly (status.time
froze). One readout the player reads that no longer originates in the simulation (rule 11).
Fix: write the exact target when the ease ends.

## Resolution

**Resolved 2026-09-18** in GRV-0024, commit 20d8dd9. src/app/loop.ts's warpEaseFrame writes the exact target once the ease's elapsed time reaches the duration, whatever a frame overshoots it by; main.ts writes every animated frame unconditionally instead of stopping early on the assumption the last write was already exact. Reproduced first as a failing unit test against a faithful extraction of the old per-frame branch (src/app/loop.test.ts).
