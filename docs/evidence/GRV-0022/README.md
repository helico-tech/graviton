# GRV-0022 evidence — plot renderer

2026-09-18, branch `GRV-0022-plot-renderer`. Node v24.14.0, pnpm 11.25.0.

## What was built

The system plot now draws to GAME-0002 §4-7: bodies as banded spheres (or a class glyph below
the screen-size threshold, with a hairline true-size ring), orbits as dashed ellipses, rails as a
limb tick, contacts as an amber-dim-to-confirmed-good marker, and probes as an ice-blue triangle
with a solid flown trail — through one pure `renderPlot({ ctx, view, frame, trails, canvasWidth,
canvasHeight })` (`src/render/plot.ts`) that never touches `document`, the clock or the
simulation. The same function runs unchanged in the page (`src/ui/plot.ts`, real
`CanvasRenderingContext2D`) and headless in Node (`src/headless/render.ts`, `pnpm render`,
`@napi-rs/canvas` 1.0.9). `src/render/frame.ts`'s `captureFrame` is the one place outside
`src/render` that reads a live `Sim`, turning it into a read-only `Frame` snapshot (ADR-0002
guard-rail 6); the app's flown-trail ring buffer (`src/app/trails.ts`) is sampled once per
simulation tick via a new `DebugSession.stepSampled`, shared unchanged by the browser app
(`src/app/app.ts`) and the headless CLI. The debug API gained `render()`, `frameHash()`,
`view()`/`setView()` (ADR-0004 §1); the plot owns wheel-to-zoom and drag-to-pan
(`src/ui/plot.ts`'s `createPlotController`), and a persistent scale bar and zoom readout are
drawn on the canvas with a hidden DOM twin carrying `data-readout="plot.scale"`/`"plot.zoom"`
(ADR-0004 §2). `src/sim/**` and `src/levels/**` were not touched (checked below, not merely
followed).

New files: `src/render/{ctx2d,camera,palette,frame,bodies,plot}.ts` (+ their `.test.ts`),
`src/app/trails.ts` (+ `.test.ts`), `src/headless/render.ts` (+ `.test.ts`),
`tests/render/plot.test.ts`, `tests/e2e/plot.spec.ts`. Changed: `src/app/{app,debug-api,main}.ts`
(trails, `frame()`, `stepSampled`, `captureFrame`, the composed debug-API driver), `src/ui/plot.ts`
(full rewrite: camera, input, `PlotController`), `src/app/styles.css` (the scale/zoom readout
styling, and a pre-existing bug fix below), `package.json`/`pnpm-lock.yaml` (`@napi-rs/canvas`
1.0.9, `render` script).

## Deviations from the brief, and why

- **A pre-existing GRV-0021 CSS bug hid the entire canvas and ate every pointer event, found and
  fixed.** `.plot-error { display: flex; ... background: var(--ground); }` was unconditional, so
  it beat the UA stylesheet's `[hidden] { display: none }` (equal specificity, author wins) —
  `error.hidden = true` never actually hid it. An opaque, ground-coloured div sat over the whole
  plot region at all times, invisible against GRV-0021's own ground-coloured canvas (which drew
  nothing) but, once this unit's renderer started drawing real content, it silently covered that
  content in the browser and blocked wheel/drag entirely (a real Playwright test — see below —
  timed out on `canvas.hover()` because of it). Headless renders (`pnpm render`) never touch the
  DOM and so never showed the bug, which is why it went unnoticed until the e2e run. Fixed by
  scoping the rule to `.plot-error:not([hidden])`, the standard fix for this well-known gotcha.
  Flagged here per "tell me if something proves wrong" — this is squarely a fix, not scope creep,
  since it directly blocked this unit's own acceptance (a visible, interactive plot).
