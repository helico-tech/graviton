---
status: triaged
priority: P2
filed: 2026-09-18
filed-by: agent
work: GRV-0020
---
# Large reloadTime wraps reloadTicks negative and disables reload

## Observation

EPIC-04 review, demonstrated. `createRailTable` checks `reloadTicks` is a non-negative integer but
not that it fits an `Int32Array`; `reloadTime: 100000000000 h` compiles to `12000000000000` ticks,
is stored as `-138625024`, and the reload gate `tick - last < reloadTicks` is then always false: a
rail meant to never reload reloads instantly. Silent wrong compilation.

## Resolution
