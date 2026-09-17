---
status: open
priority: P1
filed: 2026-09-17
filed-by: agent
---
# pnpm lint reads work in progress in .worktrees/

## Observation

`eslint .` does not honour `.gitignore`, so with two units in flight the pre-push hook of one
failed on the other's unfinished files under `.worktrees/`. The hook did its job (nothing was
pushed); the gate was simply looking at files that are not part of the checkout. Prettier reads
`.gitignore` and vitest/tsc are scoped to `src`, `scripts`, `tests`, so only ESLint was affected.

## Resolution
