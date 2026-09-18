---
status: open
priority: P2
filed: 2026-09-18
filed-by: agent
---
# window.graviton.view() returns the live camera object, not a copy

## Observation

EPIC-05 review, demonstrated in Chromium: `view()` returned the plot module's own `view` object;
mutating the returned object's `metresPerPixel` changed the next `view()` result. The debug API
doc promises a copy. `setView` already spreads; `getView` did not.

## Resolution
