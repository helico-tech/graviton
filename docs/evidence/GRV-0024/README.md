# GRV-0024 evidence — EPIC-05 review fixes

2026-09-18, branch `GRV-0024-epic05-review-fixes`. Node v24.14.0, pnpm 11.25.0.

## What was built

Post-EPIC-05-review fixes, five issues, no `src/sim`/`src/levels`/`src/render` touched.

1. **`src/app/loop.ts`: `warpEaseFrame`, replacing the two-branch decision that used to live
   inline in `main.ts`'s rAF callback**
   (`docs/issues/2026-09-18-warp-label-sticks-on-eased-value.md`, P1). The shipped code wrote
   `round(easedWarpValue(...))` only while `elapsed < WARP_EASE_MS`, then stopped writing --
   assuming the last write had already landed on the target. Real frame spacing never guarantees a
   frame lands inside a 150 ms window, so the label stuck mid-ease (the issue recorded 200x, 380x
   and 1093x live). `warpEaseFrame({ from, to, elapsedMs })` returns `{ value, finished }`;
   `finished` is `elapsedMs >= durationMs`, and whenever it's true `value` is exactly `to`, never a
   rounded-but-not-quite fraction. `main.ts`'s frame loop now writes `status.warp.textContent`
   every animated frame unconditionally, from this one value, and only clears the animation once
   `finished` says so.
2. **`tests/e2e/loop.spec.ts`** (`docs/issues/2026-09-18-real-loop-has-no-e2e-test.md`, P2). Every
   existing spec loads `?debug=1`, which never starts the animation loop (ADR-0004 §1), so the
   tick-budget clamp, the fixed-step frame and the warp ease had never run under a test -- exactly
   how the bug above shipped. The new spec loads `/?level=L01-intercept` with no debug flag,
   presses `]` five times, waits 600 ms of real time, and asserts `status.time` parses to a
   positive whole multiple of `dt` (30s), `status.warp` reads `10000x` (the bug's own regression
   check) and `status.warp.effective` is a `\d+x` string no greater than 10000; then presses space,
   waits 300 ms twice and asserts `status.time` is unchanged between the two reads and
   `status.warp` reads `0x`. Both browsers, strict console gate, generous waits and no exact tick
   or frame count so it stays robust on a slow runner.
3. **The build tag moved into the status bar** (`docs/issues/2026-09-18-timeline-label-collides-
   with-build-tag.md`, P3). `src/ui/status.ts`'s `createStatusBar` now takes `{ buildSha }` and
   appends a `data-readout="status.build"` span, pushed to the bar's right edge by
   `margin-left: auto` (`.build-tag` in `src/app/styles.css`). `src/ui/timeline.ts`'s
   `createTimelineStrip` no longer takes a `buildSha` or builds the tag -- the strip keeps only its
   own axis. `scripts/screenshot.ts`'s non-debug build-SHA path (`parseBuildFromAppText`, a regex
   over `#app`'s text) and the debug path (`window.graviton.version.build`) both still work --
   `#app` wraps the whole shell either way, so the regex doesn't care which panel the text sits in;
   verified directly below.
4. **ADR-0004 §1's `loadRun` line marked superseded** (`docs/issues/2026-09-18-adr-0004-loadrun-
   renamed-run.md`, P3): GRV-0011 shipped it as `run`, matching `debug-api.ts`'s actual surface.
5. **The duplicate no-debug assertion removed from `tests/e2e/parity.spec.ts`**
   (`docs/issues/2026-09-18-duplicate-no-debug-e2e-test.md`, P3), keeping the more thorough one in
   `shell.spec.ts` (which also asserts the shell still renders).

## Test-first: reproducing the warp-label bug, then fixing it

`src/app/loop.test.ts` adds `FRAME_ELAPSED_MS = [0, 16.7, 33.1, 51, 149.9, 150, 166]` --
representative real-rAF-like spacing (~60fps, one delayed frame) that straddles the 150 ms boundary
without any sample landing on it exactly.

- **`oldLoopFinalLabel`** is a faithful extraction of `main.ts`'s shipped per-frame branch: write
  `round(easedWarpValue(...))` while `elapsed < WARP_EASE_MS`, otherwise stop. Run against the two
  jumps this unit cares about:
  ```
  oldLoopFinalLabel({ from: 10000, to: 0 })    // 7,    not 0
  oldLoopFinalLabel({ from: 0, to: 10000 })    // 9993, not 10000
  ```
  (elapsed 149.9 is the last frame under the boundary; `easedWarpValue` there is 99.93% of the way
  through the ease, not 100%.) Both assertions (`not.toBe(target)`) pass against this faithful
  extraction -- the bug reproduces.
- **`warpEaseFrame`** is then exercised directly (`is not finished ... before the duration
  elapses`, `is finished and exactly the target at the duration`, `... past the duration, however
  far a frame overshoots it`) and through the same frame-loop harness, but always writing
  `warpEaseFrame`'s value and stopping only on `finished`:
  ```
  finalLabel({ from: 10000, to: 0 })    // 0
  finalLabel({ from: 0, to: 10000 })    // 10000
  ```
  Both land exactly on target. `main.ts` was then wired to this same always-write/stop-on-finished
  shape.

## Verifying both build-SHA paths still work

```
$ pnpm build
✓ built in 85ms

