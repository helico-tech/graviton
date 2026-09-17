---
status: resolved
priority: P2
filed: 2026-09-17
filed-by: agent
work: GRV-0011
---
# ADR-0002 guard-rail 5 (cross-engine hash parity) is not implemented

## Observation

EPIC-02 review. No Playwright dependency, config or spec exists; nothing hashes the golden log
in Chromium and Firefox against the Node hash. `src/sim` has no node-only imports, so only the
harness is missing. Belongs with the unit that brings Playwright in (ADR-0004 `pnpm screenshot`).

## Resolution

**Resolved 2026-09-17** in GRV-0011, commit 6d8f3ec. Playwright added (1.63.0, chromium+firefox), tests/e2e/parity.spec.ts replays tests/golden/flyby-burn.json via window.graviton in both browsers and asserts the hash equals the Node hash (e18434ee2785b566, match in both). CI runs it in a new e2e job.
