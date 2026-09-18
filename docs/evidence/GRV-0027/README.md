# GRV-0027 evidence — events and time control

2026-09-18, branch `GRV-0027-events`. Node v24.14.0, pnpm 11.25.0.

## What was built

Picks up `docs/issues/2026-09-18-no-auto-drop-to-1x-on-impact.md` (GAME-0001 §4.11): the player
never warps past a decision.

1. **`src/app/events.ts`** (pure, unit-tested). `SimEvent { tick, kind, probe?, contact?, body? }`
   over seven kinds (`launch`, `nodeStart`, `nodeEnd`, `impact`, `bodyHit`, `cleared`,
   `closestApproach`). `diffEvents({ before, after })` edge-detects launch (object count rise),
   node start/end (`burning` edges), impact/body hit (`hitContact`/`hitBody` newly set) and a
   contact clearing between two adjacent tick samples -- tagged at the pre-increment tick
   `sim.ts`'s `advance` actually applies a command/edge at (`after.tick - 1`), except impact/
   cleared, which trust the sim's own recorded `impactTick` directly (matching `src/planner/
   ghost.ts`'s own preference). `sampleClosestApproach({ prior, tick, probe, contact, range })`
   is a small stateful trend tracker (`RangeTrend`) fed one range sample at a time: it fires
   exactly when a falling range turns into a rise, reporting the *previous* sample as the local
   minimum -- reused identically by the live session's own per-tick loop and by predictions
   (below), so there is one source of truth for "closest approach."
2. **`src/app/predict.ts`** (new file, not in the unit's own file list -- see "Deviations").
   `predictProbe({ level, log, probe, fromTick, horizonTick })` predicts a *running* (already-
   launched) probe's remaining flight: a fresh, isolated `Sim` replays the committed log to
   `fromTick`, then keeps advancing with the *same* log (no new commands issued -- a running
   probe's own future burns are already committed), feeding each tick's range-to-each-uncleared-
   contact into `sampleClosestApproach` and stopping at the probe's own first impact/body hit.
   Not `src/planner/ghost.ts`'s `integrateGhost`: that always issues a *new* launch command for a
   still-being-drafted plan and creates a fresh probe index, which doesn't fit an already-launched
   probe. `src/planner/**` is untouched.
3. **`src/app/debug-api.ts`**. `stepSampled`'s `onTick` callback gained a second parameter,
   `TickEventSample { tick, objects, contacts, contactPositions }` (every live object's `burning`/
   `hitContact`/`hitBody`, every contact's `cleared`/`impactTick`, and every contact's world
   position) -- extending the existing per-tick sampling point trails.ts already used, per the
   design note, rather than adding a second loop. Backward compatible: TypeScript allows a
   function with fewer parameters where more are expected, so `src/headless/render.ts`'s own
   `(positions) => sampleTrailSet(...)` and the pre-existing `stepSampled` unit tests needed no
   changes (verified: `pnpm typecheck` and every existing `debug-api.test.ts` test still pass
   unmodified). Also exposes `events()`, `nextEventTick()` and a synchronous `warpToEvent()` on
   both `DebugApiDriver` and the public `DebugApi`.
4. **`src/app/app.ts`**. Session state: an explicit `eventLog: SimEvent[]`, the per-tick diff
   cursor (`lastEventSnapshot`), a `Map` of closest-approach trends keyed `probe:contact`, a
   `pendingInvert` flag and an armed `warpTarget` tick -- all reset on `loadLevel`/`load`.
   - `step(ticks)` is still the one place the loop advances. It clamps to an armed `warpTarget`
     (`Math.min(ticks, warpTarget - now)`, floored at 0) so a caller's own per-frame budget is
     never exceeded mid-warp; advances via `stepSampled`, feeding `diffEvents` and
     `sampleClosestApproach` once per tick and appending whatever lands to `eventLog`; if
     anything landed and the rung was above 1x, drops it to 1 and arms `pendingInvert`
     (deliberately gated on "was above 1x" -- landing an event already at 1x, i.e. real-time
     play, doesn't flash); and unconditionally drops to 1x and clears the target the instant the
     armed tick is reached, even on the rare command whose own effect doesn't produce a matching
     `SimEvent`.
   - `warpToEvent()` arms the target (`nextEventTick() + 1` -- see "the off-by-one" below) and
     jumps the rung to the ladder's top; it does **not** itself drain the warp (see "Deviations").
   - `nextEventTick()` = min over: committed log commands with `tick > now`, the draft ghost's
     own events (`plannerState.ghost.events`, read-only -- `src/planner/**` untouched), and each
     currently-running probe's `predictProbe` result, cached per probe keyed by the committed
     log's own `.length` (`session.log()` is mutated in place by `command`, never reassigned, so
     length is the change signal `GhostCache`'s reference check can't be here).
   - `events()` returns a copy of `eventLog`; `takePendingInvert()` is a read-and-clear flag,
     `true` exactly once per landed drop.
   - `timelineData()` adds a unified `event.<n>` mark list: `eventLog`'s own past events first
     (`past: true`), then `nextEventTick()`'s own upcoming sources continuing the same index
     (`past: false`) -- the pre-existing `launch.N`/`impact.N`/`ghost.*` marks are untouched, so
     this is additive (verified: every pre-existing `app.test.ts` timeline assertion still passes,
     two updated only because the new marks now show up *alongside* them -- see the diff).
   - `statusValues().event` reads the terse text of the *most salient* landed event: normally the
     last one, except an impact that also clears its contact in the same tick pushes both (impact
     causally first, cleared right after) -- `cleared` alone is strictly less informative than the
     impact that caused it, so that specific pair prefers the impact. Caught by a unit test
     written against the real L01 solution before the fix (see "Test-first").
5. **`src/app/main.ts`**. Key `.` calls `changeWarp(() => app.warpToEvent())` (eased jump to the
   top rung, like `[`/`]`); the drop itself is announced by the inversion, not eased.
   `applyInvertToggle()` toggles `.status-bar--invert` from `app.takePendingInvert()`, called once
   per real rAF frame and from the debug API's own `render()` -- and returns whether a drop just
   landed, so the rAF loop can cancel any in-flight *manual* warp-label ease (see "Test-first: a
   second bug the real-loop e2e test caught"). The debug API's `warpToEvent` wraps `App.
   warpToEvent()` with a synchronous drain loop (`while (warpTargetTick() !== null) step(budget)`,
   guarded), matching the design note's "advances to the target in one call -- that is fine
   there."
6. **`src/ui/status.ts`**/**`src/ui/timeline.ts`**/**`src/app/styles.css`**. A sixth status field,
   `EVENT` / `data-readout="status.event"`. `.status-bar--invert { filter: invert(1); }` -- a
   class toggle, no transition. `TimelineMark.past?: boolean` drives `.timeline-mark--past`
   (taller, `--known`-coloured tick, matching the cursor's own emphasis) for a landed event;
   everything else (including the new marks' own `upcoming` half) keeps the pre-existing dim
   default -- height and colour both differ, not colour alone (GAME-0002 §11).
7. **Tests**: `src/app/events.test.ts` (15), `src/app/predict.test.ts` (6, against the real L01
   level/solution and a hand-built no-contact scenario), `src/app/debug-api.test.ts` (+3, the
   extended `TickEventSample` against the real `intercept.json` golden), `src/app/app.test.ts`
   (+13: events log, automatic drop gating, `nextEventTick`/`warpToEvent`/`warpTargetTick`, the
   impact-vs-cleared status fix, an explicit `warpTo` cancelling an in-flight target -- plus 3
   pre-existing timeline tests updated for the additive marks), `tests/e2e/events.spec.ts` (6,
   both browsers, strict console gate; the real, non-debug loop included, mirroring `loop.spec.ts`
   `docs/evidence/GRV-0024/README.md`'s own recipe).

## Deviations from the brief, and why

- **`src/app/predict.ts` is a new file**, not in the unit doc's own `src/app/{events,loop,app,
  main,debug-api}.ts` list. The dispatch message anticipated this exact question ("check whether
  `integrateGhost` can be pointed at an existing probe index or needs a small sibling helper"):
  `integrateGhost` always issues a *new* launch command and allocates a fresh probe index for a
  draft plan -- a running probe has already launched, so pointing it at an existing index isn't a
  parameter change, it's a different code path. The sibling helper needed nothing from
  `src/planner/**` beyond `Command`/`Sim` (already used the same way by `src/app/planner.ts`'s own
  `checkPlanLaunch`), so it lives in `src/app` and reuses `events.ts`'s own `sampleClosestApproach`
  -- `src/planner/**` was never touched, so this didn't need to wait on a go-ahead.
- **`warpToEvent()` on `App` only arms** (jumps the rung, records the target); it does not drain
  the warp itself. The design note says the real loop must never do "a single giant advance that
  freezes the page beyond the budget" -- since `step()` already clamps to an armed target and the
  existing rAF loop already calls `step(effectiveTicksThisFrame(rung))` every frame, arming alone
  is enough to make the *real* page drain it a budget at a time with zero changes to the frame
  loop's own body. The *debug* API's own synchronous requirement ("advances to the target in one
  call") is instead satisfied by a drain loop in `main.ts`'s `driver.warpToEvent`, which is the one
  place that already knows which mode it's in.
- **The off-by-one.** `sim.ts`'s `advance` applies a command, or runs the step that flips an edge
  (`burning`, `hitContact`, …), *while processing* tick `T` (checked against the pre-increment
  `sim.tick`) -- that only *completes*, and the resulting `SimEvent` only lands in `eventLog`, once
  `sim.tick` reaches `T + 1`. `nextEventTick()` reports `T` (matching every displayed/logged event
  tick); `warpToEvent` therefore arms `T + 1`, not `T`, or `step`'s own clamp would stop one tick
  short of the event having actually happened. Caught by a unit test
  (`src/app/app.test.ts`, "step clamps to it and drops to 1x on arrival") before it ever reached
  the e2e layer.

## Test-first: two bugs the tests caught before shipping

**The impact/cleared status text.** `src/sim/dynamics/step.ts`'s `testContactImpacts` sets
`hitContact` *and* (when the energy qualifies) `cleared` in the same call, so `diffEvents` emits
both `impact` and `cleared` for the same tick, causally in that order. `statusValues()` originally
read `eventLog.at(-1)` unconditionally, so a clearing impact announced "CLEARED DRIFT-HULK" instead
of "IMPACT PRB-01 → DRIFT-HULK" -- technically the *last* event, but the less informative one. A
unit test written against the real L01 solution (`app.warpTo(3299)`, one past the recorded impact)
reproduced it first:

```
$ pnpm vitest run src/app/app.test.ts -t IMPACT
AssertionError: expected 'CLEARED DRIFT-HULK' to be 'IMPACT PRB-01 → DRIFT-HULK'
```

Fixed by `lastEventForStatus()`: prefer the second-to-last event when the last is `cleared` and
the one right before it is an `impact` at the same tick.

**A second bug the real-loop e2e test caught.** `tests/e2e/events.spec.ts`'s real (non-debug) loop
test presses `]` five times then waits for the impact -- L01's own flight is short enough at the
700-tick frame budget that the automatic drop can land *before* the manual warp-label ease (150 ms,
`loop.ts`'s `warpEaseFrame`) finishes interpolating toward "10000x". The eased write was
unconditional every frame the old animation was still running, so it kept overwriting the already-
correct "1x" label main.ts had just written from the drop itself with a stale interpolated value,
fighting it for the rest of the 150 ms:

```
Locator:  locator('[data-readout="status.warp"]')
Expected: "1x"
Received: "3166x"
```

Fixed by having `applyInvertToggle()` report whether a drop just landed, so the rAF loop cancels
`warpAnim` the same frame -- an automatic drop is never eased (GAME-0002 §9 draws that distinction
explicitly: the ease is for manual warp changes, the drop is announced by inversion instead).

## Screenshots

Captured with an ad hoc Playwright driver (not committed -- `scripts/screenshot.ts`'s own fixed
`?tick=&zoom=&cx=&cy=&select=` params don't cover "call several debug-API methods in sequence,"
the same reason `docs/evidence/GRV-0026/README.md`'s own drag-state shots needed one). Verified
pixel-for-pixel via `@napi-rs/canvas` rather than by eye, since the terminal's own image preview
renders both frames too similarly to tell apart at this size.

**`status-bar-inverted.png`** (`?debug=1&level=L01-intercept`, `loadSolution()`, `warpToEvent()`
lands the launch, then `render()`) -- `status.event` reads `LAUNCH PRB-01`, `status.warp` `1x`.
Pixel (10, 10) of the bar itself: `rgba(244, 240, 235, 255)` -- the panel background inverted from
`--panel: #0b0f14` (`rgb(11, 15, 20)`) to its near-white complement, confirming `filter: invert(1)`
is actually applied, not just the class present.

**`status-bar-cleared.png`** (immediately after, one more `render()` with no further event) --
same readouts, pixel (10, 10) back to `rgba(11, 15, 20, 255)` -- `--panel` itself, uninverted. One
render shows it, the next clears it, exactly as the design note specifies for debug mode.

**`timeline-before.png`** (same load, before `warpToEvent()`) -- a bare axis, the present-time
cursor at tick 0, and the not-yet-reached launch as a plain (already-dim by default) mark; no
`.timeline-mark--past` elements yet (`0`, asserted directly in the capture script's own count).

**`timeline-after.png`** (after the launch lands) -- one `.timeline-mark--past` (taller, brighter
tick) for the launch that just happened, alongside two plain (dim) marks: the old `launch.0` mark
(unclassified, as designed -- pre-existing marks are untouched) and the new upcoming `event.1` for
the predicted impact, labelled `IMPACT PRB-01 → DRIFT-HULK`. The launch mark's own label overlaps
the present-time cursor's label at this zoom (they sit at almost the same tick) --
`docs/issues/2026-09-18-timeline-event-marks-crowd-near-cursor.md` (P3, filed, not fixed here: a
pre-existing characteristic of every mark on this strip, not introduced by this unit).

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0027

 Test Files  56 passed (56)
      Tests  760 passed (760)
   Start at  13:41:52
   Duration  13.69s (transform 1.57s, setup 0ms, import 3.77s, tests 27.30s, environment 6ms)

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
Running 88 tests using 4 workers
  ✓  events.spec.ts › warpToEvent() drops to launch, then to impact, at the evidence file's own recorded tick (chromium, firefox)
  ✓  events.spec.ts › a further warpToEvent() with nothing left to predict is a no-op (chromium, firefox)
  ✓  events.spec.ts › events() is identical (ticks and kinds) whether reached at 1x, at 10000x, or by warpToEvent() (chromium, firefox)
  ✓  events.spec.ts › screenshot: render() right after a landed event shows the status bar inverted, and clears on the next render() (chromium, firefox)
  ✓  events.spec.ts › the timeline strip marks upcoming events dim and past ones full (chromium, firefox)
  ✓  events.spec.ts › the real loop auto-drops to 1x within one frame budget of the recorded impact tick (chromium, firefox)
  ... every pre-existing spec, unchanged ...
  2 skipped (screenshot.spec.ts's own pre-existing firefox skip, unrelated)
  86 passed (19.3s)
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
206140.7 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
26239.5 ticks/s
```

Both hashes unchanged from prior units -- `src/sim/**` was not touched (checked via `git status`/
`git diff` against `src/sim/`, not merely followed).

## `pnpm screenshot --debug`

```
$ node scripts/screenshot.ts --debug --out runs/gate-screenshot.png
{"url":"http://127.0.0.1:.../?debug=1","build":"be2c025","expected":null,"violations":[],"out":"runs/gate-screenshot.png"}
```

Exit 0.
