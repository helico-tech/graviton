---
id: GRV-0016
epic: EPIC-04
status: todo
---
# GRV-0016 Level compiler

**Goal.** `compileLevel` turns `levels/<id>.level.yaml` into canonical JSON with valibot validation, dimension-scoped units, line/column issues and a generated JSON Schema (ADR-0006 §1-3, §6).

**Acceptance.**
- Refined when the unit is picked up.

**Verification.** `pnpm check`.
