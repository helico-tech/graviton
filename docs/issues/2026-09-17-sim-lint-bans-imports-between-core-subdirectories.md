---
status: open
priority: P1
filed: 2026-09-17
filed-by: agent
---
# src/sim lint bans imports between the core's own subdirectories

## Observation

Found by GRV-0005: `no-restricted-imports` with `group: ['../*']` matches the specifier's
text, so `src/sim/ephemeris/kepler.ts` could not import `../math/kernels.ts` although both
sit inside the core. GRV-0003 and GRV-0004 never crossed a subdirectory, so GRV-0001's
lint-gate test never saw it. Blocks every remaining EPIC-02 unit, hence P1.

## Resolution
