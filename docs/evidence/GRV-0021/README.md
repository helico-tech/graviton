# GRV-0021 evidence — app shell, level loading and time control

2026-09-18, branch `GRV-0021-app-shell`. Node v24.14.0, pnpm 11.25.0.

## What was built

The page is now the instrument's frame (GAME-0002 §8, GAME-0001 §4.11, ADR-0004 §1-2), not the
one-line build-SHA placeholder GRV-0001 left behind: a four-region layout (status bar, plot
region, selection panel, timeline strip) built from `levels/*.level.json` bundled at compile time,
running L01-intercept under a fixed-step, warp-laddered loop, with every status number read back
as `data-readout` text. `src/sim/**` and `src/levels/**` were not touched (checked below, not
merely followed).

New files: `src/app/{app,levels,loop,time,warp}.ts` (+ their `.test.ts`), `src/app/styles.css`,
`src/ui/{status,panels,plot,readouts}.ts` (+ `readouts.test.ts`), `tests/e2e/shell.spec.ts`.
Changed: `src/app/main.ts` (full rewrite of the bootstrap), `src/app/debug-api.ts` (added
`DebugApiDriver`/level-id `load`/`warpTo`/`setWarp`/`readouts` on top of the untouched
`createDebugSession`).

## Deviations from the brief, and why

- **`src/app/app.ts` and `src/ui/{plot,readouts}.ts` are new files not named in the unit's "Files"
  line.** The debug API needed something to drive beyond the raw simulation session (level
  loading, warping to a tick, warp control, and a render path a human and a headless driver both
  go through) — `app.ts` is that core, kept entirely DOM-free (no `document`, no `window`) so it's
  directly unit-testable under this repo's Node-environment Vitest (no jsdom installed).
  `readouts()` per ADR-0004 §2 must read the *live DOM*, not app-internal state, so `ui/readouts.ts`
  holds that DOM query plus the pure collector the unit test isolates over
  (`{ key, text }[] -> Record<string,string>`), exactly as the unit brief suggested. `ui/plot.ts`
  builds the canvas and its overlays.
- **`CompiledLevel` is redeclared in `src/app/levels.ts` instead of imported from
  `src/levels/compile.ts`.** The brief suggested a type-only import of it, but
  `src/levels/bundle-isolation.test.ts` is a static regex over import *specifiers* (not whether the
  import is type-only), and it already forbids anything under `src/app` from having an import
  specifier ending in `/levels/compile(.ts)?`. A type-only import trips that same regex and the
  test fails. Restating the shape (importing only `Scenario` from `src/sim/sim.ts`, which is not
  banned) keeps the guarantee the test enforces — no compiler in the shipped bundle — and is
  itself proven below by grepping `dist/`.
- **The brief is shown in the plot region, not the selection panel.** The unit's own acceptance
  list ("The brief is shown as body text") wasn't in the team lead's itemised design section, which
  described the selection panel as "header only, NO SELECTION placeholder" -- exactly. Rather than
  silently dropping the acceptance line or silently widening the selection panel past its decided
  shape, the brief (level name + the one-paragraph text, GAME-0001 §3 step 1, GAME-0002 §3's "body
  text, briefs" row) is an absolutely-positioned overlay in the bottom-left corner of the plot
  region, `pointer-events: none` so it never blocks GRV-0022's future pan/zoom. The four regions
  named in GAME-0002 §8 are unchanged; nothing was added to the selection panel.
- **`status.warp.effective` and the warp-label ease are both computed structurally from the rung**
  (`effectiveTicksThisFrame`, `TICK_BUDGET_PER_FRAME = 700`), not from measured per-frame timing.
  The unit brief for the tick budget read, in part, "...so the status bar shows the achieved ticks
  per second? NO -- keep it simple and honest: the status bar shows the nominal warp; a rung that
  exceeds the budget is clamped per frame and a `data-readout="status.warp.effective"` shows the
  achieved multiple; do not silently lie." That is exactly what's implemented: `status.warp` is
  always the nominal ladder value, `status.warp.effective` is `min(nominal, 700)` -- a fact about
  the rung, true in every frame, in debug mode and in production alike, never a measurement that
  could read differently between two otherwise-identical runs.
- **`levelIds()`/the unknown-level error list include `T00-compiler-fixture`.** The team lead's
  design was explicit -- `import.meta.glob('../../levels/*.level.json', ...)` bundles *every*
  compiled level -- and the fixture is one. Listing it as a "known id" in the error state is
  honest (it genuinely resolves), if slightly odd; flagging here per "tell me if something proves
  wrong."

## The compiled-level bundle carries no compiler code

`src/app/levels.ts` uses `import.meta.glob('../../levels/*.level.json', { eager: true, import:
'default' })`; `CompiledLevel` is restated locally rather than imported (see Deviations). Proof the
shipped bundle carries neither the compiler nor its dependencies, on top of the existing
`src/levels/bundle-isolation.test.ts` import-graph check:

```
$ pnpm build
...
dist/assets/index-gRcXB72G.js  34.40 kB │ gzip: 12.67 kB │ map: 174.75 kB
✓ built in 77ms

$ grep -il "valibot\|safeParse\|parseDocument" dist/assets/*.js
(no output -- grep exit 1, no match)

$ grep -c "L01-intercept" dist/assets/*.js
1
```

The level id string is present (the level is bundled); no valibot or YAML-parser symbol is.

## Screenshots

Three PNGs, all read directly, all well under the 400 KB evidence limit (`before.png` 8.0 KB,
`after.png` 12 KB, `error.png` 16 KB).

**`before.png`** -- the branch's base commit (`9771aa8`, built in a disposable worktree so the
real GRV-0021 worktree was never touched, then removed): a plain white page, top-left text
`GRAVITON build 9771aa8` in the browser default serif -- GRV-0001's placeholder, exactly what
`main.ts` rendered before this unit.

