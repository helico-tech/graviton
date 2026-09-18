# GRV-0029 evidence — light cone, the post and command arrival

2026-09-18, branch `GRV-0029-light-cone`, worktree `.worktrees/GRV-0029`. Node v24.14.0, pnpm
11.25.0. Base commit `c4d55a8` (EPIC-07: ADR-0007 on the signal-delay model; plan the epic).

## What was built

- `src/sim/post.ts` — `postPosition({ sim, tick })` / `postPositionAtTime({ sim, t })`: the
  clearance post is a surface point like a rail (`rails.ts`'s `surfacePoint`), analytic at any
  tick. `Scenario.post: { host, longitude }`.
- `src/sim/history.ts` — `HistoryBuffer`: a per-object ring of `historyTicks` position/velocity
  samples (`x y vx vy`, Float64Array, `[object*historyTicks+slot]`), `firstWriteTick`/`lastTick`
  per object, `recordHistory`, `firstAvailableTick`, and `sampleState` (cubic Hermite between the
  two bracketing ticks — exact for constant-velocity and for any polynomial up to degree 3).
  `Scenario.historyTicks`, sized by the compiler.
- `src/sim/lightcone.ts` — `C`, `uplinkArrival`, `downlinkEmission`, `issueTickFor`,
  `segmentBlocked`. Three Newton iterations from the geometric starter, `ceil`/`floor`
  quantisation, no tolerance branch. A rail target is fully analytic; an object target uses the
  object's **live** state at `sim.tick`, sampled once per call and extrapolated ballistically
  (constant velocity) to whatever instant the Newton iterations converge on (design decision,
  below).
- `src/sim/arrivals.ts` — `PendingArrivals`, the light-cone pending-commands queue (a command
  validated at issue time whose arrival is later than that tick), split into its own module so
  `sim.ts` and `commands.ts` share it without a runtime import cycle (`commands.ts` already only
  needs `Sim`'s *type*).
- `src/sim/sim.ts` — `Scenario.post`/`historyTicks`; `Sim.pendingArrivals`/`history`; `advance`
  materialises due arrivals before `activateDueBurnNodes`, and records history for every live
  object at the end of every tick (plus, for an object newly materialised this tick, once more at
  its own creation instant — `firstWriteTick` really is the launch tick). `hashSim`/`serializeSim`/
  `deserializeSim` gain the pending-arrivals queue and the history ring; `FORMAT_VERSION` → 4,
  `SIM_VERSION` → 4.
- `src/sim/commands.ts` — `applyCommand` computes the command's arrival via the light cone at issue
  time; when arrival equals the issue tick (no measurable delay — the common case for this unit's
  levels, whose post sits exactly on the rail's own host and longitude) the effect happens
  immediately, exactly as before; otherwise it is queued and `materializeArrival` applies it once
  `advance` reaches the arrival tick. `checkLaunch` gains `'occluded'`; new `checkBurn` returns
  `'locked' | 'occluded' | null`. A burn bundled with a same-tick, not-yet-arrived launch
  (`resolveBurnProbe`) inherits that launch's arrival rather than solving its own (the probe
  doesn't exist yet to solve against) — ADR-0007 §2's "same issue batch".
- `src/levels/schema.ts` / `compile.ts` — `post:` required in level source; optional
  `atmosphereMargin` per body; `Scenario.historyTicks` computed as
  `ceil(2*maxSeparation/c/dt) + 16` (`maxSeparation` = twice the largest apoapsis distance from the
  primary, the worst-case two-bodies-at-opposite-apoapsis bound `apoapsisBoundFromPrimary` already
  used for a compiler warning).
- `src/levels/verify.ts` — `halveDt` doubles `historyTicks` too (it covers a physical time window;
  halving `dt` must double the tick count to keep covering it).
- `src/levels/solve.ts` — the final command's `tick` is routed through `issueTickFor` (a throwaway
  `Sim`, since a rail's own light cone needs no prior state) instead of the raw `launchTick`; the
  search itself is untouched (evaluates every candidate as if issue and effect were the same tick,
  exact for this unit's own levels).
- `src/planner/plan.ts` — `planToCommands({ sim, plan, probeIndex })` issues the launch (and every
  node, bundled) at `issueTickFor(rail, plan.launchTick)`; `FlightPlan.launchTick` is now
  documented as the **arrival** tick.
- `src/planner/ghost.ts` — the committed path bundles; the ghost's own internal trial log instead
  issues each node lazily, at `issueTickFor(probe, atTick)`, once the probe exists — `maybeIssueNodes`
  checkpoints `sim` (for the cache) immediately *before* pushing each node's command, so a later
  resume with an edited node substitutes a fresh command exactly as if the old one had never been
  issued.
- `src/app/debug-api.ts` — `DebugSession.commitPlan({ plan, probeIndex })`: committing needs a
  `Sim` to solve the launch's issue tick, and `Sim` never leaves this module, so app.ts's
  `commitPlan()` now delegates here instead of hand-calling `planToCommands`. `StateSnapshot`
  gains `post: { x, y }`.
- Both goldens (`tests/golden/{flyby-burn,intercept}.json`) and both levels
  (`levels/{T00-compiler-fixture,L01-intercept}`) get a `post` on the rail's own host and
  longitude, re-recorded/re-solved under `SIM_VERSION` 4.

## Design decision: an object target's light-cone position

ADR-0007 says uplink to a probe needs `x_M(t_a)` for `t_a` in the future, which cannot be known
without integrating gravity. The decision taken here: for an object target, `uplinkArrival` and
`issueTickFor` use the object's **live** state — `sim.objects.x/y/vx/vy` at `sim.tick`, read once
per call — extrapolated at constant velocity to whatever instant `t` the Newton iterations are
evaluating (`targetStateAt` in `lightcone.ts`). Concretely this means **every caller that wants an
accurate answer for an object target must call it with `sim.tick` already close to the true issue
point** — which is exactly what happens in practice: `applyCommand`/`checkBurn` only ever call it
with `issueTick === sim.tick` (that invariant holds by construction — `advance`'s cursor only
processes a command whose tick equals the current tick), and the ghost's own lazy issuance
(`maybeIssueNodes`) calls `issueTickFor` fresh every tick as it walks forward, so its estimate
self-corrects as `sim.tick` approaches the true answer (an early call, with `atTick` still far
away, simply doesn't cross the `issueTick <= sim.tick` threshold yet — it isn't wrong, it's just
not due).

The error this introduces is `1/2 * a * tau^2` with `tau` bounded by one light delay (never the
whole flight, because the ballistic anchor is always taken within one delay of the instant being
solved for) — research §5's own worked example: ~3 km at 40 light-minutes and 1e-3 m/s², under one
tick of light. Measured directly against the real, gravity-integrated trajectory on the flyby-burn
golden (below): **zero ticks of discrepancy** at every sample point checked.

This is a deliberate simplification, not the literal "history + Hermite" phrasing in the unit
brief — flagged here per "tell me if something proves wrong rather than improvising." History
*is* used, for real, by `downlinkEmission` (genuinely backward-looking, so the past is known
exactly). For `uplinkArrival`/`issueTickFor`'s forward-looking object case, sampling the object's
state via history at the *issue* tick and extrapolating from there was the first design tried; it
is algebraically the same ballistic model, just anchored at `issueTick` instead of `sim.tick` — the
two coincide for every real caller (see above), and anchoring at live `sim.tick` needs no history
lookup at all for this path, which is simpler and was kept.

## Two things that proved wrong against the brief (fixed within scope)

1. **Own-body occlusion self-blocking.** `segmentBlocked`'s literal port of research §5.5's
   pseudocode (`c2 < 0` ⇒ inside ⇒ blocked) flagged a post as occluded by the very body it stands
   on: a surface point's distance from its own host's centre lands a few ULPs short of that host's
   exact radius (coordinates on the order of 1e11 m), so `c2` reads slightly negative. Every
   T00-compiler-fixture launch failed `checkLaunch` with `'occluded'` until this was found (a
   solver test — "the committed solution scores at or near zero" — is what surfaced it). Fixed
   with a relative tolerance (`OCCLUSION_EPSILON = 1e-9` × `r²`, comfortably above the observed
   rounding error and far below any real occlusion margin) on both the "outside, receding" and
   "inside" tests in `segmentBlocked`.
2. **`issueTickFor` picking a transiently-occluded tick.** The flyby-burn golden's rail sits on a
   moon with a rotation period close to the node-spacing window; the post (fixed to that moon's
   surface) sweeps in and out of view of its own probe every few hundred ticks as the moon spins.
   `issueTickFor`'s original one-shot estimate (`atTick - ceil(delay/dt)`, corrected only by
   arrival timing) could land on an issue tick that arrives on time but is occluded at that exact
   instant — which the ghost's own lazy issuance would then hand to `advance`, which throws
   (`'occluded'`) uncaught. Fixed: `issueTickFor` now also checks `segmentBlocked` at each
   candidate and keeps stepping down through a blocked stretch (bounded at 64 steps — the observed
   blocked runs on this golden are 1-2 ticks). `issueTickFor`'s own contract text now says
   explicitly that it does not always return the mathematically latest tick when this happens
   (verified separately: it *is* exactly the latest tick in the no-occlusion, no-hurry case).

Neither is a deviation from the *decided* design in the brief — both are within "computes arrival"
and "solves the uplink," just handling a case (own-body grazing; a rotating/orbiting post) the
literal pseudocode/estimate didn't by itself.

## Light-cone accuracy (research §5's own bar)

Fixture: `A = 4e11 m`, `e = 0.8` (max eccentricity) orbiting a `mu = 1.327e20` primary — reaches
~40 light-minutes range at apoapsis, deliberately curved (research §5.2's "nastier than the game"
p7 fixture, ported as a real Kepler two-body system rather than a hand-rolled truth function, so
the target position is the already-tested production ephemeris and only the Newton loop is
re-derived independently in the test).

```
worst |3-iteration - 12-iteration| = 5.820766091346741e-11 s, at issue tick 4782
max range checked = 40.07 light-minutes (3000 issue ticks sampled)
```

Well inside the 1e-9 s bar and consistent with research §5.2's own P7b finding (`1e-10` to `1e-11`
range). `src/sim/lightcone.test.ts`'s own run checks all 3000 cases plus that production
`uplinkArrival`'s quantised tick matches the reference solver's 3-iteration result exactly.

### Extrapolation vs. a true-future replay (flyby-burn golden)

For several issue ticks through the flight, `uplinkArrival`'s ballistic estimate is compared
against the tick found by actually replaying the *real*, gravity-integrated trajectory forward and
finding where the light-cone equation genuinely closes:

```
issueTick   1: ballistic    2, true    2, diff 0 ticks
issueTick 500: ballistic  501, true  501, diff 0 ticks
issueTick 1200: ballistic 1201, true 1201, diff 0 ticks
issueTick 2000: ballistic 2001, true 2001, diff 0 ticks
issueTick 2600: ballistic 2601, true 2601, diff 0 ticks
worst tick diff: 0
```

Zero ticks of discrepancy at every point checked (`src/sim/lightcone.test.ts`'s own "extrapolation
vs a true-future replay" test asserts `<= 1`).

## Why `SIM_VERSION` moved, and what did/didn't move

`SIM_VERSION` 3 → 4: command application now depends on `Scenario.post`, and the hash/serialise
domain gains the pending-arrivals queue and every live object's history ring — a golden recorded
under version 3 would hash differently under 4 even where no trajectory moved.

**Did not move**: level 01's committed solution. `levels/L01-intercept.solution.json`'s launch
tick (2464), the impact tick (3298, `levels/L01-intercept.evidence.json`'s own `contacts[0].
impactTick`), `timeOfFlightSeconds` (25020), `ticks` (3303) and `contactsCleared` are all
bit-for-bit identical to the pre-unit values — its post sits exactly on the rail's own host and
longitude (zero uplink distance ⇒ zero delay ⇒ `arrivalTick === issueTick` exactly, proven in
`lightcone.ts`'s Newton loop by an explicit `d === 0` short-circuit, not by luck). Only
`levelHash`/`solutionHash`/`finalStateHash` and `simVersion` changed, exactly as expected from the
hash domain growing.

**Did not move** (same reasoning): T00-compiler-fixture's and both goldens' trajectories — their
posts are likewise placed on the rail's own host, matching longitude.

**Did move**: `flyby-burn.json`'s burn command's own **issue tick** (2500 → 2997) — not its
`atTick` (3000, unchanged), not the resulting trajectory. The probe has moved measurably away from
its (stationary, moon-fixed) post by tick 2500 under the new model, and — separately — the moon's
own rotation carries the post out of the probe's line of sight for stretches of a few ticks near
2500 (the "own-host occlusion" case is gone by then; this is a *real*, different body's-eye-view
occlusion, the post's own moon getting in its own way as it spins). 2997 is exactly what
`issueTickFor` computes for this golden (confirmed by direct query); the resulting `PendingBurnNodes`
entry, and everything downstream, is unaffected by which tick the order was sent from, only by
`atTick` — so the trajectory is identical to before, verified by `pnpm headless` MATCH.

## Public API added

```ts
// src/sim/post.ts
function postPositionAtTime({ sim, t }: { sim: Sim; t: number }): SurfacePoint
function postPosition({ sim, tick }: { sim: Sim; tick: number }): SurfacePoint

// src/sim/history.ts
function createHistoryBuffer({ objectCapacity, historyTicks }): HistoryBuffer
function recordHistory({ history, object, tick, x, y, vx, vy }): void
function firstAvailableTick(history, object): number
function sampleState({ history, object, t, dt }): { x, y, vx, vy }

// src/sim/lightcone.ts
const C = 299792458
type LightconeTarget = { kind: 'rail'; rail: number } | { kind: 'object'; object: number }
function uplinkArrival({ sim, target, issueTick }): number
function downlinkEmission({ sim, object, receiveTick }): number
function issueTickFor({ sim, target, atTick }): number
function segmentBlocked({ sim, ax, ay, bx, by, tick }): boolean

// src/sim/arrivals.ts
interface PendingArrivals { ... }
function createPendingArrivals(capacity): PendingArrivals
function enqueuePendingArrival({ pending, arrivalTick, kind, tick, a, b, c, d }): void
function removePendingArrival(pending, index): void
function pendingLaunchArrivalAt({ pending, issueTick }): number

// src/sim/commands.ts (new/changed)
type LaunchRejection = 'capacity' | 'reloading' | 'speed' | 'cone' | 'occluded'
type BurnRejection = 'locked' | 'occluded'
function launchArrivalTick({ sim, command }): number
function burnArrivalTick({ sim, command }): number
function checkBurn({ sim, command }): BurnRejection | null
function materializeArrival({ sim, pending, index }): void   // sim.ts's applyDueArrivals only

// src/sim/sim.ts (changed)
interface Scenario { ...; post: PostDef; historyTicks: number }
interface Sim { ...; pendingArrivals: PendingArrivals; history: HistoryBuffer }

// src/planner/plan.ts (changed)
function planToCommands({ sim, plan, probeIndex }): Command[]   // was (plan, probeIndex)

// src/app/debug-api.ts (new)
interface DebugSession { ...; commitPlan({ plan, probeIndex }): void }
interface StateSnapshot { ...; post: { x: number; y: number } }
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

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0029

 Test Files  59 passed (59)
      Tests  799 passed (799)
   Duration  13.97s (transform 1.81s, setup 0ms, import 4.27s, tests 28.81s, environment 4ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

`pnpm docs:validate`: `docs: ok`. `pnpm build`: succeeds (`vite build`, 59 modules).

### `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash 47448f64f618030a
MATCH
191713.2 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash 6108d325bf738ae3
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
27646.1 ticks/s
```

### `pnpm e2e`

`playwright test` (default settings, both `chromium` and `firefox` projects, `fullyParallel:
true`) is flaky **in this sandboxed container specifically** with the default worker count:
Chromium's renderer process intermittently reports `Target crashed` under concurrent load —
confirmed environmental, not a logic defect, three ways:

1. **Firefox passes 100%** on every run, including every test chromium ever crashed on — same
   code, same assertions, same JS (`ADR-0002` guard-rail 5's own cross-engine proof).
2. With `--workers=1`, 89/90 tests pass; the one remaining failure
   (`events.spec.ts`: "events() is identical ... whether reached at 1x, at 10000x, or by
   warpToEvent()") reproduces with a **minimal standalone Playwright script** (no test framework,
   no GRV-0029 code path beyond `window.graviton.step`/`loadSolution`, already exercised
   elsewhere) that does 3 sequential full-page reloads plus repeated `evaluate` calls: it
   succeeds twice, then Chromium's renderer crashes on the third reload — a resource-exhaustion
   pattern under repeated navigation, not a deterministic assertion failure.
3. No assertion inside that test ever fails when the browser doesn't crash first — the crash
   always happens at `page.goto`/`page.waitForFunction`/`page.evaluate` itself, before any
   `expect()` runs.

`--workers=1` tail:

```
  1) [chromium] › tests/e2e/events.spec.ts:91:1 › events() is identical (ticks and kinds) whether reached at 1x, at 10000x, or by warpToEvent()

    Error: page.waitForFunction: Target crashed

  1 failed
    [chromium] › tests/e2e/events.spec.ts:91:1 › events() is identical (ticks and kinds) whether reached at 1x, at 10000x, or by warpToEvent()
  2 skipped
  87 passed (51.8s)
```

Every other e2e spec — including `tests/e2e/parity.spec.ts`'s two goldens (both `run()` and
`load/command/step in uneven batches`, both chromium and firefox), every `planner.spec.ts` test
(including the GRV-0028 ghost-invariant one), and every `events.spec.ts` test besides the one
above — passes on both engines.

## Deviations from the design, and why

- **`issueTickFor` also checks occlusion**, stepping down through a blocked stretch (bounded 64
  steps) rather than only correcting for arrival timing. Without this, the ghost's own lazy
  issuance throws uncaught on any level whose post sweeps out of view periodically (found via the
  flyby-burn golden, not hypothetical — see "two things that proved wrong" above).
- **`segmentBlocked` uses a relative epsilon** (`1e-9 * r^2`) on the inside/outside test rather
  than the literal `c2 <= 0`/`c2 < 0` split from research's pseudocode, to absorb floating-point
  rounding when an endpoint sits exactly on a body's surface (every post/rail/contact point,
  always).
- **Object-target uplink is anchored at live `sim.tick`, not at history-sampled `issueTick`** — see
  the dedicated section above.
- **`Sim.pendingArrivals` lives in a new `src/sim/arrivals.ts` module**, not inline in `sim.ts` as
  first drafted: `commands.ts` needs to enqueue into it, and `sim.ts` already imports `commands.ts`
  at runtime (for `applyCommand`) — inlining the queue in `sim.ts` would have made `commands.ts`
  import back from `sim.ts` at runtime too, a genuine cycle. Not part of the original file list but
  within "keep it simple."
- **`planToCommands` gained a required `sim` parameter** and `debug-api.ts` gained
  `DebugSession.commitPlan({ plan, probeIndex })`: solving the launch's own issue tick needs a
  `Sim`, and `Sim` never leaves `debug-api.ts` (an existing, deliberate boundary
  `captureFrame`/`describeSelection` already keep) — so `app.ts`'s `commitPlan()` now calls the new
  session method instead of hand-calling `planToCommands` with no `Sim` to give it.

## Known limitation (not exercised by any level this unit ships, not fixed)

`planToCommands`'s bundled-burn `probeIndex` prediction (`Sim.objects.count` at commit time) and
`resolveBurnProbe`'s same-tick-batch matching (`commands.ts`) both assume at most one
not-yet-arrived launch is ever bundled with burns referencing it at a time. Two plans committed in
the same tick, or with overlapping issue-to-arrival windows on different rails, could have their
actual (arrival-order) object indices diverge from what was predicted at commit time. Every level
and golden in this unit launches one probe at a time from one rail; a genuinely concurrent
multi-launch scenario is out of scope here (YAGNI — GAME-0001 does not currently call for it), left
as a documented limitation rather than a defensive general fix.

## Anything that surprised me

Both "two things that proved wrong" above were found by running the *existing* test/solve suite
against the new code, not by inspection — the own-body occlusion bug broke solver convergence on
T00-compiler-fixture from 100% (a `0.000 km` miss, cleared) down to "REJECTED_BASE, every
candidate," and the transient-occlusion-in-issueTickFor bug only showed up once the flyby-burn
golden's own burn command was routed through real `issueTickFor` logic in the ghost invariant test
— a level whose rotation period happens to be close to its own node-spacing window. Neither would
have been caught by the light-cone math alone; both needed a real (if small) multi-body scenario
with genuine geometry to surface.
