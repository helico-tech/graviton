---
id: EPIC-01
status: done
---
# EPIC-01 Foundation

Toolchain, quality gates, and the repo scripts the working agreements require
(ADR-0002, ADR-0003). Done when `pnpm install && pnpm check && pnpm build` is
green from a clean clone, the pre-push hook enforces it, CI is green on
GitHub, and the Pages workflow serves the placeholder page.

Stories: GRV-0001, GRV-0002.
