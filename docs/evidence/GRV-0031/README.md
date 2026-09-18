# GRV-0031 evidence — command horizon, locked nodes and amendments

2026-09-18, branch `GRV-0031-command-horizon`, worktree `.worktrees/GRV-0031`. Node v24.14.0, pnpm
11.25.0. Base commit `5824c65` (GRV-0031: specify the command horizon and locked nodes; triage the
two GRV-0030 findings).

## What was built

- **Ghost issuance = commit issuance** (`src/planner/ghost.ts`, rewritten). A draft's trial log now
  batches the launch and every node at `issueTickFor(rail, launchTick)`, identically to
  `planToCommands` — no more lazy, per-node `issueTickFor(probe, atTick)` issuance. This is what
  resolves `docs/issues/2026-09-18-ghost-lazy-issuance-cannot-cross-a-long-blocked-stretch.md`: a
  node deep inside a long blocked stretch is never re-validated against occlusion at all (bundled
  burns skip `checkBurn` entirely, exactly like a real committed transmission), so it integrates
  fine regardless of how long the stretch is. `ghost.test.ts`'s own flyby-burn invariant test now
  uses the golden's real `atTick: 3000` node (inside the 2278-4403 blocked window) directly, no
  more `atTick: 2000` workaround.
- **The ghost cache still checkpoints per node**, just at a different moment: since every command
  is already queued the instant the batch is issued, a checkpoint is taken right before each node's
  own `atTick` (when it could first activate), not before its issuance (there is none to wait for).
  Resuming from an edited node's checkpoint swaps the deserialised sim's own stale `sim.pending`
  entries for the current plan's, via a small insertion-sort duplicated from `commands.ts`'s own
  `materializeBurn` (`src/sim/**` stays untouched; this reaches into `Sim`'s own typed arrays
  exactly like the rest of `ghost.ts` already does for `sim.objects`).
