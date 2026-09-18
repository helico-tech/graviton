---
status: resolved
priority: P2
filed: 2026-09-18
filed-by: agent
work: GRV-0020
---
# Unbounded probes[].count allocates gigabytes without a diagnostic

## Observation

EPIC-04 review, demonstrated. `probes[].count` has no upper bound; `count: 1000000000` compiles
cleanly and `createSim` allocates 8 GB in the object arrays (and four times that many burn
nodes). A typo becomes an OOM on the runner with no diagnostic.

## Resolution

**Resolved 2026-09-18** in GRV-0020, commit 4f1c71e. probes[].count <= 64 and nodeBudget <= 16 in the schema; validateScenario also bounds capacity/burnNodeCapacity to 4096 (MAX_SCENARIO_ALLOCATION) for scenarios built outside the compiler.
