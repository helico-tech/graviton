# GRV-0028 evidence — EPIC-06 review fixes

2026-09-18, branch `GRV-0028-epic06-review-fixes`. Node v24.14.0, pnpm 11.25.0.

## What was built

Picks up the three EPIC-06 review findings: `docs/issues/2026-09-18-commit-plan-uses-stale-launch-
tick.md` (P1), `docs/issues/2026-09-18-reintegrate-skips-validate-plan.md` (P1),
`docs/issues/2026-09-18-plot-event-labels-overlap-at-impact.md` (P2). Goal: the ghost never lies
and commit never throws.

1. **`src/app/planner.ts`**. `PlannerState.launchRejection: LaunchRejection | null` is replaced by
   `issues: readonly string[]` -- one general slot rather than two overlapping ones. `reintegrate`
   now runs `validatePlan` (plan.ts) against the *snapped* draft **before** `checkPlanLaunch` and
   before `integrateGhost` ever sees the plan: a shape issue (over budget, a node no longer later
   than the -- possibly just re-snapped -- launch tick) short-circuits with `ghost: null, cache:
   undefined, issues: shapeIssues`, never reaching the sim. Only once the shape is clean does
   `checkLaunch`'s own rejection get a turn (`issues: ['launch rejected: <reason>']`). This is
   what stops `setPlan` with more nodes than the level's budget from throwing out of the sim's own
   burn queue, and what turns "re-drag the launch past a node" into a reported issue instead of a
   ghost that silently ignores the node.
2. **`src/app/app.ts`**.
   - `planIssues()` now just returns `[...plannerState.issues]` -- `reintegrate` is the one place
     that computes them; nothing re-derives `validatePlan` a second time.
   - `step(ticks)` re-snaps a stale draft: after advancing, if `plannerState.draft &&
     plannerState.draft.launchTick <= session.state().tick`, it calls `reintegratePlan()` -- the
     one place time advances is now also the one place a draft that time has caught up with gets
     re-snapped, whether or not the player is actively dragging anything. `warpTo` inherits this
     for free (it already delegates to `step`).
   - `endDrag()` also calls `reintegratePlan()` now, matching the App interface's own
     pre-existing (and, before this, not entirely true) doc: "every mutator here reintegrates the
     ghost synchronously before returning."
   - `commitPlan()` re-snaps and revalidates first (`reintegratePlan()`), then either returns
     `{ committed: false, issues }` (no draft, or `planIssues()` still non-empty after re-snapping)
     or commits the *exact* draft that re-snap just integrated and returns `{ committed: true }`.
     It never throws.
3. **`src/app/debug-api.ts`**. `DebugApiDriver.commitPlan`/`DebugApi.commitPlan` return the same
   `{ committed: true } | { committed: false; issues: string[] }` union, so `window.graviton!.
   commitPlan()` carries the same contract into e2e/debug-API callers.
4. **`src/render/ghost.ts`**. `GhostEventMark` gained an optional `contact` field (set for
   `closestApproach`/`impact`, absent for `bodyHit`). A new pure function, `plannerLabels({ frame,
   view, canvasWidth, canvasHeight })`, projects every event to screen space and drops a
   `closestApproach` label when an `impact` for the *same contact* lands within 8 px of it (screen
   space, at whatever zoom is current) -- the marker itself (tick mark / diamond / cross) still
   draws regardless; only the text is suppressed. `drawEvents` is now a thin consumer: it draws
   every marker via a small `drawEventMarkers` helper, then draws only the labels `plannerLabels`
   returns.