$ node scripts/screenshot.ts --out runs/a.png --expect-build 65e9dbf
{"url":"http://127.0.0.1:41737/","build":"65e9dbf","expected":"65e9dbf","violations":[],"out":"runs/a.png"}
$ echo exit=$?
exit=0

$ node scripts/screenshot.ts --out runs/b.png --debug --expect-build 65e9dbf
{"url":"http://127.0.0.1:33837/?debug=1","build":"65e9dbf","expected":"65e9dbf","violations":[],"out":"runs/b.png"}
$ echo exit=$?
exit=0
```

The non-debug run's `build` came from `parseBuildFromAppText` over `#app`'s text (now reading the
status bar's `.build-tag`, not the timeline's); the debug run's came from
`window.graviton.version.build`. Both matched `--expect-build`, and `tests/e2e/screenshot.spec.ts`
(below) exercises the same two paths through Playwright's own test runner.

## Screenshot: the timeline/build-tag collision, before and after

**`docs/evidence/GRV-0023/hero-screenshot.png`** (before, GRV-0023's own evidence, unchanged by
this unit) shows `T+01:03:29:30` (the timeline's cursor label) drawn directly under
`GRAVITON build ff92307` at the strip's right end -- the collision
`docs/issues/2026-09-18-timeline-label-collides-with-build-tag.md` reports.

**`docs/evidence/GRV-0024/hero-screenshot.png`** (after, identical camera and tick -- the same
`pnpm screenshot` call GRV-0023's evidence used, just re-run against this unit's build):

```
$ node scripts/screenshot.ts --solution --tick 3299 --zoom 23750 --cx 97195481675.3563 \
    --cy 3386123586.7731123 --select probe:0 --out docs/evidence/GRV-0024/hero-screenshot.png
{"url":"...&solution=1&tick=3299&zoom=23750&...","build":"65e9dbf","expected":null,"violations":[],"out":"docs/evidence/GRV-0024/hero-screenshot.png"}
```

Read directly: the build tag now sits at the status bar's top-right corner (`GRAVITON build
65e9dbf`, next to T/WARP/WARP EFF/POST/DELAY), and the timeline strip's bottom-right corner holds
only its own cursor label -- nothing drawn under it. Everything else in the frame (the probe
selection panel, the intercept brief, the timeline marks) is pixel-for-pixel the scenario GRV-0023
already proved; this unit only moved the build tag.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0024


 Test Files  50 passed (50)
      Tests  687 passed (687)
   Start at  11:20:31
   Duration  14.21s (transform 1.54s, setup 0ms, import 3.55s, tests 27.06s, environment 4ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

`pnpm docs:validate`: `docs: ok`.

## `pnpm e2e` tail (Chromium + Firefox)

```
$ pnpm build && playwright test
...
Running 64 tests using 4 workers

  ✓   1 [chromium] › tests/e2e/console-gate.spec.ts:37:1 › fails on console.error (130ms)
  ...
  ✓  11 [chromium] › tests/e2e/loop.spec.ts:27:1 › ] warps to the top rung and advances time in whole dt ticks; space freezes it at 0x (1.4s)
  ...
  ✓  32 [chromium] › tests/e2e/shell.spec.ts:118:1 › window.graviton is not installed without ?debug=1, and the shell still renders (154ms)
  ...
  -  52 [firefox] › tests/e2e/screenshot.spec.ts:37:1 › succeeds and writes a PNG when the build matches
  -  53 [firefox] › tests/e2e/screenshot.spec.ts:51:1 › exits non-zero when --expect-build does not match
  ✓  43 [firefox] › tests/e2e/loop.spec.ts:27:1 › ] warps to the top rung and advances time in whole dt ticks; space freezes it at 0x (1.7s)
  ...

  2 skipped
  62 passed (10.2s)
```

The two skips are `screenshot.spec.ts`'s pre-existing `test.skip(browserName !== 'chromium', ...)`
(it drives the CLI script once, not once per browser project) -- unrelated to this unit. Every
other spec, including both browsers' `loop.spec.ts` and `parity.spec.ts` (now one no-debug
assertion instead of two), passed.

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
196903.8 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
25589.2 ticks/s
```

Both hashes are unchanged from prior units -- expected, since `src/sim/**` was not touched (checked
via `git status`/`git diff` against `src/sim/`, not merely followed).
