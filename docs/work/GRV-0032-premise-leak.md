---
id: GRV-0032
epic: EPIC-07
status: done
---
# GRV-0032 Close the premise leak

Post-epic review finding: `2026-09-18-true-state-leaks-into-selection-contact-glyph-and-timeline.md` (P1).

**Goal.** Nothing the player sees about a dynamic object or a contact comes from the true state;
everything comes from the observed view or the event log (ADR-0007 §6, GAME-0001 §4.6).

**Files.** `src/app/{selection,app,observed}.ts`, `src/render/frame.ts`, tests, `tests/e2e/telemetry.spec.ts`.

**Acceptance.**
- `describeProbe` uses the observed view: SPEED and RANGE from the predicted present, STATE from
  telemetry events (`FLYING` until an arrival-tick event says otherwise, then `EXPENDED AT <event
  tick> (confirmed T+…)`), `—` while unobserved. `describeContact` STATE/CLOSING/ENERGY come from
  the confirmed impact event, `UNCLEARED` until then.
- `captureFrame`'s contacts use the confirmed cleared state; the glyph turns confirmed-good at the
  arrival tick, never before.
- `timelineData` places the impact mark at the confirmed event's simulation tick, only once it is
  confirmed.
- One shared `confirmedContactState({ eventLog, contact })` (or equivalent) so the three consumers
  cannot drift again; the only readers of `sim.contactState`/`sim.objects` outside `src/sim`,
  `src/planner`, `src/levels` and debug-only members are `observed.ts`/`events.ts` — a static
  test asserts it (like the bundle-isolation test).
- `selection.test.ts` rewritten to assert the delayed behaviour; `telemetry.spec.ts` gains the
  review's timeline: at true impact + 4 ticks the panel says UNCLEARED/FLYING, at the arrival tick
  it says CLEARED/EXPENDED with the true impact time and a confirmation time; the glyph likewise
  (pixel sample). Level 01 (co-located post) shows no visible change beyond one tick.

**Verification.** `pnpm check`, `pnpm e2e`, screenshots at true impact + 4 and at arrival.

**Delivered.** `confirmedContactState`/`confirmedProbeState` (`src/app/confirmed.ts`) are the one
shared source `describeContact`/`describeProbe` (`src/app/selection.ts`), `captureFrame`'s contacts
loop (`src/render/frame.ts`) and `timelineData` (`src/app/app.ts`) all read now, derived only from
the telemetry event log (extended to carry a contact impact's closing speed/energy) and the
observed view (extended to carry a probe's mass/dryMass/exhaustVelocity at the predicted present).
A static guard (`src/app/premise.test.ts`) asserts `sim.contactState`/`sim.objects` are read nowhere
in `src/app`/`src/ui`/`src/render` outside the observed-view boundary and a couple of narrowly
justified, pre-existing exceptions. See `docs/evidence/GRV-0032/README.md` for the full account.
