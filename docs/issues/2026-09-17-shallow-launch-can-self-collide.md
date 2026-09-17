---
status: open
priority: P3
filed: 2026-09-17
filed-by: agent
---
# A launch near-tangential to the surface can hit its own host

## Observation

Found in GRV-0014. A rail launches from exactly on the surface; a heading tangential to the local
vertical puts periapsis on the surface and the first substep endpoint can flag a hit on the host.
An 80 degree cone edge is tested clean, 90 degrees is not. The level compiler (GRV-0016) should
reject or warn on `headingCone` close to 90 degrees, per ADR-0006 §6's validator warnings.

## Resolution
