# GRV-0023 evidence — selection, readouts and the level 01 hero frame

2026-09-18, branch `GRV-0023-selection`. Node v24.14.0, pnpm 11.25.0.

## What was built

Click picks the nearest marker on the plot within a screen-pixel radius (`src/app/selection.ts`'s
`pickAt`, pure over a `Frame`/`View` -- the exact camera the renderer projects with -- priority
probe > contact > rail > body within a 1 px tie); click on nothing clears. The app
(`src/app/app.ts`) owns the resulting `{ kind, index } | null` state; the renderer
(`src/render/plot.ts`) only receives it as an argument and draws a hairline ring around the
selected marker -- ice blue for everything known, amber for an uncleared contact. Every selection
panel value comes from `describeSelection` (`src/app/selection.ts`, pure over a live `Sim`, the
compiled level's names and the ephemeris -- never the `Frame` or the renderer, determinism rule
11): body class/radius/orbital period/distance from the primary/rotation phase; rail
host/surface angle/muzzle band/cone/reload state; contact host/capture radius/minimum
energy/state/closing speed/energy; probe mass/propellant/delta-v remaining (the rocket equation
via the sim's own `dlog`)/speed/range to the nearest uncleared contact/state. Units are one
formatter module, `src/ui/format.ts` (km and kg with thousands as thin spaces, km/s to 2 decimals,
degrees to 1 decimal, hours/days for durations), table-tested; `T+dd:hh:mm:ss` timestamps reuse
the existing `src/app/time.ts` formatter rather than a second one.

`src/app/solutions.ts` bundles `levels/*.solution.json` the same way `src/app/levels.ts` bundles
compiled levels (`import.meta.glob`, no runtime fetch). `?solution=1` (and debug `loadSolution()`)
replays the loaded level's committed solution into the session's existing command log (GRV-0011's
`DebugSession.command`, reused rather than a second log concept). The timeline strip
(`src/ui/timeline.ts`) shows a horizontal axis over `[0, solution.ticks]` (or `[0, max(tick, 1)]`
with no solution loaded) with a mark per launch command, a mark per contact's recorded impact tick
once `state().contacts[i].impactTick` records one, and a present-time cursor; mark placement is a
pure function (`markFraction`, tick to x-fraction) separate from the DOM assembly around it. The
selection panel (`src/ui/selection.ts`, replacing `src/ui/panels.ts`) is the header, the selected
thing's id/name at emphasis size, then its label/value rows -- `NO SELECTION` when nothing is
picked; every value carries `data-readout="selection.<field>"`, every timeline mark
`data-readout="timeline.<mark>"` (ADR-0004 §2).

Debug API gained `select`, `selection`, `loadSolution`; `state()` gained `bodies: {x,y}[]` (a
headless click driver needs a body's position and had no accessor for one). `pnpm render` gained
`--select <kind>:<index>`, passed straight through to `renderPlot` -- it does not duplicate
`pickAt`/`describeSelection`. `scripts/screenshot.ts` gained `--solution`/`--tick`/`--zoom`/`--cx`/
`--cy`/`--select`, each setting the same-named `?param=` `main.ts` already reads, so a hero frame
is one `pnpm screenshot` call. `src/sim/**` and `src/levels/**` were not touched (checked below,
not merely followed).

New files: `src/app/{selection,solutions}.ts` (+ `.test.ts`), `src/ui/{format,selection,timeline}.ts`
(+ `format.test.ts`, `timeline.test.ts` for the pure `markFraction`), `tests/e2e/selection.spec.ts`.
Changed: `src/app/{app,debug-api,main}.ts`, `src/app/styles.css` (selection/timeline layout),
`src/render/plot.ts` (the selection ring), `src/ui/plot.ts` (click-to-select wiring),
`src/headless/render.ts` (`--select`), `scripts/screenshot.ts` (`--solution`/`--tick`/`--zoom`/
`--cx`/`--cy`/`--select`). Removed: `src/ui/panels.ts` (split into `selection.ts`/`timeline.ts`,
matching the file names GRV-0023's own design calls for).

## Deviations from the brief, and why

- **`pickAt`'s signature carries `canvasWidth`/`canvasHeight` alongside `frame`/`view`/`screenX`/
  `screenY`/`radiusPx`.** The brief's shorthand omitted them, but `worldToScreen`
  (`src/render/camera.ts`) -- the exact projection the renderer itself uses, which `pickAt` is
  built to match -- needs the canvas size to place its origin; there is no way to pick against "the
  camera the renderer uses" without it. Mechanical, not a design change.
- **A probe expended on a body's surface reads a bare `EXPENDED`, with no `AT T+...`.**
  `ContactState.impactTick` gives a tick for a contact hit; `DynamicObjects.hitBody` records which
  body was hit but no tick at all. Filed as
  `docs/issues/2026-09-18-probe-body-hit-has-no-recorded-tick.md` (P3) rather than widening this
  unit to add tick-tracking to a `src/sim` struct outside its stated files -- no level in the
  current campaign ends a flight against a body, so it's untested in practice either way.
  `src/app/selection.test.ts` covers the case directly so the gap is at least visible in the suite.
- **Timeline marks are keyed by numeric index (`launch.0`, `impact.0`), not a level id.** Launch
  commands have no id of their own to key by, and using the contact's `contactIds` string for
  impacts but an index for launches would be one inconsistent scheme instead of one consistent one;
  index is stable for the run's duration either way (`DynamicObjects`/`ContactTable` are dense,
  index-stable arrays per the determinism contract).
- **The muzzle band and a body's orbital period both need one figure to stand between two others**
  (`120.00 km/s – 200.00 km/s`, GAME-0002's own vocabulary uses an en dash for exactly this kind of
  range elsewhere in this codebase's prose). Not specified by the brief; chosen for legibility over
  a bare hyphen, which can misread as a minus sign next to negative-capable coordinates elsewhere on
  the panel.
- **`selectionReadouts()`/`describeSelection(level, null)` must never throw, even before anything
  is loaded.** First cut called the loaded `Sim` unconditionally before checking the selection,
  which is fine for every other call `App`/`DebugSession` expose (`state()`/`hash()`/`frame()` are
  all documented to throw before a load) but broke `main.ts`'s own bootstrap: `onChange` now calls
  `selectionReadouts()` on every state change, including the one a *failed* `loadLevel` emits, and
  that throw stopped the whole module before `installDebugApi` ran -- caught by
  `tests/e2e/shell.spec.ts`'s pre-existing "unknown level" test timing out waiting for
  `window.graviton.ready`. Fixed in `src/app/debug-api.ts`'s `describeSelection`: a null selection
  short-circuits before touching the loaded sim, matching what the pure function underneath already
  did. Regression tests added in both `debug-api.test.ts` and `app.test.ts`.
- **`checkLaunch`'s existing quantised command log unit tests, and everything else under
  `src/sim`/`src/levels`, are untouched** -- proven by `git status --porcelain` below showing no
  entry under either directory, and by both goldens replaying to their unchanged recorded hash.

## `src/sim`/`src/levels` untouched

```
$ git status --porcelain -- src/sim src/levels
(no output)
```

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0023

 Test Files  50 passed (50)
      Tests  680 passed (680)
   Start at  10:48:12
   Duration  13.88s

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

680 tests, up from 589 before this unit (GRV-0022's base): 91 new across
`src/ui/{format,timeline}.test.ts` (new), `src/app/{selection,solutions}.test.ts` (new),
`tests/render/plot.test.ts` (the selection ring, 4 new cases) plus additions to
`src/app/{app,debug-api}.test.ts` and `src/headless/render.test.ts`/`scripts/screenshot.test.ts`
(the new flags) -- `pickAt`'s priority and radius table-driven including a sub-pixel tie,
`describeSelection` for every kind against independently computed values (a body's period from
`2*pi*sqrt(a^3/mu)`, a probe's delta-v from `Math.log` against the code's own `dlog`), the format
table, the solutions registry, `markFraction`, and the two bootstrap-breaking regressions above.

## `pnpm build`

```
$ vite build
vite v8.2.2 building client environment for production...
✓ 44 modules transformed.
dist/assets/index-CdN_KPsl.js   59.87 kB │ gzip: 20.66 kB │ map: 303.37 kB
✓ built in 90ms

$ grep -il "napi\|SKRSContext" dist/assets/*.js
(no output -- grep exit 1, no match)
```

`@napi-rs/canvas` still never reaches the browser bundle (only `src/headless/render.ts` and
`tests/render/plot.test.ts` import it).

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
197778.6 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
22867.7 ticks/s
```

Both hashes unchanged from GRV-0022's evidence (`bac70a53ec8cee4b`, `fca6f5504388a83c`) --
`src/sim/**` was genuinely never touched, not merely left alone in spirit.

## `pnpm e2e` tail

```
Running 64 tests using 4 workers
...
  2 skipped
  62 passed (8.7s)
```

New: `tests/e2e/selection.spec.ts`, 4 tests x 2 browsers = 8 of the 62 -- clicking the rail host
(Meskel) selects it and every panel field matches a value computed independently in the spec from
the compiled level (period from `2*pi*sqrt(a^3/mu)`, distance from `a*(1-e)` at `meanAnomaly0=0`);
after `loadSolution()` + `warpTo(impactTick + 1)` (the evidence file's own recorded tick, read from
disk in the spec -- `+1` because `impactTick` is the tick the impact resolves *during*, per
GRV-0022's own README note), selecting the probe reads `EXPENDED AT ...` and selecting the contact
reads `CLEARED AT ...`; clicking empty space (a far-zoomed-out corner) clears the selection back to
`NO SELECTION`; `readouts()` keys equal exactly the panel's `[data-readout]` DOM keys, both ways.
2 skipped are the pre-existing Firefox screenshot-script tests (unrelated to this unit, same as
every unit since GRV-0012).

## `pnpm render` and `pnpm screenshot --debug` (gate checks)

```
$ node src/headless/render.ts --level L01-intercept --out runs/gate-render.png
tick 0
hash 7eb857aecd1eda50
frameHash 7828377ae08f7ce8
wrote runs/gate-render.png

$ node scripts/screenshot.ts --debug --out runs/gate-screenshot.png
{"url":"http://127.0.0.1:41975/?debug=1","build":"ff92307","expected":null,"violations":[],"out":"runs/gate-screenshot.png"}
```

`violations: []`, both exit 0.

## `pnpm docs:validate`

```
$ node scripts/validate-docs.ts
docs: ok
```

## Screenshots

Five PNGs, all read directly, all well under the 400 KB evidence limit (216 KB together).

**`before.png`** (level 01 at tick 0, `?debug=1`, base commit `6262368`, built in a disposable
worktree so this one was never touched) -- the selection panel reads the old placeholder text
"No selection" and the timeline strip is a bare header plus the build tag, no axis.

**`after.png`** (`pnpm screenshot --debug`, same level, same tick, this unit's code) -- same
shell, same plot; the selection panel now reads "NO SELECTION" (uppercase, this unit's literal
placeholder text) and the timeline strip has grown a hairline axis with a present-time cursor tick
at its very start (`T+00:00:00:00`, tick 0 of a 1-tick default range). Console clean
(`violations: []`).

**`after-selected.png`** (`pnpm screenshot --debug --zoom 22500 --cx 96759902768.76 --cy 0
--select body:1`, Meskel's own position at tick 0) -- Meskel resolved as a banded rock sphere with
a hairline ice-blue selection ring around it (4 px outside its true screen radius). The panel
reads: header "SELECTION", emphasis line "Meskel", then CLASS Rock, RADIUS 900 km,
PERIOD 1746d 14h, DISTANCE 96 759 903 km, PHASE 0.0°. Hand-checked: period
`2*pi*sqrt(98734594662^3 / 1668574999999999700)` = ~150 963 850 s = 1746 d 14 h; distance
`98734594662 * (1 - 0.02)` = 96 759 902 768.76 m = 96 759 903 km (meanAnomaly0 is 0, so Meskel
sits exactly at periapsis at tick 0) -- both match the panel exactly.

**`hero-screenshot.png`** (`pnpm screenshot --solution --tick 3299 --zoom 23750 --cx
97195481675.3563 --cy 3386123586.7731123 --select probe:0`, Yarune's position one tick past the
recorded impact) -- the hero frame: Yarune as a banded ice sphere, the probe's solid ice-blue
flown trail arriving at it, the Drift Hulk contact marker now `CONFIRMED_GOOD` (cleared), and a
selection ring around the probe. The panel reads PRB-01, MASS 1 100 kg, PROPELLANT 680 kg,
DELTA-V 29.85 km/s, SPEED 124.12 km/s, RANGE — (no uncleared contact left to range to), STATE
"EXPENDED AT T+01:03:29:00". The timeline shows a launch mark near tick 2464
(`T+00:20:32:00`) and the cursor at tick 3299 (`T+01:03:29:00`) -- the impact mark (tick 3298) sits
one tick beneath the cursor, visually indistinguishable from it at this axis scale, which is
correct, not missing.

**`hero-render.png`** (`pnpm render --level L01-intercept --solution --tick 3299 --select probe:0
--zoom 23750 --cx 97195481675.3563 --cy 3386123586.7731123`) -- the headless twin of
`hero-screenshot.png` at the identical camera and tick: the same sphere, the same two crossing
lines (the flown trail and Yarune's own dashed orbit passing through at this zoom), the same
selection ring. No DOM panel (this tool draws only the canvas); frame hash differs from the
browser's by construction (separate renderer key, research §3), the picture is the same.

## Problems outside this unit (for the team lead to file)

- `docs/issues/2026-09-18-probe-body-hit-has-no-recorded-tick.md` (P3, filed this unit): a probe
  that expends on a body's surface has no recorded tick anywhere in `Sim`, unlike a contact hit.
  Invisible today (no campaign level ends a flight against a body); worth a look before one does.
- Everything else found was fixed within this unit's own scope (the `describeSelection`/bootstrap
  regression above) since it directly blocked the unit's own acceptance, per "fix vs. file" -- no
  further findings.