- **The scale bar and zoom readout are canvas-drawn text (GAME-0002 §6, §3's "text on the plot")
  with a visually-hidden DOM twin, not a visible DOM overlay.** First cut had both visible at once
  (a DOM box at the same bottom-right margin as the canvas-drawn ruler+label) and they collided
  illegibly. Rather than drop the canvas text (which would leave `Ctx2D`'s `font`/`fillText`/
  `textAlign` unexercised and make the headless font registration pointless), the DOM twin
  (`data-readout="plot.scale"`/`"plot.zoom"`) is clipped to 1×1px — present for `readouts()`
  (ADR-0004 §2) and never seen, so it can't double the canvas's own label.
- **The headless CLI does not drive `src/app/app.ts` directly.** `app.ts` statically imports
  `src/app/levels.ts`, which calls Vite's `import.meta.glob` at module scope — a macro that only
  exists inside a Vite build and throws under plain `node src/headless/render.ts`. So the "tick-
  advance-with-trails loop" both the app and the CLI share is one level down:
  `DebugSession.stepSampled` (`src/app/debug-api.ts`, new) plus `src/app/trails.ts`'s `TrailSet`.
  `app.ts`'s `step`/`warpTo`/`loadLevel`/`load` call exactly these; `src/headless/render.ts` calls
  the identical `createDebugSession()` + `TrailSet` directly, loading the compiled level JSON off
  disk itself (`scripts/levels-verify.ts`'s own pattern) rather than through the glob-based
  bundle. Nothing is duplicated; only the level-loading edge differs per environment, which is
  exactly the boundary ADR-0002's layout draws anyway.
- **The far hemisphere of a banded sphere is darkened with a flat 35%-alpha black overlay under a
  clip, not by re-indexing into the next band down.** Both read as "one step darker"; the overlay
  is far simpler to implement correctly and is what `tests/render/plot.test.ts`'s "lit half
  brighter than dark half" statistic actually checks. If this reads as too flat once GRV-0023 adds
  selection and the plot gets more scrutiny, the per-ring re-index is a small, contained change to
  `src/render/bodies.ts`'s `drawBandedSphere`.
- **Zoom bounds (`src/render/camera.ts`'s `zoomBounds`) are a 100 m floor plus nine decades,
  widened only if a level's own system would not otherwise fit.** GAME-0002 §6 gives the two
  endpoints ("whole system" and "probe against contact") but not exact numbers; 100 m is on the
  order of the smallest capture radii the twelve-level campaign's research settled on (tens of
  km), and nine decades comfortably covers every level's system extent measured so far (L01's is
  about 0.66 au). Revisit per-level if a future level's system is small enough that "nine decades
  above 100 m" overshoots into visually meaningless zoom-out room.
- **`checkLaunch`'s existing quantised command log unit tests, and everything else under
  `src/sim`/`src/levels`, are untouched** — proven by `git status --porcelain` below showing no
  entry under either directory, and by both goldens replaying to their unchanged recorded hash.

## The renderer never imports the level compiler, and the dev bundle carries no `@napi-rs/canvas`

```
$ pnpm build
...
dist/assets/index-CX5ybDho.js   49.57 kB │ gzip: 17.50 kB │ map: 255.17 kB
✓ built in 82ms

$ grep -il "napi\|SKRSContext" dist/assets/*.js
(no output -- grep exit 1, no match)
```

`@napi-rs/canvas` is a native Node addon; it is only ever imported from `src/headless/render.ts`
and `tests/render/plot.test.ts`, never from `src/render/**`, `src/app/**` or `src/ui/**`, so it
never reaches the browser bundle.

## Screenshots

Six PNGs, all read directly, all well under the 400 KB evidence limit and 168 KB together.

**`before.png`** (level 01 loaded at tick 0, GRV-0022's base commit `eeb7987`, built in a
disposable worktree so this one was never touched) — GRV-0021's shell exactly: status bar,
selection panel, timeline, the level brief — and an entirely blank plot region. No grid, no
bodies, nothing drawn; GRV-0021 only cleared the canvas to ground colour.

**`after.png`** (`pnpm screenshot --debug`, same level, same tick, this unit's code) — the same
shell, but the plot now shows: a hairline hub-and-spoke grid; Corvai (a star, gold five-point
glyph) at the origin; a single dashed ice-blue orbit circle (Meskel and Yarune's orbits are close
enough in `a`/`e` that at this whole-system zoom they draw on top of each other, correctly); the
two bodies as small class glyphs near 3 o'clock on that circle; a scale bar and zoom readout
bottom-right reading `100 Gm` / `379 Mm/px`. Console clean (`violations: []`).

**`render-default.png`** (`pnpm render --level L01-intercept`) — the headless twin of `after.png`
at the same default view; frame hashes differ from the browser's by construction (separate
renderer key, research §3) but the picture is the same.

**`render-rail-host.png`** (`--zoom 22500 --cx <meskel.x> --cy 0`, zoomed to `900000/22500 = 40`
px screen radius) — Meskel resolved as a banded rock sphere (five bands, no gradient), a visible
darker hemisphere on the far side from Corvai, and the Meskel Rail's ice-blue limb tick at 3
o'clock (its longitude and the body's `axialPhaseAtEpoch` are both 0, so at tick 0 the tick sits
exactly on the sunward/anti-sunward axis — geometrically correct, not a rendering artefact).

