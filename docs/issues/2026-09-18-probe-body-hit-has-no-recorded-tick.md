---
status: open
priority: P3
filed: 2026-09-18
filed-by: agent
---
# A probe expended on a body surface has no recorded tick

## Observation

Found while writing GRV-0023's `describeSelection` (`src/app/selection.ts`): the probe readout's
`state` field reads "expended at T+..." per the unit's acceptance, and for a probe that hit a
*fixed contact* that tick is available (`ContactState.impactTick`, indexed by `hitContact`). A
probe that instead hit a *body*'s surface (`DynamicObjects.hitBody`, set by
`src/sim/dynamics/step.ts`'s `testCollisions`) has no equivalent -- `hitBody` records which body,
never which tick. `describeSelection` falls back to a bare "EXPENDED" with no timestamp in that
case, which is honest (not a renderer estimate) but strictly less information than the contact
case gets, and inconsistent with it.

No level in the current campaign ends a flight against a body (L01-intercept's only fixed contact
is the thing being cleared), so this has never been visible in practice. It will be the moment a
level does.

## Resolution
