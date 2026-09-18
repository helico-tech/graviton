---
status: triaged
priority: P3
filed: 2026-09-18
filed-by: agent
work: GRV-0024
---
# shell.spec and parity.spec assert the same no-debug fact

## Observation

EPIC-05 review. `tests/e2e/shell.spec.ts` and `tests/e2e/parity.spec.ts` both assert that
`window.graviton` is absent without `?debug=1`. Keep one.

## Resolution
