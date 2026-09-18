---
status: resolved
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

**Resolved 2026-09-18** in GRV-0024, commit 20d8dd9. Removed tests/e2e/parity.spec.ts's no-debug assertion; kept shell.spec.ts's, which also asserts the shell still renders.
