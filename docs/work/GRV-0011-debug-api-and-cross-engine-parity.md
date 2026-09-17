---
id: GRV-0011
epic: EPIC-03
status: done
---
# GRV-0011 Debug API over the simulation and cross-engine hash parity

Picks up `docs/issues/2026-09-17-cross-engine-hash-parity-test-missing.md`.

**Goal.** The shipped page can run the real simulation on request, and CI proves Chromium and
Firefox produce the Node hash for the golden log (ADR-0002 guard-rail 5, ADR-0004 §1).

**Files.** `src/app/debug-api.ts`, `src/app/main.ts`, `playwright.config.ts`,
`tests/e2e/parity.spec.ts`, `package.json`, `.github/workflows/ci.yml`.

**Acceptance.**
- With `?debug=1` the page installs `window.graviton` with `version` (build SHA, `SIM_VERSION`),
  `ready`, `load`, `command`, `step`, `hash`, `state`, `run` and `errors`; without it the
  global does not exist. Only what the simulation can back today; no renderer members.
- `pnpm e2e` builds, serves `dist/` over HTTP and replays `tests/golden/flyby-burn.json` in
  Chromium and Firefox; both hashes equal the file's `expectedHash`.
- The spec fails on any console message, page error or failed request (the full gate and its
  allowlist are GRV-0012).
- CI runs it; the pre-push hook does not (ADR-0004: slow suites in CI).
- Before/after screenshots of the placeholder page and a clean console in the evidence.

**Verification.** `pnpm check`, `pnpm build`, `pnpm e2e`, CI green.

**Delivered.** `window.graviton` (with `?debug=1`) drives the real simulation headlessly; the
`run()` hash and the `load`/`command`/`step` session hash both match the Node hash
(`e18434ee2785b566`) in Chromium 153 and Firefox 155 for `tests/golden/flyby-burn.json`. Evidence
in `docs/evidence/GRV-0011/`.
