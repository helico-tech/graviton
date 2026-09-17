---
status: open
priority: P2
filed: 2026-09-17
filed-by: agent
---
# ADR-0002 guard-rail 5 (cross-engine hash parity) is not implemented

## Observation

EPIC-02 review. No Playwright dependency, config or spec exists; nothing hashes the golden log
in Chromium and Firefox against the Node hash. `src/sim` has no node-only imports, so only the
harness is missing. Belongs with the unit that brings Playwright in (ADR-0004 `pnpm screenshot`).

## Resolution
