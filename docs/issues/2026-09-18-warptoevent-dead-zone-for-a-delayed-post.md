---
status: triaged
priority: P2
filed: 2026-09-18
filed-by: agent
work: GRV-0031
---
# warpToEvent() dead zone for a delayed post

## Observation

`src/app/app.ts`'s `upcomingEvents()` still labels a future committed command's own *issue* tick
(`command.tick`) as the next event, unchanged since before ADR-0007/GRV-0030. For a co-located
post (L01) that is also the tick it takes effect, so `warpToEvent()` lands correctly. For a post
genuinely offset from its rail (T01-far-post, GRV-0030), the issue tick precedes both
materialisation (`uplinkArrival`) and telemetry confirmation (downlink) by ~20 ticks each --
warping to `command.tick + 1` lands before the probe even exists, and `nextEventTick()` then
returns `null` (`snap.objects` is still empty) until materialisation, so a single `warpToEvent()`
press does nothing observable.

Not a correctness bug, and the same *category* of imprecision the design already accepts
elsewhere: `nextEventTick()` has never promised a landing tick where an event is actually visible
in the log, only a best-guess tick to aim for -- `app.test.ts`'s own L01 impact-prediction case
already lands short of telemetry confirmation on purpose ("the post's own telemetry of it hasn't
arrived yet ... warping on confirms it landed once telemetry actually catches up") and
`tests/e2e/events.spec.ts` recovers with a direct `warpTo(3900)`, never another `warpToEvent()`
press. The T01 case is the same recourse, just one step earlier: once `nextEventTick()` goes
`null` in the issue-to-materialisation gap, **repeated `warpToEvent()` presses alone do not escape
it** (verified directly: 20 presses in a row leave the tick unmoved) -- the same manual
`warpTo`/real-time-play recourse the impact case already relies on is required here too. `step()`'s
own automatic drop-to-1x still fires correctly the instant a real telemetry event lands regardless
(confirmed directly), so the player is never actually stuck, just not carried there by "." alone.
`tests/e2e/telemetry.spec.ts` covers the gap and the recourse together for T01.

Left as a UX gap rather than fixed in GRV-0030: a proper fix would have `upcomingEvents()`'s
committed-log branch target a not-yet-applied command's actual materialisation tick (a read-only
`uplinkArrival` call, no new sim-layer code needed) instead of its raw issue tick, closing *this*
particular gap -- but the analogous post-materialisation-to-telemetry-confirmation gap would
remain regardless (the L01 impact case proves that one is accepted as-is), so the fix only trades
one instance of an already-tolerated limitation for a narrower one, not a real closing of the
underlying gap. Widening `src/app/app.ts`'s core event-targeting logic for a partial win risked
exactly the kind of improvisation this unit's brief said to flag instead of attempting solo.

## Resolution
