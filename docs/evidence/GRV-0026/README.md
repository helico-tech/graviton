# GRV-0026 evidence — planner overlay

2026-09-18, branch `GRV-0026-planner-overlay`. Node v24.14.0, pnpm 11.25.0.

## What was built

`src/app/planner.ts` (DOM-free, unit-tested): explicit planner state --
`{ draft: FlightPlan | null; drag: Drag | null; horizon: number | null; ghost: Ghost | null;
cache: GhostCache | undefined }` plus one addition beyond the design note's own tuple,
`selectedNode: number | null` (see "Deviations" below) and `launchRejection: LaunchRejection | null`
(checkLaunch's own reason, carried alongside the ghost so the PLAN panel never re-derives it).
Pure transitions: `beginLaunchDrag`, `updateLaunchDrag` (heading = the quantised absolute angle of
the drag vector from the rail's own muzzle point at the draft's launch tick; speed =
`muzzleMin * (muzzleMax/muzzleMin)^clamp(len/L, 0, 1)`, `L` a fixed 160 px reference converted to
world metres by the camera, quantised to mm/s), `endDrag`, `addNode` (within the level's node
budget, past the launch tick, selects the new node), `beginNodeDrag`/`updateNodeDrag` (component =
projection of the drag vector onto the ghost's own velocity direction at the node's tick, or its
perpendicular, scaled by a fixed 120 px/200 m/s reference), `removeNode` (shifts a later
selection/drag index down), `selectNode`, `setHorizon`, and `reintegrate` -- snaps
`launchTick = nowTick + 1` once the sim's clock reaches or passes it, runs `checkLaunch`
(sim/commands.ts, reused exactly for the purpose its own doc comment names: "so the planner UI can
explain a disabled launch before the player commits") against a throwaway `Sim` replayed to that
tick, and only calls `integrateGhost` (src/planner/ghost.ts, untouched) when the launch is
feasible -- an infeasible one draws no ghost, `launchRejection` carries the reason.

`src/render/ghost.ts`: `buildPlannerFrame` turns a `Ghost`/`FlightPlan` into plain world-space
geometry (dashed path, node squares, the selected node's prograde/lateral handle stems, event
marks, a live launch-vector preview) -- type-only imports from `src/planner`, so `src/render`
still carries no runtime dependency on it (matches `src/render/frame.ts`'s own stated boundary
against `src/app`/`src/levels`). `drawPlannerFrame` draws it; `renderPlot` (`src/render/plot.ts`)
takes it as a new optional `planner` argument, drawn after bodies/rails/contacts/trails/probes/the
selection ring. `LINE_STYLES.ghost` (`palette.ts`, dash `[3, 3]`) is the ghost path's own dash
pattern, distinct from a body's orbit.

`src/render/frame.ts`'s `captureFrame` gained an optional `t` override: bodies/rails/contacts
(tier one, O(1) at any time) read it when given, `objects` (probes, no analytic position away from
"now") and `Frame.tick` never do -- the horizon scrub's own contract, GAME-0001 §4.6. `App.frame()`
(`src/app/app.ts`) reads `plannerState.horizon` to supply it automatically; every other caller is
unaffected (`horizon` defaults to `null`).

`src/app/app.ts` gained the planner surface: `plan`, `setPlan`, `discardDraft`, `beginLaunchDrag`,
`updateLaunchDrag`, `beginNodeDrag`, `updateNodeDrag`, `endDrag`, `selectNode`, `selectedNode`,
`drag`, `addNode`, `removeNode`, `ghost`, `planSolution` (the ghost's own `SolutionReadout`,
deliberately not named `solution` -- that already means the committed *campaign* solution log),
`planIssues` (`validatePlan` issues plus a formatted `checkLaunch` rejection, the PLAN panel's own
"disabled with a reason" text), `setHorizon`, `horizon`, `commitPlan` (appends `planToCommands` at
the draft's own future launch tick, throws on an empty or invalid draft). `timelineData()` gained
ghost-derived marks (`ghost.node.<i>`, `ghost.closestApproach.<contact>`, `ghost.impact.<contact>`
-- prefixed so they never collide with a committed solution's own `launch.<i>`/`impact.<contact>`
keys, a real case once a second probe targets an already-cleared contact). `src/app/debug-api.ts`
gained `DebugSession.log()` (the committed log by reference -- `reintegrate` needs to replay it,
and nothing else in `src/app` previously needed it outside this module) and `captureFrame`'s `t`
passthrough; `window.graviton` gained exactly the five members the design note lists:
`plan()`, `setPlan(plan)`, `commitPlan()`, `setHorizon(tick|null)`, `solution()`
(`driver.planSolution()` under the hood).

`src/ui/{planner,solution}.ts`: the PLAN and SOLUTION panels (DOM assembly only, `NO DRAFT`/
`NO SOLUTION` placeholders under their own class names -- see "Deviations"), Commit/Discard as
`.instrument-key` buttons (no animation, GAME-0002 §9), disabled + a visible reason
(`.plan-issue`, amber) when the draft is invalid. `src/ui/plot.ts` gained a generic pointer-claim
protocol (`onPlannerDown`/`onPlannerDrag`/`onPlannerRelease`, mirroring `onSelect`'s own
main.ts-owns-the-hit-test split) and a `getPlanner` render callback. `src/ui/timeline.ts` gained
`attachTimelineScrub` -- pressing the cursor itself and dragging reports a tick, releasing reports
`null`; gated to "paused only" by `main.ts`'s own `canScrub`, not baked into the pure mapping.
`src/app/main.ts` wires all of it: rail marker -> launch drag, a selected node's own handle ->
node drag, any ghost node -> select + drag its prograde handle, within 4 px of the ghost path ->
`addNode`, otherwise the existing select/pan flow (the design note's own literal priority order);
`Delete` removes the selected node, `Enter` commits (only when valid), `Escape` discards.
`src/app/styles.css` gained the PLAN/SOLUTION panel layout (a `.right-column` wrapper now carries
`grid-area: selection` so SELECTION/PLAN/SOLUTION stack inside it) and the instrument-key/plan-
issue styles.

`src/sim/**`, `src/levels/**`, `src/planner/**` untouched throughout (checked below).

## Deviations from the brief, and why

- **`PlannerState` carries `selectedNode: number | null`, one field beyond the design note's own
  five-field tuple.** "Handles only for the selected/dragged node" and "Delete removes the
  selected node" both need a selection that outlives the drag gesture itself (you place or click a
  node, release, and its handles must stay visible and Delete-able) -- `drag` alone can't carry
  that, since it's `null` the instant the gesture ends. Adding a field felt more honest than
  overloading `drag` to mean two different things, and it stays entirely inside this unit's own
  file (`src/app/planner.ts`) rather than touching the existing `src/app/selection.ts`/`Selection`
  machinery (which has no `'node'` kind and extending it would have widened this diff well past
  the unit's own file list for a UI nuance). Flagging it here rather than folding it in silently,
  per the brief's own "tell me if something proves wrong rather than improvising".
- **The PLAN/SOLUTION empty-state placeholders are `.plan-empty`/`.solution-empty`, not
  `.placeholder` (`src/ui/selection.ts`'s own class).** Reusing `.placeholder` verbatim broke
  `tests/e2e/selection.spec.ts`'s own "clicking empty space clears the selection" test, which
  asserts `.placeholder` resolves to exactly one element -- a real regression caught by `pnpm e2e`,
  fixed by giving the two new empty states their own class names (still sharing the same visual
  style via one combined CSS rule) rather than touching that pre-existing test file, which sits
  outside this unit's own file list.
- **Node handle dragging needs an already-integrated ghost sample at the node's own tick.** A
  node's screen position (and so its handle geometry) comes from the ghost, not from anything the
  draft alone carries -- `updateNodeDrag` is a documented no-op without one (covered directly in
  `src/app/planner.test.ts`). In practice this never surfaces to the player: a node can only ever
  be placed by clicking *on* an already-drawn ghost path, so a sample at its own tick always
  already exists by construction.
- **`checkPlanLaunch` (inside `reintegrate`) builds and replays its own throwaway `Sim`, separate
  from `integrateGhost`'s own internal one.** `checkLaunch` needs `sim.objects.count`/
  `railLastLaunchTick` as of the draft's launch tick, which only a replay can produce, and
  `integrateGhost` doesn't expose a way to run just that check without also committing to the full
  integration. The extra replay roughly doubles a cold reintegrate's cost (still well under a
  millisecond-per-tick budget for any realistic draft -- see throughput below); not sharing it
  with `integrateGhost`'s own cold path felt like a smaller unit than reworking `src/planner/
  ghost.ts`'s own internals, which this unit's rules leave untouched.
- **`GHOST_HORIZON_TICKS` (20000, `src/app/planner.ts`) is a fixed margin added to "now", not a
  per-level value.** The design note doesn't specify one; 20000 ticks comfortably covers
  L01-intercept's own ~3300-tick committed flight with headroom for a longer player-drafted one,
  and a larger horizon than a flight needs costs only unused buffer space (the ghost stops
  integrating early on impact or a body hit either way) -- not wall time.

## `src/sim`/`src/levels`/`src/planner` untouched

```
$ git status --porcelain -- src/sim src/levels src/planner
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

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0026

 Test Files  54 passed (54)
      Tests  724 passed (724)
   Start at  12:52:07
   Duration  ~14s

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

724 tests, up from 702 before this unit (GRV-0025's base): 22 new, all in
`src/app/planner.test.ts` (table-driven launch-drag length-to-speed mapping and quantisation, cone
rejection surfacing, launch-tick snapping, cache reuse -- `ticksIntegrated` 0 on an unrelated
re-integrate, resumed rather than full on a later-node edit -- node add/drag/remove including the
zero-burn guard). `scripts/validate-docs.test.ts`'s own pre-existing repo-wide check now also
covers this evidence folder, with no new test count of its own.

## `pnpm docs:validate`

```
$ node scripts/validate-docs.ts
docs: ok
```

## `pnpm build`

```
$ vite build
✓ 53 modules transformed.
dist/assets/index-*.css   29.21 kB │ gzip: 15.67 kB
dist/assets/index-*.js    88.29 kB │ gzip: 28.76 kB
✓ built in ~100ms

$ grep -c "solveLevel\|compassSearch\|searchRail" dist/assets/index-*.js
0
$ grep -c "yaml\|valibot" dist/assets/index-*.js
0
```

Up from 60.06 kB (GRV-0025's base, planner not yet wired into the app) -- the solver's own heavy
search code (`solveLevel`/`compassSearch`/`searchRail`, `src/levels/solve.ts`) tree-shakes out
entirely even though `src/app/planner.ts` imports `quantizeHeading`/`quantizeSpeed` from the same
module (for the exact quantisation the command log itself uses); no YAML parser or validator
reaches the bundle either, matching `src/levels/bundle-isolation.test.ts`'s own guard (its banned-
specifier regex only covers `compile`/`schema`/`units`, and `solve.ts`'s own runtime imports never
reach any of the three).

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
199579.1 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
25704.1 ticks/s
```

Both hashes unchanged from GRV-0025's own recorded values -- expected, `src/sim/**` was not
touched.

## `pnpm e2e` (Chromium + Firefox)

```
74 passed, 2 skipped (the pre-existing screenshot.spec.ts Chromium-only skips, unrelated)
```

10 new in `tests/e2e/planner.spec.ts`, both browsers: `setPlan` with level 01's own committed
solution reproduces the evidence file's own recorded `impactTick` and `cleared: true` through
`solution()`; commit + `warpTo(impactTick + 1)` reads `state().contacts[0].cleared === 1` and the
probe's own `hitContact === 0`; a real mouse drag off T00-compiler-fixture's rail sets heading/
speed within the muzzle band; a real click on the ghost path places a node whose `atTick` matches
the nearest sample exactly (a reference `createSim`/`advance` run at the same plan, the ghost
invariant already proven in `src/planner/ghost.test.ts`), and a real drag on its handle increases
`prograde` while `lateral` stays untouched; `setHorizon`/`frameHash()` prove the horizon scrub
changes the drawn frame and reverts exactly.

A regression this run caught and fixed: `tests/e2e/selection.spec.ts`'s own "clicking empty space
clears the selection" broke the moment the new PLAN/SOLUTION panels' empty states reused
`.placeholder` -- see "Deviations" above.

## `pnpm screenshot --debug`

```
$ node scripts/screenshot.ts --debug --out runs/gate-screenshot.png
{"url":"http://127.0.0.1:.../?debug=1","build":"<sha>","expected":null,"violations":[],"out":"runs/gate-screenshot.png"}
```

`violations: []`, exit 0.

## Screenshots

Three PNGs, all read directly, all well under the 400 KB evidence limit (46 KB + 54 KB + 10 KB).

**`before.png`** (`?debug=1`, base commit `1d42623` -- the spec-only commit this unit started
from, built in a disposable worktree so this one was never touched) -- SELECTION panel only,
"NO SELECTION"; no PLAN or SOLUTION panel exists yet; the timeline strip is a bare axis with just
the present-time cursor at tick 0.

**`draft-ghost.png`** (T00-compiler-fixture, a hand-built draft: launch along the rail's own local
vertical at mid-band speed, one node 30 ticks in, selected via a real pointer click at its own
world position -- `window.graviton` has no `selectNode` of its own, matching the debug API's
literal five-member list; a real click is what the design note's own input section calls for
anyway) -- the dashed ghost path (KNOWN, its own `[3, 3]` dash pattern), the node as a small
filled square, its prograde handle extending forward along the path and its lateral handle
perpendicular, both hairline stems with a dot at each tip. The PLAN panel reads RAIL "Tesh
Nearside Rail", LAUNCH T+00:00:00:30, HEADING 214.5°, SPEED 180.00 km/s, NODE 1 T
T+00:00:15:30, NODE 1 PRO 0.01 km/s, NODE 1 LAT 0.00 km/s, Commit and Discard both enabled (the
draft is structurally valid and the launch itself is feasible, even though the flight happens not
to clear T00's own fixture contact). The SOLUTION panel reads PCA T+00:00:37:00, MISS 4 865 km,
ARRIVAL 180.42 km/s, T.O.F. 36m, DELTA-V 29.84 km/s, IMPACT E —, CLEARS NO.

**`solution-panel.png`** (an element screenshot of just `.solution-panel`, L01-intercept's own
committed solution loaded as the draft via `setPlan`) -- the same panel predicting the flight
*before* committing it: PCA T+01:03:29:30, MISS 118 km, ARRIVAL 120.09 km/s, T.O.F. 6h 57m,
DELTA-V 29.85 km/s, IMPACT E 7.93 TJ, CLEARS YES. `IMPACT E` matches
`levels/L01-intercept.evidence.json`'s own recorded `impactEnergy` (7933055679153.257 J = 7.93 TJ)
exactly -- the ghost's own prediction and the committed replay's own recorded outcome agree, which
is the ghost invariant made visible on the actual panel a player reads.
