---
status: triaged
priority: P1
filed: 2026-09-18
filed-by: agent
work: GRV-0032
---
# Selection panel, contact glyph and timeline show true state ahead of telemetry

## Observation

EPIC-07 review, demonstrated on T01-far-post's committed solution (true impact tick 5806,
telemetry arrival 5831): at tick 5810 the SELECTION panel already reads `CLEARED AT …` and
`EXPENDED AT …` while its own OBSERVED row says the post has no data (blackout); the contact
glyph on the plot turns confirmed-good at true impact; the timeline's impact mark appears at
the true tick. Three consumers still read `sim.contactState`/`sim.objects` directly:
`src/app/selection.ts` (`describeContact`, `describeProbe`), `src/render/frame.ts` (contacts
loop) and `src/app/app.ts` (`timelineData`). `selection.test.ts` encodes the leak as intended.
Violates ADR-0007 §6 and GRV-0030's own "the true state is never drawn".

## Resolution
