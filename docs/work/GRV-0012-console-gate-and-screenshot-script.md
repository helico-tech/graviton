---
id: GRV-0012
epic: EPIC-03
status: done
---
# GRV-0012 Console gate and the screenshot script with deploy proof

**Goal.** One reusable gate and one script every user-visible unit uses for its evidence
(ADR-0004 §3, §4, §6).

**Files.** `tests/e2e/console-gate.ts`, `scripts/screenshot.ts`, `package.json`, docs.

**Acceptance.**
- The gate fails a driven page on console error or warning, page error, failed request, HTTP
  status >= 400, or dialog; the allowlist starts empty and entries need a comment. Tested
  against a fixture page that trips each rule.
- `pnpm screenshot [--url <u>] [--expect-build <sha>] --out <png>` serves `dist/` when no URL
  is given, waits for `window.graviton.ready` when `debug=1`, applies the gate, writes the PNG,
  and exits non-zero when the page's build SHA differs from `--expect-build`.
- The live Pages site passes `--expect-build $(git rev-parse --short HEAD)` after the merge.

**Verification.** `pnpm check`, `pnpm e2e`, the live-site run in `docs/evidence/GRV-0012/`.

**Delivered.** `scripts/lib/console-gate.ts` (shared by `tests/e2e/console-gate.ts` and
`scripts/screenshot.ts`), `tests/e2e/console-gate.spec.ts`, `parity.spec.ts` refactored onto it,
`scripts/lib/static-server.ts`, `scripts/screenshot.ts` + `pnpm screenshot`, unit tests for every
pure part, `tests/e2e/screenshot.spec.ts`, and the "Proving a change" section in
`docs/README.md`. See `docs/evidence/GRV-0012/README.md` for full output and the live-site proof
(right SHA exits 0, wrong SHA exits 1).
