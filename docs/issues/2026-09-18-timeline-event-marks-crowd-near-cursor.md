---
status: open
priority: P3
filed: 2026-09-18
filed-by: agent
---
# Timeline event marks' text labels overlap when close together on the axis

## Observation

GRV-0027 evidence (`docs/evidence/GRV-0027/timeline-after.png`): right after a level 01 solution's
launch lands, the present-time cursor sits at almost the same tick as the just-landed launch mark
and the label text of the two overlaps illegibly. Pre-existing characteristic of `src/ui/
timeline.ts`'s `markElement`/`renderTimeline` (every mark's label is absolutely positioned at its
own tick fraction with no collision avoidance) -- not introduced by GRV-0027, which only adds more
marks that can land close together (the unified `event.<n>` list). Same family of issue as
`docs/issues/2026-09-18-timeline-label-collides-with-build-tag.md` (resolved in GRV-0024 by moving
the build tag elsewhere), but this one is between two marks on the strip itself, so there's no
single element to relocate -- needs real layout (stacking, truncation or a hover/detail affordance)
when the game's timeline windows get busy with events.

## Resolution
