---
status: resolved
priority: P3
filed: 2026-09-17
filed-by: agent
work: GRV-0016
---
# A launch near-tangential to the surface can hit its own host

## Observation

Found in GRV-0014. A rail launches from exactly on the surface; a heading tangential to the local
vertical puts periapsis on the surface and the first substep endpoint can flag a hit on the host.
An 80 degree cone edge is tested clean, 90 degrees is not. The level compiler (GRV-0016) should
reject or warn on `headingCone` close to 90 degrees, per ADR-0006 §6's validator warnings.

## Resolution

**Resolved 2026-09-17** in GRV-0016, commit 4fe9d7b. The level compiler warns when a rail's headingCone exceeds 80 degrees (src/levels/compile.ts's collectWarnings), per ADR-0006 section 6's solvability-warning list -- the same threshold this issue's own testing found (80 degrees clean, 90 degrees not). A level author sees the warning at compile time instead of discovering the fragility through a failing search.
