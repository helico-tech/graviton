---
status: open
priority: P3
filed: 2026-09-18
filed-by: agent
---
# plot.spec wheel/drag test is flaky on Firefox under parallel load

## Observation

Seen once during GRV-0027: `tests/e2e/plot.spec.ts` "wheel zooms about the cursor and drag pans" failed
on Firefox in a full parallel run and passed standalone and on the next run. Timing-sensitive
(wheel then read `view()` immediately). Wait for the view to change rather than asserting after
a fixed sequence, or serialise the pointer tests.

## Resolution