- **Amendments** (`src/planner/ghost.ts`'s new `amend` branch, `src/app/planner.ts`'s `beginAmend`/
  `reintegrateAmend`, `src/app/debug-api.ts`'s `commitAmendment`): a flying probe's plan is amended
  by issuing new burn commands to its own already-existing object index, `now` — never a relaunch.
  The amendment ghost starts from the **observed prediction**, not the true state (the committed
  log replayed to the last observation, then continued to now, `src/app/observed.ts`'s own two-
  stage replay duplicated rather than imported — `src/planner` depends on neither `src/app` nor the
  reverse). `diffAmendmentNodes` (`src/planner/plan.ts`) picks exactly the nodes an amendment needs
  to transmit — an untouched existing node is never re-issued — so the ghost preview and what
  `commitPlan()` actually sends are the same set of commands by construction. The amendment ghost is
  never cached (a session touches a handful of nodes over an already-cheap horizon; YAGN — see
  "Deviations").
- **Locked nodes** (`src/app/planner.ts`'s `isNodeLocked`, `src/render/ghost.ts`, `src/ui/
  planner.ts`): `atTick < commandHorizonTick` in 'amend' mode only (a draft's own plan is one
  not-yet-sent transmission, nothing in it is ever locked). `beginNodeDrag`/`addNode` refuse a
  locked tick with an issue string; `removeNode` refuses to remove an *already-committed* node
  regardless of lock status (there is no way to cancel a queued command, `diffAmendmentNodes`'s own
  doc). Rendered hollow (a stroked square — `Ctx2D` has no `strokeRect`, so this is the same
  moveTo/lineTo/closePath/stroke shape every other hairline in the module uses) with the ghost path
  segment before the horizon drawn dimmed-solid (`KNOWN_DIM`, the identical dash as the ordinary
  ghost path — mirrors an expended trail's own convention, `palette.ts`, rather than registering a
  fourth dash pattern). The PLAN panel shows `LOCKED, <reason>` / `EDITABLE` per node.
- **Command horizon** (`src/app/planner.ts`'s `computeCommandHorizon`, `App.commandHorizon()`,
  debug `horizon()`): a draft's own `issueTickFor`/`uplinkArrival` against its rail (identical
  numbers to what `planToCommands` will actually use); an amendment's `uplinkArrival` to the
  amended probe with `issueTick = now`. Exposed as three PLAN-panel readouts, `ISSUE`/`ARRIVES`/
  `CMD HORIZON`, and a `CMD +mm:ss` mark on the ghost's own predicted path
  (`src/render/ghost.ts`'s `commandHorizonMarkFor`).
- **Uplink availability band** (`src/ui/timeline.ts`'s `computeUplinkWindows` — pure, `Sim` +
  a predicted path in, occlusion windows out — plus `appendUplinkBand`'s DOM rendering and new
  `.timeline-uplink-band`/`.timeline-uplink-readout` CSS): for the drafted/amended probe (the
  ghost's own samples) or, without one, the selected probe's predicted flight
  (`src/app/predict.ts`'s new `predictProbePath`). Drawn as a dim strip along the timeline axis
  with a `timeline.uplink` text twin (`BLOCKED T+… – T+…`, GAME-0002 §11). Cached (`src/app/app.ts`)
  — occlusion windows are a fixed geometric property of a whole flight, not of "now", so the
  selected-probe case is computed once per commit (by probe + log length, like the existing
  `predictionCache`) rather than resampling up to 20 000 ticks on every render; the ghost case is
  cached by the `Ghost` object's own identity.
- **`warpToEvent()`'s dead zone, closed** (`src/app/app.ts`'s `upcomingEvents`,
  `src/app/debug-api.ts`'s new `pendingCommandArrivals()`): a command whose issue tick has passed
  but which hasn't materialised yet now targets its own arrival tick
  (`session.pendingCommandArrivals()`) instead of being silently dropped. A predicted event now
  targets its own `arrivalTick` when it has one (`src/app/predict.ts`'s new `downlinkArrivalOf` —
  the forward counterpart of `downlinkEmission`, three Newton iterations, the post playing the
  moving/analytic role `uplinkArrival` itself gives a rail/object target) rather than the bare true
  tick a player cannot act on any sooner than telemetry allows. The draft's own (not yet committed)
  issue tick is also surfaced, so warping toward it shows when committing right now would actually
  send the order. This resolves
  `docs/issues/2026-09-18-warptoevent-dead-zone-for-a-delayed-post.md`.
- **`setPlan` is now mode-preserving** (`src/app/planner.ts`): it used to force `mode: 'draft'`
  unconditionally. It now only ever replaces the draft's own data — `beginAmend`/`beginLaunchDrag`
  are the real mode transitions — so a test (or a future UI affordance) can drive an amendment's
  plan through `setPlan` without leaving amend mode. No existing caller relied on the old reset
  (every one starts from `createPlannerState()`, already `'draft'`).
- **`N`** (`src/app/main.ts`'s keydown handler): a selected flying probe opens it for amendment
  (`app.beginAmend`); Escape (existing handler, unchanged) discards it.

## SIM_VERSION

Unchanged (still 5) — `src/sim/**` was never touched this unit; nothing about command application
or the hash domain moved.

## Deviations from the brief, and why

- **T01-far-post's own `burnNodeCapacity` is 0.** Its committed solution has no burn nodes to
  amend, and the level can't be amended with a *new* one either (the scenario itself has no room).
  The unit brief's acceptance list reads "on T01" for every bullet, including the amendment ones;
  in practice T01 only supports the draft-horizon and warp-to-event bullets. The amendment bullets
  (`horizon.spec.ts`'s own `farScenario`) use a hand-built raw scenario instead — the same real
  ~20-tick-delay shape as T01 (a post genuinely offset from its rail), built this way specifically
  because flyby-burn's own real geometry (the other natural candidate, and what `ghost.test.ts`'s
  own amendment invariant test uses) turns out to carry only ~1 tick of delay throughout its whole
  flight, too narrow a window to demonstrate a locked node cleanly or safely in an e2e test. Flagged
  per "tell me if something proves wrong" rather than silently working around it.
- **`downlinkArrivalOf` has no occlusion awareness.** It is a pure light-cone geometry solve (three
  Newton iterations, matching every other light-cone function's own fixed count); `observedState`'s
  own `downlinkEmission` additionally checks `segmentBlocked`. Confirmed directly against T01's own
  post-impact geometry: the predicted confirmation lands at 5826, the real one (once occlusion
  clears) at 5831. This is the same *category* of gap the design already accepts elsewhere (a
  predicted tick that isn't necessarily where real telemetry actually lands — the L01 impact
  precedent this project already has two tests for) — `tests/e2e/telemetry.spec.ts`'s own rewritten
  test and `src/app/predict.ts`'s own `downlinkArrivalOf` doc both have the full account and the
  established recourse (warp on a little further). Adding occlusion awareness would need the
  object's own predicted position at nearby ticks too, which this function's single-instant
  contract doesn't carry — left as a documented limitation, not widened speculatively.
- **Editing an existing (not locked) pending node is UI-permitted but not perfectly safe.**
  `beginNodeDrag` only refuses a *locked* node; nothing stops the player editing an editable node
  that is *also* still genuinely pending in `sim.pending` (queued by the original transmission, not
  yet activated). Committing such an edit sends a fresh command via the normal, non-bundled path,
  which the sim has no primitive to reconcile against the still-queued original — both could fire.
  `removeNode` avoids the analogous problem for a *removed* node (refusing to touch any already-
  committed one, whatever its lock status), but an *edited* one has no such guard, since "edit,
  then commit" is the amendment's whole point and the common case (a node added *this session*,
  never yet transmitted) is completely safe. Not exercised by any test in this unit (every test
  either adds a new node or reads/attempts an already-*locked* one); a real fix needs a
  cancel/replace primitive `src/sim/**` doesn't have (out of this unit's file list). Documented here
  rather than fixed speculatively, mirroring the project's own existing "concurrent multi-launch"
  precedent (GRV-0029's evidence).
- **No caching for the amendment ghost.** `integrateDraftGhost`'s checkpoint/resume machinery is
  real work reused here in spirit (the `sim.pending`-fixup technique) but not reused in the amend
  path itself — every `reintegrateAmend` call replays from the observation tick cold. A session
  touches at most a handful of nodes over a horizon already bounded by `GHOST_HORIZON_TICKS`; adding
  the equivalent resume logic for a case that doesn't need the performance was YAGNI. One real
  consequence: if a draft is left open with time running (rare — the design expects pausing to
  plan), `reintegratePlan()`'s own re-snap condition (`draft.launchTick <= nowTick`, always true in
  amend mode, since the "launch" is in the past) re-integrates the amendment ghost every tick.
  Flagged as a known cost, not hit by anything in this unit's own levels/tests.
- **`ghost.ts`'s resume fixup does not handle a tie at the exact checkpoint boundary or a node still
  waiting on a busy probe past its own `atTick`.** Both are real, structurally possible cases
  (`validatePlan` allows equal `atTick`s; `activateDueBurnNodes`, `src/sim/sim.ts`, already
  documents a node waiting for a busy probe) the fixup's own `atTick >= checkpoint.tick` filter
  doesn't perfectly separate in the tie case. Not exercised by any test here (no fixture produces
  either); documented in `src/planner/ghost.ts`'s own `clearStalePendingBurns` doc rather than
  chased further, the same "known limitation, not a defensive general fix" precedent GRV-0029's own
  concurrent-multi-launch note set.
- **`predictProbePath`'s own `fromTick` may now precede the probe's materialisation** (used by
  `uplinkWindows()`'s own whole-flight case) — it advances to wherever the probe actually starts
  existing rather than returning `[]`. `predictProbe` (the sibling function driving predicted
  events) is untouched; every one of its own callers already only ever passes `fromTick = now`, an
  instant the probe is guaranteed to already exist at.

## Public API added

```ts
// src/planner/ghost.ts (changed)
interface AmendContext { probe: number; observationTick: number }
function integrateGhost({ level, log, plan, fromTick, horizonTick, cache?, amend?: AmendContext }): { ghost: Ghost; cache: GhostCache }

// src/planner/plan.ts (new)
function existingNodesForProbe({ log, probe }): BurnNode[]
function diffAmendmentNodes({ existing, nodes }): BurnNode[]

// src/app/planner.ts (new)
type PlannerMode = 'draft' | 'amend'
interface CommandHorizon { issueTick: number; arrivalTick: number; commandHorizonTick: number }
function beginAmend({ state, log, probe, nowTick, observationTick }): PlannerState
function isNodeLocked({ state, node }): boolean
function computeCommandHorizon({ level, log, mode, draft, amendProbe, nowTick }): CommandHorizon | null
// PlannerState gains: mode, amendProbe, amendObservationTick, amendExistingNodes, commandHorizon
// setPlan is now mode-preserving (see Deviations)

// src/app/app.ts (new)
mode(): PlannerMode
amendProbe(): number | null
beginAmend(probe: number): boolean
commandHorizon(): CommandHorizon | null
uplinkWindows(): readonly UplinkWindow[]

// src/app/debug-api.ts (new)
pendingCommandArrivals(): { arrivalTick: number; kind: 'launch' | 'burn' }[]
commitAmendment({ probe, nodes, issueTick }): void
uplinkWindows({ path }): UplinkWindow[]
// window.graviton gains: amend(probe), horizon(), uplinkWindows()

// src/app/predict.ts (new)
function downlinkArrivalOf({ sim, emissionTick, x, y }): number
function predictProbePath({ level, log, probe, fromTick, horizonTick }): { tick, x, y }[]
// predictProbe's own impact event now carries arrivalTick

// src/ui/timeline.ts (new)
interface UplinkWindow { startTick: number; endTick: number }
function computeUplinkWindows({ sim, path }): UplinkWindow[]
// renderTimeline gains optional uplinkWindows/dt

// src/render/ghost.ts (changed)
interface GhostRenderNode { ...; locked: boolean }
interface CommandHorizonMark { x: number; y: number; label: string }
// buildPlannerFrame gains commandHorizon/dt; PlannerFrame gains lockedUntilTick/commandHorizonMark
```

## Verification output

### `pnpm check`

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0031

 Test Files  61 passed (61)
      Tests  860 passed (860)
   Duration  ~15s

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
levels: T01-far-post ok
```

`pnpm docs:validate`: `docs: ok`. `pnpm build`: succeeds (`vite build`, 63 modules).

### `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash 47448f64f618030a
MATCH
193794.3 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash 6108d325bf738ae3
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
23496.9 ticks/s
```

Both bit-identical to before this unit — `src/sim/**` was never touched.

### `pnpm e2e` (both browsers; run per-project with `--workers=1`, the same sandboxed-container
accommodation GRV-0029/GRV-0030's own evidence already documents — `fullyParallel` intermittently
crashes Chromium's renderer here regardless of this unit's own changes)

Chromium, 55/55 passed:

```
✓  17 [chromium] › tests/e2e/horizon.spec.ts:45:1 › draft command horizon: the PLAN panel shows issue/arrival ticks ~20 apart, matching the sim's own delay (T01) (180ms)
✓  18 [chromium] › tests/e2e/horizon.spec.ts:92:1 › commit, then warpToEvent(): the dead zone between issue and materialisation is gone (T01) (215ms)
✓  19 [chromium] › tests/e2e/horizon.spec.ts:181:1 › amendment: a locked node refuses commitPlan(); a new node past the horizon commits and the live replay matches exactly (475ms)
✓  20 [chromium] › tests/e2e/horizon.spec.ts:264:1 › screenshot: amendment shows a locked node and an editable one together (326ms)
✓  21 [chromium] › tests/e2e/horizon.spec.ts:307:1 › screenshot: the timeline's uplink band shows a real occlusion window for the selected probe (flyby-burn) (238ms)
...
  55 passed (32.3s)
```

Firefox, 53/53 passed, 2 pre-existing skips (documented since GRV-0029 — unrelated `screenshot.spec.ts` skips):

```
✓  17 [firefox] › tests/e2e/horizon.spec.ts:45:1 › draft command horizon: ... (330ms)
✓  18 [firefox] › tests/e2e/horizon.spec.ts:92:1 › commit, then warpToEvent(): ... (377ms)
✓  19 [firefox] › tests/e2e/horizon.spec.ts:181:1 › amendment: ... (679ms)
✓  20 [firefox] › tests/e2e/horizon.spec.ts:264:1 › screenshot: amendment shows ... (1.1s)
✓  21 [firefox] › tests/e2e/horizon.spec.ts:307:1 › screenshot: the timeline's uplink band ... (427ms)
...
  2 skipped
  53 passed (46.3s)
```

Every pre-existing spec (`planner.spec.ts`, `events.spec.ts`, `telemetry.spec.ts`, `parity.spec.ts`,
`selection.spec.ts`, `shell.spec.ts`, `plot.spec.ts`, `loop.spec.ts`, `console-gate.spec.ts`,
`screenshot.spec.ts`) stays green on both browsers.

### T01 warp-to-event sequence (`tests/e2e/horizon.spec.ts`, from tick 0, `?solution=1`-equivalent)

| press | lands at tick | past |
|---|---|---|
| 1 | 5725 | the committed launch's own issue tick (5724) |
| 2 | 5745 | the still-pending command's own arrival/materialisation tick (5744) — **the dead zone**, previously `null` |
| 3 | 5827 | the predicted impact's own downlink-confirmed tick (5826) |

Real telemetry confirms the impact at 5831 (5 ticks later than the prediction — the occlusion gap
documented above); `warpTo(5832)` reaches it (`telemetry.spec.ts`'s own test) with
`status.event === 'IMPACT PRB-01 → RELAY-HULK'`.

### `pnpm screenshot --debug` (gate check)

```
$ node scripts/screenshot.ts --debug --out runs/gate-screenshot.png
{"url":"http://127.0.0.1:.../?debug=1","build":"5824c65","expected":null,"violations":[],"out":"runs/gate-screenshot.png"}
```

Exit 0, zero console violations. (`runs/` is gitignored, not committed evidence.)

## Screenshots — read directly

Both PNGs below were saved directly by `tests/e2e/horizon.spec.ts` (`page.screenshot()`, gated by
the same console-gate every spec in this repo uses) rather than `pnpm screenshot`: that tool only
ever visits a URL, and neither state is reachable through one — there is no `?amend=` URL param,
and no bundled level has a committed plan with room for both a locked and an editable node under
its own solution (see "Deviations"); the uplink-band shot needs a raw scenario (flyby-burn) no
bundled level exposes via `?level=` either.

**`amendment-locked-editable.png`**: the PLAN panel (right) shows `ISSUE T+00:00:50:00` / `ARRIVES
T+00:01:00:00` / `CMD HORIZON T+00:01:00:00`, `NODE 1 STATUS: LOCKED, order cannot arrive in time`
and `NODE 2 STATUS: EDITABLE` — the two nodes committed at tick 0 (`atTick` 110 and 500) amended at
tick 100, exactly as designed. On the plot, the ghost path runs dimmed-solid up to the `CMD +10:00`
mark (the command horizon, tick 120) then ordinary dashed beyond it; the locked node sits right at
the mark, the editable one further along the path.

**`uplink-band.png`**: the timeline strip (bottom) shows a solid amber band along the axis and its
own `timeline.uplink` text twin, `BLOCKED T+00:02:21:00 – T+01:02:32:00, BLOCKED T+01:13:58:00 –
T+03:01:40:00, ...` — flyby-burn's own real, already-known occlusion stretches for the selected
probe's predicted flight (probe 0, no draft or amendment open), confirmed directly to include
2278-4403 (the golden's own well-known blocked window, dt=60).

## Tests added

- `src/planner/plan.test.ts` (7 tests): `existingNodesForProbe` (collects/sorts one probe's burns,
  ignores others; empty with none), `diffAmendmentNodes` (unedited nothing to issue, a new node, an
  edited one, a dropped one never "cancelled").
- `src/planner/ghost.test.ts`: the two existing invariant tests kept bit-identical (one now uses the
  golden's real `atTick: 3000`, resolving the filed limitation); the cache test's own checkpoint
  semantics updated (`checkpoints[1].tick` is now `plan.nodes[1].atTick`, not an issue tick); new
  amendment invariant test (a second probe on flyby-burn, amended with a new node, bit-identical to
  committing the same burn command to a live sim).
- `src/planner/readout.test.ts`: unaffected — `solutionReadout`'s own `launchTick` fallback for an
  amendment ghost (no launch event) is covered indirectly through `ghost.test.ts`'s amendment case
  and `app.test.ts`'s own amendment tests (both call `planSolution()`/reach `solutionReadout`
  without a launch event and don't throw).
- `src/app/planner.test.ts` (11 new tests): `beginAmend` (opens existing-and-still-ahead nodes,
  no-op on a never-launched probe), `reintegrate` computing the command horizon and an amend-mode
  ghost, `beginNodeDrag` refusing a locked node / allowing an editable one, `removeNode` refusing an
  already-committed node, `addNode` refusing before the horizon and accepting after, a committed
  node integrating into the ghost, `discardDraft` leaving amend mode, `setPlan` preserving it.
- `src/app/app.test.ts` (7 new tests): `mode`/`amendProbe`/`beginAmend`'s own observation gating,
  `commandHorizon()` end to end, `commitPlan()` on an amendment sending only the new node and
  matching a live replay, `discardDraft` sending nothing, `uplinkWindows()` end to end (both the
  ghost and empty cases), `nextEventTick()` surfacing a draft's own issue tick; plus a dedicated
  dead-zone regression test on T01 (`nextEventTick()` never `null` between issue and
  materialisation) and an updated L01 warp-to-event assertion (lands one tick later — impact
  confirmation, not the bare true tick).
- `src/app/predict.test.ts` (4 new tests): `downlinkArrivalOf` round-trips through
  `observedState`/`downlinkEmission` on T01's own real ~20-tick delay (within one tick, the
  ceil/floor quantisation's own expected slack) and returns zero delay for a source on the post
  itself; `predictProbePath` samples the same trajectory `predictProbe` integrates and advances past
  a `fromTick` before materialisation. Two existing impact-event assertions updated to include the
  new `arrivalTick` field.
- `src/ui/timeline.test.ts` (4 new tests): `computeUplinkWindows` against a synthetic occluder —
  one blocked window found correctly, an entirely clear path, a still-blocked-at-the-last-sample
  path left open-ended, an empty path.
- `tests/e2e/horizon.spec.ts` (new, 5 tests, both browsers): the full acceptance list plus both
  screenshots.
- Updated for the dead-zone fix (both intentional behaviour changes, not fallout): `tests/e2e/
  events.spec.ts`'s own L01 warp-to-event test (lands one tick later, impact confirmation not the
  true tick); `tests/e2e/telemetry.spec.ts`'s own dead-zone-stall test rewritten to prove the zone
  is closed instead of documenting it.

## Anything that surprised me

`downlinkArrivalOf`'s round-trip check (`predict.test.ts`) passed to within one tick on the first
real attempt, but the SAME function applied to T01's own post-impact geometry disagreed with the
real telemetry confirmation by five ticks — not the expected sub-tick quantisation slack. The
round-trip test uses an arbitrary mid-flight instant (no occlusion nearby); the impact case sits
right where the post's own line of sight to the target briefly clears, which the function's pure
geometry solve has no way to know about. Worth having measured directly rather than assumed
generalises from the first check — see "Deviations" for the full account and why it was left as a
documented limitation rather than chased into `segmentBlocked` territory this late in the unit.
