---
status: resolved
priority: P2
filed: 2026-09-18
filed-by: agent
work: GRV-0028
---
# Closest-approach and impact labels overlap on the plot on every direct hit

## Observation

EPIC-06 review, screenshot evidence. On a direct hit the closest-approach mark and the impact
mark land on the same pixel and their labels render as "impac t118 km". Suppress the
closest-approach label when an impact for the same contact sits within a few pixels.

## Resolution

**Resolved 2026-09-18** in GRV-0028, commit 7043fe5. render/ghost.ts: plannerLabels drops a closest-approach label within 8 screen px of a same-contact impact, keeping the marker itself; covered by src/render/ghost.test.ts.
