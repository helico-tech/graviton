---
status: triaged
priority: P3
filed: 2026-09-18
filed-by: agent
work: GRV-0020
---
# Dead RailGeometry export and a duplicated phrase in sim.ts's doc comment

## Observation

EPIC-04 review. `src/sim/rails.ts` exports `RailGeometry` which nothing imports, and
`src/sim/sim.ts`'s serialisation doc comment repeats "rail last-launch ticks" twice.

## Resolution
