---
status: open
priority: P0
filed: 2026-09-18
filed-by: agent
---
# Solver tests exceed vitest's 5 s default on the CI runner

## Observation

`main` went red after GRV-0018 merged: three tests that run a real solve of the fixture level
take ~4.4 s locally and over 5 s on the GitHub runner (CI run 35313571954). The pre-push hook
passed because the machine is faster. A genuine solve is the test's point, so the fix is an
explicit per-test timeout, not a smaller solve.

## Resolution
