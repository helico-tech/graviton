---
status: resolved
priority: P3
filed: 2026-09-18
filed-by: agent
work: GRV-0020
---
# Unbounded axialPhaseAtEpoch and longitude reach the trig kernel unreduced

## Observation

EPIC-04 review, demonstrated. `evaluateEphemeris` reduces the whole mean anomaly before trig, but
`surfacePhase` adds the raw `axialPhaseAtEpoch`, and rails/contacts add a raw `longitude` on top.
`axialPhaseAtEpoch: 100000000 deg` compiles without a warning and `advance()` throws the kernel's
`|x| <= 2^18` RangeError on the first tick. Bound the angles at compile and load time (normalising
source angles to [0, 2pi) changes no existing compiled level); reducing inside `surfacePhase`
would move every hash and re-solve every level for a P3.

## Resolution

**Resolved 2026-09-18** in GRV-0020, commit 4f1c71e. the compiler normalises axialPhaseAtEpoch/longitude/argPeriapsis/meanAnomalyAtEpoch to [0, 2pi); createBodyTable/createRailTable/createContactTable independently bound the same angles to [-2pi, 2pi] at load.