**`render-contact-host.png`** (`--zoom 23750 --cx <yarune.x> --cy <yarune.y>`) — Yarune resolved
as a banded ice sphere, its own dashed orbit passing through the frame, and the Drift Hulk
contact's amber-dim square marker at 3 o'clock (uncleared at tick 0, as expected).

**`render-solution-impact.png`** (`--solution --tick 3308`, ten ticks past the recorded impact
tick 3298 from `levels/L01-intercept.evidence.json`, `--zoom 80000` centred on the probe's final
position) — the flown trail: a solid ice-blue curve arriving at Yarune, the probe's triangle
marker at its tip pointing along its final velocity, and the contact marker now
`CONFIRMED_GOOD` (green) — the hulk cleared. Rendering at exactly `--tick 3298` first (kept out of
the evidence folder, in `runs/`) showed the marker still amber: `impactTick` is the tick *during*
which `stepTick` resolved the impact, so the contact only reads cleared once the sim has advanced
one tick past it — a real semantics of `ContactState`, not a renderer bug, confirmed by reading
`src/sim/dynamics/step.ts`'s `testContactImpacts` before trusting the picture.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0022

 Test Files  46 passed (46)
      Tests  589 passed (589)
   Start at  10:05:16
   Duration  13.65s

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

589 tests, up from 502 before this unit (GRV-0021's base commit): 87 new tests across 7 new test
files (`src/render/camera.test.ts`, `src/render/palette.test.ts`, `src/render/frame.test.ts`,
`src/app/trails.test.ts`, `src/headless/render.test.ts`, `tests/render/plot.test.ts`) plus
additions to `src/app/app.test.ts` and `src/app/debug-api.test.ts` — camera round-trips and
zoom-about-cursor, the scale-bar picker table-driven, the palette/CSS custom-property parity and
marker/line registry uniqueness, `captureFrame`'s geometry against a hand-rolled scenario,
`stepSampled`'s per-tick sampling, the trail ring buffer, `renderLevel`'s flag parsing and
determinism, and real `@napi-rs/canvas` pixel statistics (ground colour off-grid, a banded
sphere's lit/dark hemispheres, a dashed orbit's stroke-and-gap, the glyph's hairline ring, the
scale bar's drawn length, and render determinism before/after `advance`).

## `pnpm build`

```
$ vite build
vite v8.2.2 building client environment for production...
✓ 38 modules transformed.
dist/assets/index-CX5ybDho.js   49.57 kB │ gzip: 17.50 kB │ map: 255.17 kB
✓ built in 82ms
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
182484.9 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
27783.3 ticks/s
```

Both hashes are unchanged from GRV-0021's evidence (`bac70a53ec8cee4b`, `fca6f5504388a83c`) —
`src/sim/**` was genuinely never touched, not merely left alone in spirit.

## `pnpm e2e` tail

```
Running 56 tests using 4 workers
...
  2 skipped
  54 passed (8.0s)
```

New: `tests/e2e/plot.spec.ts`, 4 tests × 2 browsers = 8 of the 54 — `frameHash()` is stable across
two `render()` calls with no state change and differs after `step(600)`, with `readouts()`
carrying non-empty `plot.scale`/`plot.zoom`; `setView` onto the contact's host (Yarune) fills a
35 px-radius sample region around the canvas centre to over 90% non-ground pixels, versus a
handful of glyph pixels at the default view around the same world point; URL `?zoom=&cx=&cy=`
reproduces the exact `frameHash` `setView` with the same numbers gives; wheel changes
`view().metresPerPixel` and drag changes `view().centreX`/`centreY`. 2 skipped are the
pre-existing Firefox screenshot-script tests (unrelated to this unit, same as every unit since
GRV-0012).

## `pnpm render` and `pnpm screenshot --debug` (gate checks)

```
$ node src/headless/render.ts --level L01-intercept --out runs/gate-render.png
tick 0
hash 7eb857aecd1eda50
frameHash 0096ad0cc90cd652
wrote runs/gate-render.png

$ node scripts/screenshot.ts --debug --out docs/evidence/GRV-0022/after.png
{"url":"http://127.0.0.1:32797/?debug=1","build":"eeb7987","expected":null,"violations":[],"out":"docs/evidence/GRV-0022/after.png"}
```

`violations: []`, both exit 0.

## `pnpm docs:validate`

```
$ node scripts/validate-docs.ts
docs: ok
```

## Problems outside this unit (for the team lead to file)

- None found beyond the GRV-0021 CSS bug above, which was fixed in this unit because it directly
  blocked GRV-0022's own acceptance (a visible, interactive plot) rather than being a separate
  concern.
