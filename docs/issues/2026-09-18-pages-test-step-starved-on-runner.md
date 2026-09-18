---
status: resolved
priority: P0
filed: 2026-09-18
filed-by: agent
work: GRV-0019
---
# pages workflow's test step times out under CPU contention on the runner

## Observation

After EPIC-04 closed, `ci` passed but `pages` (run 35314xxx, same commit 350f40b) failed:
`rng.test.ts > float draws stay in [0, 1)` timed out at 5 s. The test made 400 000 `expect` calls
while the solver tests saturated the two-vCPU runner in other workers. Same class as
`2026-09-18-solver-tests-time-out-on-ci.md`: the suite grew CPU-heavy and the default timeout
assumes an idle machine.

## Resolution

**Resolved 2026-09-18** in GRV-0019, commit f27f4a3. One assertion over a counter; global testTimeout 20 s.
