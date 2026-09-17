---
status: resolved
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

**Resolved 2026-09-17** in GRV-0008, commit f96df0a. Measured with the headless runner (pnpm headless / src/headless/run.ts, both built in f96df0a): golden flyby-burn (1 object) 232k-238k ticks/s; synthetic 50-object cruise scenario (dt=60, scattered 1-3 AU, no close encounters) ~148k-155k ticks/s, 1.7x ADR-0005's 86k baseline for the same shape, well inside the unit's ~2x measurement bar (in the faster direction). No allocation problem visible at these numbers; stepTick's per-object-per-tick argument literals left as-is -- V8 is evidently scalar-replacing them. See docs/evidence/GRV-0008/README.md.
