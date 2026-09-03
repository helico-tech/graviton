---
id: GRV-0002
epic: EPIC-01
status: done
---
# GRV-0002 Release checks: CI, Pages and live-site smoke test

**Goal.** Prove the foundation end to end: the pushed commit is green on
GitHub Actions, the Pages workflow deploys it, and the live site serves the
build of that exact commit with a clean console.

**Files.** None; this unit is verification and evidence only.

**Acceptance.**
- `ci` and `pages` workflows succeed for the merge commit on `main`.
- `https://helico-tech.github.io/graviton/` returns 200 with relative asset
  paths (Vite `base: './'`).
- The page text shows the build SHA equal to `git rev-parse --short HEAD`.
- Zero console messages of any level.

**Verification.** `gh run watch --exit-status <id>` for both runs; `curl`;
`playwright-cli open` + `eval` + `console`; screenshot in
`docs/evidence/GRV-0002/`.

**Delivered.** Evidence in `docs/evidence/GRV-0002/`.
