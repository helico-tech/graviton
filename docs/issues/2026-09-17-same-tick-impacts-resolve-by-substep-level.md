---
status: open
priority: P3
filed: 2026-09-17
filed-by: agent
---
# Two probes reaching one contact in the same tick resolve by substep level, not by time

## Observation

Review of GRV-0015. `stepTick` integrates level groups one after another, so when two probes
reach the same contact within one tick the probe in the lower-level group is tested first and
takes the impact, even if the other arrived earlier inside the tick. Deterministic, and both
probes are normally at the same level near a contact, so the window is narrow; it matters for
wave levels (GAME-0001 beat 11). Fix when waves arrive: collect candidate impacts per tick and
apply them in order of impact time.

## Resolution
