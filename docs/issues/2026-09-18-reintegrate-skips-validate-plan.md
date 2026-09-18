---
status: triaged
priority: P1
filed: 2026-09-18
filed-by: agent
work: GRV-0028
---
# Ghost integrates unvalidated plans: setPlan crashes, a node before launch is silently dropped

## Observation

EPIC-06 review, demonstrated. `reintegrate` runs `checkPlanLaunch` but not `validatePlan`.
(a) `setPlan` with more nodes than `nodeBudget` throws from inside the sim ("pending burn queue
capacity 0 exceeded"). (b) Re-dragging the launch after time passed a node's `atTick` snaps the
launch tick past the node; the ghost then silently ignores the node (its burn command sorts
before the launch and the log cursor skips it), so the SOLUTION panel lies. `reintegrate` must
validate and show issues instead of a ghost, like a cone rejection.

## Resolution
