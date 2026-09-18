---
status: resolved
priority: P3
filed: 2026-09-18
filed-by: agent
work: GRV-0027
---
# No automatic drop to 1x on impact (GAME-0001 §4.11)

## Observation

EPIC-05 review. GAME-0001 §4.11: automatic drop to one times on events of interest, impact
included. Today the page warps through level 01's impact at 10000x. Only impact exists as an
event so far; belongs with the planner epic's time-control work (warp to event).

## Resolution

**Resolved 2026-09-18** in GRV-0027, commit a43168a. src/app/events.ts + app.ts's step(): automatic drop to 1x on any landed event above 1x, announced by a single inverted status-bar frame (GAME-0002 §9); warp-to-event (key '.', debug warpToEvent()) added alongside per the picked-up issue's own note that it belongs with the planner epic's time-control work. See docs/evidence/GRV-0027/README.md.
