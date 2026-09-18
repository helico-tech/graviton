---
id: GRV-0030
epic: EPIC-07
status: todo
---
# GRV-0030 Telemetry and the information horizon

**Goal.** The post sees the past: every probe is drawn at its last observation with a dotted
extrapolation to now, the status bar's DELAY is real, the age of what you see is a readout, and
events reach the player when their telemetry lands (ADR-0007 §5-6, §8; GAME-0001 §4.6
"Information horizon", §4.7, §4.11; GAME-0002 §4 "Dotted, fading tail", §8).

**Files.** `src/sim/telemetry.ts`, `src/app/{observed,events,app,debug-api}.ts`, `src/render/{frame,plot}.ts`,
`src/ui/{status,selection}.ts`, `tests/e2e/telemetry.spec.ts`, docs.

**Acceptance.**
- `observedState({ sim, object, atTick })` in the simulation: the downlink emission tick and the
  object's state then, or `none` before first light or while the segment was occluded at
  emission; one-way delay in seconds; tested against `downlinkEmission` and the history.
- The app keeps an explicit `observed` view of every object, refreshed per tick from the
  simulation: last observation (tick, state), and a prediction from that observation to now
  obtained by replaying the committed log in a ghost from the observation tick (the plan is
  known, so the prediction is exact until something the post does not know happens). The plot
  draws the solid trail up to the observation, the dotted fading tail from there to the predicted
  present, and the probe marker at the predicted present; the true state is never drawn.
- Status bar `DELAY` = one-way delay to the selection (`—` for bodies); selection panel gains
  `OBSERVED` (age of the last observation) and `data-readout="selection.observed"`.
- Events are telemetry events: impact, body hit, node start and end and launch confirmation are
  detected on the observed view, carry both the simulation tick and the arrival tick, and drive
  the automatic drop and the status line at arrival. Closest approach stays a prediction event.
  `events()` exposes both ticks.
- Debug API: `observed(index)`, `delay(selection)`; `?debug=1` state unchanged.
- A test level (`T01-far-post`, fixture prefix) with the post on a body ten light-minutes from
  the rail's host proves the machinery: the launch confirmation arrives ~600 s after launch,
  the dotted tail is visible, `DELAY` reads about 10m00s, and the impact event fires at the
  arrival tick. `telemetry.spec.ts` (strict gate, both browsers) drives it; screenshots read.
- Level 01 (post on the rail's host) looks and behaves as before to within one tick.

**Verification.** `pnpm check`, `pnpm e2e`, screenshots.
