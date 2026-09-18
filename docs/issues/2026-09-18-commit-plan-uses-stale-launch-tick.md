---
status: triaged
priority: P1
filed: 2026-09-18
filed-by: agent
work: GRV-0028
---
# commitPlan commits a stale launch tick and throws uncaught once time has passed it

## Observation

EPIC-06 review, demonstrated. `endDrag` does not re-snap the draft's launch tick, so a draft
left alone while time runs keeps a launch tick in the past; `commitPlan` only checks the cached
issues and calls `session.command`, which throws "command tick 1 precedes current tick 5" —
uncaught in the Commit click handler while the button stays enabled. Commit must re-snap and
revalidate the draft first.

## Resolution
