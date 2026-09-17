---
status: resolved
priority: P2
filed: 2026-09-17
filed-by: agent
work: GRV-0009
---
# Burn node edge cases crash or stall the sim

## Observation

Review of GRV-0008. Two paths through `activateDueBurnNodes` are unguarded:

- A burn command with `prograde = lateral = 0` passes `applyBurn` and makes `startBurn` throw
  ticks later, inside `advance`. Reject it when the command is applied.
- A node for a probe that has hit a body still arms (`burning = 1`), but hit objects are skipped
  by every kick, so the burn never ends and later nodes for that probe wait forever. Nodes for
  a hit probe should be dropped deterministically.

## Resolution

**Resolved 2026-09-17** in GRV-0009, commit d13f317. applyBurn now rejects prograde=lateral=0 at apply time; activateDueBurnNodes drops due nodes of a probe that has hit a body instead of arming them; testCollisions clears burning in the same pass it sets hitBody. See docs/evidence/GRV-0009/README.md.