5. **Tests, test-first throughout** (each addition observed failing against the pre-fix code
   before the corresponding implementation change; see "Test-first" below): `src/app/
   planner.test.ts` (+2, plus every `launchRejection` assertion migrated to `issues`), `src/app/
   app.test.ts` (+9: step's re-snap, a node reported instead of dropped, commit never throwing --
   including a genuine `capacity` rejection that the *old* code really did throw on -- and
   endDrag's own reintegrate), `src/render/ghost.test.ts` (new file, 5 tests for `plannerLabels`),
   `tests/e2e/planner.spec.ts` (the committed-solution commit test upgraded to let 50 ticks pass
   first and assert the `{ committed: true }` return, plus a new over-budget-draft test asserting
   `plan()`/`solution()`/the PLAN panel's own `readouts()`/`commitPlan()`'s `{ committed: false }`
   -- both browsers, strict console gate).

## Test-first

- `src/app/planner.test.ts`: added "a draft over the level node budget yields issues and no ghost,
  never throws" against the *real* `L01-intercept` level (`burnNodeCapacity` 0 / `capacity` 2 ->
  node budget 0 -- the exact level the filed bug reproduced against, "pending burn queue capacity
  0 exceeded"). Before the fix: `expect(() => reintegrate(...)).not.toThrow()` failed with
  `Error: burn: pending burn queue capacity 0 exceeded` thrown straight out of `reintegrate`.
- `src/app/planner.test.ts`: added the re-drag-past-a-node sequence (node at tick 50, `reintegrate`
  at `nowTick: 100` after a re-drag). Before the fix: `state.issues` didn't exist yet (`Property
  'issues' does not exist on type 'PlannerState'` at the type level; once the field existed but
  `reintegrate` didn't validate, the assertion failed with `expected undefined to deeply equal []`
  for the *valid* case, and the ghost integrated silently past the node for the invalid one).
- `src/app/app.test.ts`: "a draft whose launch tick the clock reaches is re-snapped..." and "...is
  reported as an issue, not dropped" both failed with `expected 1 to be 6` before `step` gained its
  own re-snap check (the draft's `launchTick` just sat at its original value).
- `src/app/app.test.ts`: "an invalid draft (launch rejected: capacity) returns its issues instead
  of throwing" is the cleanest isolated proof of `commitPlan`'s own "never throws" contract,
  independent of any launch-tick timing: before the fix, `app.commitPlan()` on a `capacity`-
  rejected draft threw `Error: app: commitPlan called on an invalid draft (launch rejected:
  capacity)` -- caught directly by `expect(() => { result = app.commitPlan(); }).not.toThrow()`.
- `src/app/app.test.ts`: "no draft to commit reports an issue rather than throwing" failed with
  `Error: app: commitPlan called with no draft` before the fix.
- `src/render/ghost.test.ts`: every test failed with `TypeError: plannerLabels is not a function`
  before the export existed.

## Deviations from the brief, and why

- **`src/app/main.ts` is untouched.** The unit doc and dispatch both call for "the Commit handler
  renders the returned issues into the PLAN panel (no console output)." `app.commitPlan()` now
  calls `emit()` on *every* path (success or `{ committed: false }`), and main.ts's `onChange`
  callback already calls `renderSelectionAndTimeline()` unconditionally at the end of every emit,
  which reads the panel's issue text straight from `app.planIssues()` -- the exact same array the
  returned `issues` came from. So by the time `commitPlan()` returns, the panel has already been
  re-rendered with the current issue (or lack of one); a second, explicit render off the return
  value would be redundant with the pipeline every other planner mutator already uses. Verified
  directly by the new e2e test (`tests/e2e/planner.spec.ts`'s over-budget-draft test reads the
  panel's own `readouts()['plan.issue']` after `setPlan`, and the ghost-invariant test's console
  gate stays clean through a real `commitPlan()` call) -- no code path routes an error to the
  console either before or after. `endDrag`'s new `reintegratePlan()` call is exercised the same
  way (no distinguishing App-level test was written for it in isolation: given `step`'s own
  re-snap fires unconditionally on every tick advance regardless of drag state, there is no
  reachable sequence through `App`'s public surface where `endDrag`'s own call produces a result
  `step` hadn't already guaranteed -- it is still added, cheaply, because it is what the App
  interface's own pre-existing doc comment already claimed true of every planner mutator).
- **`src/render/ghost.test.ts` is a new co-located file**, not an addition to `tests/render/
  plot.test.ts`. `plannerLabels` is pure (no Canvas2D), matching this package's existing
  convention for its *other* pure modules (`camera.test.ts`, `frame.test.ts`, `palette.test.ts`
  all live next to their subject in `src/render/`) -- `tests/render/plot.test.ts` is reserved for
  `renderPlot`'s own pixel-sampling assertions against `@napi-rs/canvas`, which nothing here needs.
- **The direct-hit screenshot's own zoom is ~430,000 m/px, not a close-up.** L01-intercept's real
  committed solution's own ghost puts its `closestApproach` event ~870 km (world space) from its
  `impact` -- a flyby-adjacent local minimum recorded shortly *after* the capture, not at the
  capture instant itself, not something engineered for this unit. `plannerLabels`'s own 8 px
  suppression radius is screen-space, so making two points genuinely land "within 8 px" at this
  level's own real numbers means zooming out until that real 870 km gap folds under 8 screen
  pixels -- exactly the same screen-space comparison the code and its unit tests use, just applied
  to this level's real flight instead of a synthetic one. `src/render/ghost.test.ts` is the
  authoritative, zoom-independent proof (it asserts the label list directly by contact and screen
  distance); the screenshot is corroborating, real-renderer evidence of the same fix.

## Verification

`pnpm check` (typecheck, lint, format, unit tests, levels build/verify):

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0028

 Test Files  57 passed (57)
      Tests  774 passed (774)
   Start at  14:27:25
   Duration  16.07s (transform 1.96s, setup 0ms, import 4.50s, tests 28.21s, environment 8ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

`pnpm docs:validate`:

```
$ node scripts/validate-docs.ts
docs: ok
```

`pnpm build`: succeeds (`vite build`, 55 modules transformed, `✓ built in 106ms`).

`pnpm e2e` (both browsers, strict console gate throughout):

```
Running 90 tests using 4 workers
...
  ✓  22 [chromium] › tests/e2e/planner.spec.ts:135:1 › setPlan with level 01s committed solution reproduces its own recorded outcome (149ms)
  ✓  23 [chromium] › tests/e2e/planner.spec.ts:159:1 › ghost invariant: plan, let time pass, commit, then warping to the predicted impact matches it exactly (GRV-0028) (214ms)
  ✓  24 [chromium] › tests/e2e/planner.spec.ts:203:1 › a draft over the level node budget never crashes: the PLAN panel shows why, commit reports the issue instead of throwing (GRV-0028, docs/issues/2026-09-18-reintegrate-skips-validate-plan.md) (156ms)
...
  ✓  67 [firefox] › tests/e2e/planner.spec.ts:135:1 › setPlan with level 01s committed solution reproduces its own recorded outcome (325ms)
  ✓  68 [firefox] › tests/e2e/planner.spec.ts:159:1 › ghost invariant: plan, let time pass, commit, then warping to the predicted impact matches it exactly (GRV-0028) (385ms)
  ✓  69 [firefox] › tests/e2e/planner.spec.ts:203:1 › a draft over the level node budget never crashes: the PLAN panel shows why, commit reports the issue instead of throwing (GRV-0028, docs/issues/2026-09-18-reintegrate-skips-validate-plan.md) (322ms)
...
  2 skipped
  88 passed (17.4s)
```

(The 2 skipped are `tests/e2e/screenshot.spec.ts` on firefox, pre-existing and unrelated to this
unit -- that spec is chromium-only.)

`pnpm headless` on both goldens:

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
223396.5 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
26636.6 ticks/s
```

`pnpm screenshot --debug`:

```
$ node scripts/screenshot.ts --debug --out <tmp>/check.png
{"url":"http://127.0.0.1:41387/?debug=1","build":"b8c6c60","expected":null,"violations":[],"out":"<tmp>/check.png"}
```

Exit code 0.

## Screenshots

- **`plan-panel-invalid.png`** -- L01-intercept's own committed launch (`?debug=1`, `setPlan`),
  plus one burn node; L01's own node budget is 0 (`burnNodeCapacity` 0 / `capacity` 2), so the
  single node is already one past it. The PLAN panel shows `plan has 1 node(s), budget is 0` in
  place of the usual heading/speed/node rows that would otherwise follow (`validatePlan`'s own
  shape check short-circuits before those fields would even be meaningful), COMMIT is disabled,
  DISCARD is not, and the SOLUTION panel reads "NO SOLUTION" -- no ghost was drawn, no throw
  happened.
- **`plot-direct-hit-single-label.png`** -- the same committed solution's own ghost, zoomed out
  until its real `closestApproach` and `impact` events (~870 km apart in world space, see
  "Deviations" above) land within the 8 px suppression radius on screen. A single `impact` label
  draws at the convergence point; the closest-approach tick mark is still visible right beside the
  impact diamond (the marker itself is never suppressed, only its label), and there is no second,
  garbled label anywhere on screen.

Both read back via the Read tool during this unit's own work to confirm them before writing this
file.