**`after.png`** (`pnpm screenshot --debug`, level 01 loaded, paused at tick 0) -- the dark
instrument shell: a status bar reading `T+00:00:00:00 · WARP 0x · WARP EFF 0x · POST Meskel ·
DELAY —`; a large black plot region with the level's name ("INTERCEPT") and its full brief
paragraph in the bottom-left corner, in body-text mono; a right-hand "SELECTION / No selection"
panel; a bottom "TIMELINE" strip carrying the build tag in its corner. Hairline dividers between
regions, tabular-numeral digits, condensed uppercase headers with visible tracking -- GAME-0002 §2
and §3 applied throughout, no third accent anywhere.

**`error.png`** (`?level=nope`) -- the status bar's five values are all em dashes; the plot region
shows `NO SUCH LEVEL NOPE` in alarm red (condensed, uppercase, tracked) with `Known: L01-intercept,
T00-compiler-fixture` beneath it in secondary grey; no brief overlay (there is no level to brief);
the selection panel and timeline are unchanged. `window.graviton.errors` is empty and the console
gate is clean for this run (proven by `tests/e2e/shell.spec.ts`, not just this screenshot).

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0021

 Test Files  40 passed (40)
      Tests  466 passed (466)
   Start at  09:12:41
   Duration  13.52s (transform 1.10s, setup 0ms, import 2.80s, tests 25.16s, environment 3ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

425 tests before this unit (GRV-0019's evidence), 466 after: 41 new tests across 6 new test files
(`app.test.ts`, `levels.test.ts`, `loop.test.ts`, `time.test.ts`, `warp.test.ts`,
`readouts.test.ts`) covering the
warp ladder, the tick budget and the warp-label ease, time formatting, the level registry, the
DOM-free app core (including `warpTo`'s past-tick throw and the unknown-level error path), and the
readout collector -- all pure logic, no DOM, matching this repo's Node-environment Vitest.

## `pnpm build`

```
$ vite build
vite v8.2.2 building client environment for production...
transforming...
✓ 32 modules transformed.
...
dist/assets/index-gRcXB72G.js  34.40 kB │ gzip: 12.67 kB │ map: 174.75 kB
✓ built in 77ms
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
180868.3 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
25224.8 ticks/s
```

Both goldens replay to their recorded hash unchanged -- `git status --porcelain` shows no entry
under `src/sim/` or `src/levels/` for this unit.

## `pnpm e2e` tail

```
Running 48 tests using 4 workers
  ... (console-gate, parity, shell, screenshot specs, chromium + firefox)
  2 skipped
  46 passed (7.1s)
```

New: `tests/e2e/shell.spec.ts`, 7 tests x 2 browsers = 14 of the 46 -- level 01 loads with every
status readout present and correct; `step(120)` advances `status.time` to `T+00:01:00:00` (120
ticks x 30 s dt = 3600 s); `warpTo(3298)` advances to `T+01:03:29:00` (the committed solution's own
impact tick is 3298, per GRV-0019's evidence, but no solution is applied here -- this only proves
the absolute-tick warp, as the unit brief said to); `?level=nope` shows the error state with a
clean console and `graviton.errors` empty; `]`/`[`/space step and toggle the warp ladder, read back
through `readouts()` since debug mode runs no animation loop; `readouts()`'s key set matches every
`[data-readout]` element actually in the DOM; the shell still renders with `window.graviton`
absent when `?debug=1` is missing. 2 skipped are the pre-existing Firefox screenshot-script tests
(same as every unit since GRV-0012).

## `pnpm screenshot --debug` (gate check, separate from the evidence shots above)

```
$ node scripts/screenshot.ts --debug --out docs/evidence/GRV-0021/after.png
{"url":"http://127.0.0.1:40429/?debug=1","build":"9771aa8","expected":null,"violations":[],"out":"docs/evidence/GRV-0021/after.png"}
```

`violations: []`, exit 0.

## `pnpm docs:validate`

```
$ node scripts/validate-docs.ts
docs: ok
```

## Problems outside this unit (for the team lead to file)

- None found.
