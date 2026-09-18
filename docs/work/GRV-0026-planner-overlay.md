---
id: GRV-0026
epic: EPIC-06
status: done
---
# GRV-0026 Planner overlay

**Delivered.** Launch drag off a rail, node placement/dragging on the ghost path, PLAN/SOLUTION
panels, horizon scrub, commit -- all through `src/app/planner.ts`'s pure state and the live
simulation's own ghost integration (`src/planner/ghost.ts`, untouched). See
`docs/evidence/GRV-0026/README.md`.

**Goal.** The player plans on the live plot: drag a launch vector off a rail, place and drag burn
nodes, watch the dashed ghost integrate against the moving system, read the solution, commit
(GAME-0001 §4.6; GAME-0002 §4 "Dashed: predicted from a loaded plan", §7 "Trajectories",
§8 SOLUTION panel, §9). Locked-node dimming waits for signal delay.

**Files.** `src/app/planner.ts`, `src/ui/{planner,solution}.ts`, `src/render/{plot,ghost}.ts`,
`src/app/{app,debug-api,main}.ts`, `tests/e2e/planner.spec.ts`, docs.

**Acceptance.**
- Planner state is explicit app state: the draft `FlightPlan | null`, the active drag, and the
  ghost (with its cache) re-integrated whenever the plan changes, from the earliest edited node.
  Time may keep running while planning; the ghost is re-integrated from the present when the
  plan's launch tick is reached or passed (the launch tick then snaps to the next tick).
- Launch drag: press on a rail's marker and drag; the vector from the rail sets heading (absolute)
  and speed (length, mapped logarithmically across the muzzle band), snapped to the command
  units; outside the cone or band the ghost is not drawn and the reason is shown (from
  `checkLaunch`). Release keeps the draft.
- Nodes: click on the ghost path places a node at that tick (within `nodeBudget`); a node has a
  prograde handle along the ghost's velocity and a lateral handle perpendicular; dragging sets
  the components in mm/s; small squares on the line, filled (amendable).
- Ghost drawn dashed in "known, yours", the flown part of a committed probe stays solid; events
  marked: closest approach per contact as a tick with the miss distance label, impact as the
  confirmed-good marker, body hit as alarm.
- Horizon scrub: dragging the timeline cursor while the sim is paused sets a horizon tick; bodies
  are drawn from the ephemeris at that tick and the ghost from its samples; releasing returns to
  the present. Explicit `horizon: number | null` state; nothing in the simulation moves.
- SOLUTION panel (GAME-0002 §8): closest approach, miss distance, arrival speed, time of flight,
  delta-v remaining, impact energy, clears (yes/no), each `data-readout="solution.<field>"` from
  `solutionReadout`; PLAN panel: rail, launch time, heading, speed, nodes with components,
  `data-readout="plan.<field>"`. Commit button appends `planToCommands` to the session log and
  clears the draft; the committed probe's live replay is bit-identical to the ghost (asserted
  in e2e by comparing `state()` samples at the impact tick with the ghost's readout).
- Debug API: `plan()`, `setPlan(plan)`, `commitPlan()`, `setHorizon(tick|null)`, `solution()`.
- `planner.spec.ts` (strict gate, both browsers): set level 01's committed solution as the plan
  via `setPlan` → solution readout says clears with the evidence file's impact tick; drag the
  launch vector with the mouse and see the readout change; place a node by click and drag its
  handle; commit and `warpTo(impact)` → contact cleared, probe expended; horizon scrub moves the
  bodies and back. Screenshots: before, the draft ghost with a node, the solution panel.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm screenshot --debug`.
