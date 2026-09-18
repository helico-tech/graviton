---
id: GRV-0031
epic: EPIC-07
status: todo
---
# GRV-0031 Command horizon and locked nodes

Picks up `docs/issues/2026-09-18-warptoevent-dead-zone-for-a-delayed-post.md` and
`docs/issues/2026-09-18-ghost-lazy-issuance-cannot-cross-a-long-blocked-stretch.md`.

**Goal.** The planner shows where an order sent now first arrives, refuses to edit what it can no
longer reach, lets the player amend a flying probe's plan, and draws uplink windows on the
timeline (GAME-0001 §4.4, §4.6 "Command horizon", "Uplink availability band"; GAME-0002 §4
"Dimmed solid", §7 "hollow when locked"; ADR-0007 §2-4).

**Files.** `src/planner/{plan,ghost}.ts`, `src/app/{planner,app,events,predict,debug-api}.ts`,
`src/render/ghost.ts`, `src/ui/{planner,timeline}.ts`, `tests/e2e/horizon.spec.ts`, docs.

**Acceptance.**
- The ghost issues a plan the way commit does: launch and nodes batched at the launch's issue
  tick (`issueTickFor(rail, launchTick)`), so the ghost and the committed replay share one path
  and the lazy-issuance limitation disappears; the ghost invariant tests stay bit-identical.
- Command horizon: for a draft, the launch's issue tick and arrival tick are shown in the PLAN
  panel; on the plot the ghost path before the arrival tick does not exist (the probe is not
  there yet) and the launch time readout says when the order must leave. For a flying probe, the
  horizon is the arrival tick of an order sent now (`uplinkArrival` to the probe); it is drawn as
  a mark on the probe's predicted path with the label `CMD +mm:ss`.
- Amendments: selecting a flying probe and pressing `N` opens its plan for amendment: existing
  nodes before the horizon are locked (dimmed solid, hollow squares, no handles, the reason on
  hover/in the panel); nodes at or after it may be edited; new nodes only after it. Commit issues
  the amended nodes now as burn commands; the ghost for the amendment starts from the observed
  state's prediction, not the true state (the post plans on what it knows).
- Uplink availability band: the timeline shows, for the selected or drafted probe, the occlusion
  windows of the post-to-probe path over the predicted flight (from the ephemeris and the
  prediction), and a launch or amendment whose issue tick falls in a blocked window is reported
  as `occluded` with the next clear tick suggested.
- Warp to event targets telemetry ticks: launch confirmation, node confirmation, impact
  confirmation (arrival ticks), plus the draft's issue tick and any command's arrival; the
  dead zone is gone (`warpToEvent()` from tick 0 on T01 lands on the launch's issue tick, then on
  its confirmation).
- `horizon.spec.ts` (strict gate, both browsers) on T01: draft → panel shows issue/arrival ticks
  ~20 apart; commit → `warpToEvent()` sequence lands on issue, confirmation, then impact
  confirmation; amend a flying probe → a node before the horizon is locked and `commitPlan()`
  refuses to move it; a node after it commits and the live replay matches the ghost.
- Screenshots: locked and unlocked nodes on an amendment, the uplink band on the timeline; read.

**Verification.** `pnpm check`, `pnpm e2e`, screenshots.
