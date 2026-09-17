# GRV-0011 evidence — debug API over the simulation and cross-engine hash parity

2026-09-17, branch `GRV-0011-debug-api-and-cross-engine-parity`. Node v24.14.0, pnpm 11.25.0.

## What was built

Picks up `docs/issues/2026-09-17-cross-engine-hash-parity-test-missing.md` (EPIC-02 review: no
Playwright dependency, config or spec existed, so ADR-0002 guard-rail 5 was unimplemented).

1. **`src/app/debug-api.ts`.** `createDebugSession()` is DOM-free session logic over one loaded
   `Sim` plus its append-only command log: `load`, `command` (throws if `cmd.tick` precedes the
   current tick — either the sim's own clock or a later-ticked command already queued, since a
   command behind the sim's clock would silently never be applied by `advance`'s cursor), `step`,
   `hash`, `state` (a plain-number copy of the live object arrays — `x y vx vy mass hitBody
   burning` per object, never the typed arrays themselves), and `run` (a fresh, independent `Sim`,
   untouched by whatever session is loaded). `installDebugApi()` is the thin DOM layer on top: it
   installs `window.graviton` only when the URL has `debug=1`, adds `version` (`__BUILD_SHA__` +
   `SIM_VERSION`), `ready` (flips true once `document.fonts.ready` resolves — no animation loop
   exists yet, so there's nothing else to wait on), and `errors` (a live array fed by `window`
   `error`/`unhandledrejection` listeners registered at install time).
2. **`src/app/main.ts`** now calls `installDebugApi()` after the placeholder text is set; the
   placeholder itself (`GRAVITON build <sha>`) is unchanged.
3. **`playwright.config.ts`.** `chromium` and `firefox` projects; `webServer` runs `pnpm preview
   --port 4310 --host 127.0.0.1` against the **built** `dist/` (never `vite dev`), `strictPort`,
   `reuseExistingServer: false`. `vite preview`'s default host (`localhost`) resolves to the IPv6
   loopback on this machine, which a `127.0.0.1` request can't reach — bound explicitly to avoid
   that. `forbidOnly` under `CI`, no retries, `reporter: 'list'`, `testDir: 'tests/e2e'`,
   `testMatch: '**/*.spec.ts'` so it never picks up `*.test.ts`; vitest's own
   `include: ['**/*.test.ts', ...]` already excludes `*.spec.ts`, so no vitest change was needed.
4. **`tests/e2e/parity.spec.ts`**, three tests, each with an inline console/pageerror/
   requestfailed/HTTP≥400 gate (`attachGate`) that fails on *any* message of *any* type — the
   allowlisted, shared version of this gate is GRV-0012, not this unit:
   - `run()` replays `tests/golden/flyby-burn.json` in one call and asserts the hash equals the
     golden's `expectedHash` and `version.sim` equals the golden's `simVersion`.
   - The same golden is replayed through `load`/`command`/`step` in five uneven batches
     (`unevenBatches`: ratios `0.05/0.4/0.1/0.3/0.15` of the total, last batch absorbing the
     rounding remainder) and asserts the same hash — proving the session API drives the identical
     `advance` code path as `run()`, not a separate one.
   - Without `?debug=1`, `window.graviton` is asserted `undefined`.
5. **`package.json`**: `"e2e": "pnpm build && playwright test"`, kept out of the pre-push hook
   (ADR-0004: slow suites in CI only). New devDependency `@playwright/test`.
6. **`.github/workflows/ci.yml`**: a second `e2e` job (checkout, the same pnpm setup as `check`,
   frozen install, `playwright install --with-deps chromium firefox`, `pnpm e2e`), 20 min timeout,
   uploads `playwright-report/`/`test-results/` via `actions/upload-artifact@v7` only on failure
   (checked `gh api repos/actions/upload-artifact/releases/latest` — `v7.0.1`, matching the
   `actions/checkout@v7` already in `check`).

## Playwright version

ADR-0002 pins `1.62.1`. `pnpm view @playwright/test version` today reports `1.63.0` as latest
stable — installed and pinned exactly at `1.63.0` (not `^`/`~`), matching the pin style of every
other devDependency. `1.63.0`'s `playwright-core/browsers.json` wants Chromium r1243 and Firefox
r1543; the machine's cache only had r1208/r1234 and r1538 from a previous project, so
`pnpm exec playwright install chromium firefox` fetched the matching pair (`~300 MB` combined).
The ADR itself documents the `1.62.1` decision as of 2026-09-03 and is left as the historical
record; this bump is noted here rather than editing it, per the unit's instructions.

## Test-first

