---
status: open
priority: P3
filed: 2026-09-18
filed-by: agent
---
# Chromium pages crash in e2e when the machine's disk is full

## Observation

During GRV-0029 every Chromium test failed with "Page crashed" while Firefox passed; the root
was 5.6 MB free on `/` (old session scratchpads elsewhere on the machine). Freed 3 GB, 88/88
passed again. Nothing in the repo detects this: the console gate and Playwright report a crash,
not the cause. A pre-flight free-space check in `pnpm e2e` (fail fast with the number) would
save the next hour. Not a code defect.

## Resolution
