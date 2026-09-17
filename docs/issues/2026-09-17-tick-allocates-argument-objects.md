---
status: triaged
priority: P3
filed: 2026-09-17
filed-by: agent
work: GRV-0008
---
# stepTick allocates an argument object per object per tick

## Observation

Review of GRV-0006: `stepTick` calls `substepLevel({...})`, `pefrlSubstep({...})` and
`testCollisions({...})` with fresh object literals inside the tick, while its doc comment says
"No allocation". V8 may scalar-replace them, but nobody measured. Measure ticks/s against the
86 000 of ADR-0005 when the headless runner exists; hoist a reusable args struct only if it matters.

## Resolution
