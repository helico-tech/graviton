---
id: GRV-0027
epic: EPIC-06
status: done
---
# GRV-0027 Events and time control

**Delivered.** `src/app/events.ts`'s pure `diffEvents`/`sampleClosestApproach` derive events from
per-tick simulation-state deltas (never the renderer); `src/app/predict.ts` predicts a running
probe's remaining flight by replaying the committed log; `app.step` accumulates them into an
explicit session `eventLog`, auto-drops the rung to 1x and arms a single inverted status-bar frame
(`status-bar--invert`, `data-readout="status.event"`); key `.` / debug `warpToEvent()` jump to
`nextEventTick()` through the same budgeted per-frame loop, never a single giant advance; the
timeline strip marks past events full and upcoming ones dim. See
`docs/evidence/GRV-0027/README.md`.

Picks up `docs/issues/2026-09-18-no-auto-drop-to-1x-on-impact.md`.

**Goal.** The player never warps past a decision: automatic drop to one times on events of
interest, announced by one inverted status-bar frame, and warp to the next event
(GAME-0001 §4.11, GAME-0002 §9).

**Files.** `src/app/{events,loop,app,main,debug-api}.ts`, `src/ui/{status,timeline}.ts`,
`tests/e2e/events.spec.ts`, docs.

**Acceptance.**
- Events are derived from simulation state deltas between frames, never from the renderer:
  launch (object count rises), node start and end (`burning` edges), impact or body hit
  (`hitContact`/`hitBody` set), contact cleared, and closest approach to each uncleared contact
  (a per-probe range minimum turning into a rise, measured on tick samples). Each event carries
  its tick and subject; the app keeps an explicit event log for the session.
- Automatic drop: when an event lands during a frame the warp rung becomes 1 (not 0) before the
  next frame, and the status bar inverts for exactly one rendered frame (a class toggled for one
  frame; no transition). A `data-readout="status.event"` shows the last event as text.
- Warp to event: key `.` advances to the next known event tick — from the committed log
  (launch and node ticks), the draft ghost's events, and the running probes' predicted closest
  approach/impact from a ghost of their remaining flight — then drops to 1x. Advancing happens
  through the same loop with the budget, never a single giant `advance` that freezes the page
  beyond the budget (multiple frames are fine). Debug `warpToEvent()` and `events()`.
- The timeline strip marks upcoming events from the same list and past ones from the log.
- Determinism: an event's tick is the same whether reached at 1x, 10000x or by warp to event
  (e2e compares `events()` after each path); the inversion frame does not touch state.
- `events.spec.ts` (strict gate, both browsers, incl. the real loop as in `loop.spec.ts`): commit
  level 01's solution, warp to event repeatedly → launch, closest approach, impact each drop the
  rung to 1 and the readout names them; at 10000x the loop still stops at the impact tick + at
  most one frame's ticks; screenshot of the inverted frame captured via the debug API.

**Verification.** `pnpm check`, `pnpm e2e`, screenshots.
