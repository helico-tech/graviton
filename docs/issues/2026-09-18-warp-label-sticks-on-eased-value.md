---
status: triaged
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
