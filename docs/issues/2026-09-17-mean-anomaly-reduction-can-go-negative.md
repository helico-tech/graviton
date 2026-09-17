---
status: open
priority: P3
filed: 2026-09-17
filed-by: agent
---
# Mean anomaly reduction yields small negative values at 2pi multiples

## Observation

EPIC-02 review. `M - TWO_PI * floor(M / TWO_PI)` in `evaluateEphemeris` returned a value down to
-9.1e-13 for 2.65 % of 600 000 samples at or next to exact multiples of 2pi, so the research §10
row "ephemeris asserts M in [0, 2pi)" does not hold literally. No accuracy impact measured
(`solveKepler` handles it); inherited from the reference formula. Either clamp and re-record the
golden, or amend the §10 row.

## Resolution