`src/app/debug-api.test.ts` was written and run against a nonexistent `src/app/debug-api.ts` first
— `vitest` failed the whole suite with `Cannot find module './debug-api.ts'` (0 tests ran).
`tests/e2e/parity.spec.ts` and `playwright.config.ts` were written and run next, against the
*existing* `main.ts` (no `installDebugApi()` call yet): all 4 tests touching `window.graviton`
timed out after 30 s in both Chromium and Firefox (`page.waitForFunction(() =>
window.graviton?.ready === true)` never resolves because the global never exists), while the
negative test (`window.graviton` is `undefined` without `?debug=1`) already passed — 4 failed, 2
passed. Only then was `debug-api.ts` implemented and wired into `main.ts`; both suites went green
without changing either spec.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0011


 Test Files  20 passed (20)
      Tests  187 passed (187)
   Start at  21:57:11
   Duration  2.61s (transform 702ms, setup 0ms, import 1.30s, tests 4.04s, environment 2ms)
```

No `eslint-disable`, no lint rule or tsconfig change: `debug-api.ts` lives in `src/app`, outside
`src/sim`'s restricted-globals/restricted-imports rules, and `tests/e2e` already inherits the
top-level `**/*.ts` block's merged `browser`+`node` globals, so `window`/`document` typecheck and
lint cleanly with no per-directory override needed.

`pnpm docs:validate`: `docs: ok`. `pnpm build`: `dist/index.html` 0.74 kB, `dist/assets/index-*.js`
18.92 kB (was 0.79 kB before — the sim now ships in the bundle), built in ~45 ms.

## `pnpm e2e` tail

```
$ pnpm build && playwright test
$ vite build
✓ 18 modules transformed.
dist/index.html                 0.74 kB │ gzip: 0.41 kB
dist/assets/index-Nsa0p7Z2.js  18.92 kB │ gzip: 7.49 kB │ map: 100.30 kB
✓ built in 45ms
[WebServer] $ vite preview --strictPort --port 4310 --host 127.0.0.1

Running 6 tests using 4 workers

  ✓  [chromium] › window.graviton is not installed without ?debug=1 (144ms)
  ✓  [chromium] › run() replays the golden log and matches the Node hash (236ms)
  ✓  [chromium] › load/command/step in uneven batches replays the same golden log to the same hash (218ms)
  ✓  [firefox]  › run() replays the golden log and matches the Node hash (1.0s)
  ✓  [firefox]  › load/command/step in uneven batches replays the same golden log to the same hash (1.1s)
  ✓  [firefox]  › window.graviton is not installed without ?debug=1 (864ms)

  6 passed (3.9s)
```

## Cross-engine hashes

| Engine | `run()` hash | Node (`pnpm headless`) hash | Match |
|---|---|---|---|
| Chromium 153.0.8010.12 (Playwright r1243) | `e18434ee2785b566` | `e18434ee2785b566` | yes |
| Firefox 155.0 (Playwright r1543) | `e18434ee2785b566` | `e18434ee2785b566` | yes |

`node src/headless/run.ts tests/golden/flyby-burn.json` (re-run after the change, unchanged sim
code): `tick 6000`, `hash e18434ee2785b566`, `MATCH`, ~224 000 ticks/s. All three — Node, Chromium,
Firefox — agree exactly. No mismatch: ADR-0002 guard-rail 5's promise (Node's determinism carries
across engines) holds for this golden.

## Screenshots

`before.png` and `after.png` are pixel-identical: a plain white 1280×720 page with `GRAVITON build
8908839` in the top-left corner (GRV-0001's placeholder, unchanged by this unit — the build SHA is
`8908839` because it was read from the working tree's `HEAD` at build time, before this unit's
commit exists). GRV-0011 adds no visible UI; it adds a `window.graviton` global that only exists
with `?debug=1` in the URL, which a plain screenshot can't show. That capability was verified
instead by driving the *after* build interactively with `playwright-cli` at `?debug=1`:
`window.graviton.ready` was `true` and `window.graviton.version` was `{ build: '8908839', sim: 1
}`, and the six e2e tests above exercise `load`/`command`/`step`/`hash`/`run` end to end. The
console was empty (`Total messages: 0 (Errors: 0, Warnings: 0)`) in both screenshots and after
exercising the debug API, and `window.__gravitonErrors` was `[]` throughout.

- `before.png` — built from the unmodified worktree (`pnpm build`, `pnpm preview --port 4399
  --strictPort`), Chromium via `playwright-cli`, 1280×720. `window.graviton` confirmed `undefined`
  even with `?debug=1`, since the API didn't exist yet.
- `after.png` — built after the change (`pnpm build`, `pnpm preview --port 4400 --strictPort
  --host 127.0.0.1`), same viewport. Visually identical to `before.png`, as expected for an
  API-only unit.
