---
id: GRV-0025
epic: EPIC-06
status: todo
---
# GRV-0025 Flight plan and ghost integration

**Goal.** A flight plan integrated into a ghost by the simulation's own step function, with the
solution readout numbers and the ghost invariant test (GAME-0001 §4.4, §4.6 "solution readout",
§7 must-have 3; ADR-0005 "Consequences": the planner re-integrates one ghost and caches from
the earliest edited node).

**Files.** `src/planner/{plan,ghost,readout}.ts`, tests, `src/levels/solve.ts` (reuse only).

**Acceptance.**
- `FlightPlan` is plain data in the command log's own integer units: rail, launch tick, heading,
  speed, and up to `nodeBudget` burn nodes `{ atTick, prograde, lateral }` sorted by tick.
  `planToCommands(plan)` is the only way a plan becomes commands; `commit` is nothing but
  appending those commands to the log.
- `integrateGhost({ level, plan, fromTick, horizonTick })` runs an isolated simulation containing
  only the ghost probe (the world state at `fromTick` is reproduced by replaying the level's
  committed log to that tick, then applying the plan) and returns per-tick samples (x, y, vx, vy,
  mass, burning) plus the events it met: launch, each node's start and end, closest approach
  per contact, impact, body hit. Bounded by the horizon; no allocation per tick beyond the
  sample buffer.
- Ghost invariant test: for level 01's committed solution and for a plan with two burn nodes on
  the flyby golden, the ghost's samples are bit-identical (`Object.is` per double) to the live
  simulation advanced with the same commands among other objects. This is the test that
  protects the promise; it runs in `pnpm check`.
- Cache: editing node `k` re-integrates from node `k`'s tick only; a test proves the cached
  prefix is reused (call count) and the result is bit-identical to a full re-integration.
- `solutionReadout(ghost, level)` returns closest approach and miss distance per contact, arrival
  (closing) speed, time of flight, delta-v remaining after the last node, impact energy, and
  whether the contact clears — every value from the ghost's samples and the simulation's own
  formulas, never a separate model.
- Throughput: one ghost over level 01's whole flight in well under 100 ms (report the number).

**Verification.** `pnpm check`, both goldens MATCH.
