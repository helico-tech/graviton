# GRV-0018 evidence — level solver

2026-09-18, branch `GRV-0018-level-solver`. Node v24.14.0, pnpm 11.25.0.

## What was built

ADR-0006 §5, research 03 §B.1, §B.3-§B.6: nobody can hand-author a launch to nine significant
digits (a 1e-7 rad heading change moves an eleven-day miss by 28 km), so `pnpm levels:solve <id>`
finds a command log instead.

1. **`src/levels/solve.ts` (new).** `evaluateLaunch` is the objective: `createSim`/`advance` the
   real simulation through any prior-contact commands plus one trial launch, then walk it tick by
   tick, tracking the swept-segment closest approach (`sweptSegmentDistance`, the same clamped-`s`
   geometry `step.ts`'s own `testContactImpacts` uses, at tick resolution rather than substep
   resolution) between the probe and the target contact. A `checkLaunch` rejection (cone/speed/
   reloading) or a body hit is a penalty tier well above any real miss distance (`REJECTED_BASE`
   1e17, `BODY_HIT_BASE` 1e14, both far above any physically real miss in this domain), continuous
   enough within each tier to still slope towards feasibility (a cone violation's penalty grows
   with how far outside the cone; a reload violation's with the tick deficit; a speed violation's
   with the excess). Search closes down a coarse-to-fine `dt` ladder (`coarsenScenario`,
   `toCoarseTick`/`toFineTick`): a coarsest-rung seeding stage (`analyticAim`'s straight-line lead,
   iterated a few times over flight time, plus a heading-inside-the-cone x speed grid, keeping the
   best few), a compass-search refinement (`compassSearch`, a shrinking-step derivative-free
   search -- the design's own named alternative to Nelder-Mead) at each rung, re-converging at
   every finer `dt` and comparing every rung's result at the *target* scale so a rung that
   regresses (research §B.4) never displaces a better earlier one, then an integer-unit polish and,
   if that alone lands close but short, a small local sweep of nearby integer launch ticks (see
   "The bug that made the hard case take an hour" below for why that stage exists and why it is
   now bounded). Contacts are solved in level order (`solveContact`, `solveLevel`), each rail tried
   in turn, later launches respecting `reloadTicks` via `earliestAllowedLaunchTick`. A solution is
   accepted only once `verifyLevel` (including its `dt/2` replay) reports no failures; a `dt/2`
   disagreement retries with 3x the budget, up to two extra attempts, before giving up (ADR-0006
   §5's "minimise miss distance ... before giving up" -- outright non-convergence does not retry,
   since more of the same budget rarely turns a genuinely unreachable contact reachable).
2. **`scripts/levels-solve.ts` (new).** `runLevelsSolve({ levelsDir, id, write, window,
   maxFlightTicks, budget, onProgress })`: without `--write` nothing is written; with it,
   `<id>.solution.json` is written via `canonicalJson` and `<id>.evidence.json` regenerated through
   the same `verifyLevel` path `levels-verify.ts` uses. `"levels:solve": "node
   scripts/levels-solve.ts"` in `package.json`. `pnpm levels:solve <id> [--write] [--window
   <ticks>] [--max-flight <ticks>] [--budget <evals>]`; progress (`stage`, cumulative `evals`, best
   miss in km) goes to stderr via `onProgress`, the result summary to stdout.
3. **`docs/README.md`**, a documentation gap left by GRV-0017: `pnpm levels:verify` had no line in
   the repo's own doc index. Added both `levels:verify` and `levels:solve`.

## Public API additions

```ts
// src/levels/solve.ts (new)
function quantizeHeading(headingRad: number): number
function quantizeSpeed(speedMps: number): number
function sweptSegmentDistance(args: { probeStart: Point; probeEnd: Point; contactStart: Point; contactEnd: Point }): number
function coarsenScenario(args: { scenario: Scenario; multiple: number }): Scenario
function toCoarseTick(fineTick: number, multiple: number): number
function toFineTick(coarseTick: number, multiple: number): number
interface EvaluateLaunchArgs { scenario: Scenario; seed: number; priorLog: readonly Command[]; railIndex: number; contactIndex: number; launchTick: number; headingRad: number; speedMps: number; maxFlightTicks: number }
interface EvaluateLaunchResult { distance: number; cleared: boolean; impactTick: number; rejection: LaunchRejection | null; bodyHit: boolean; probeIndex: number; command: Extract<Command, { kind: 'launch' }> }
function evaluateLaunch(args: EvaluateLaunchArgs): EvaluateLaunchResult
interface SolveWindow { start: number; end: number }
interface SolveLevelOptions { window?: SolveWindow; maxFlightTicks?: number; budget?: number; dtMultiples?: readonly number[] }
interface ProgressEvent { stage: string; evals: number; bestMissKm: number }
interface ContactBest { contactId: string; missKm: number }
type SolveLevelResult = { solution: LevelSolution } | { failure: string; best: ContactBest[] }
function solveLevel(args: { level: CompiledLevel; options?: SolveLevelOptions; onProgress?: (event: ProgressEvent) => void }): SolveLevelResult

// scripts/levels-solve.ts (new)
function runLevelsSolve(args: { levelsDir: string; id: string; write: boolean; window?: SolveWindow; maxFlightTicks?: number; budget?: number; onProgress?: (event: ProgressEvent) => void }): { ok: boolean; message: string }
```

`evaluateLaunch` is the design brief's `evaluate`, renamed for a clearer public name (it is not a
generic evaluator; it always evaluates one trial launch against one contact).

## Test-first, by area

- **`solve.ts`** (`solve.test.ts`, 19 tests): `sweptSegmentDistance` against a closed-form
  point-to-segment distance for a straight relative pass, with the closest point clamped to each
  end of the segment and a zero-relative-motion case; `coarsenScenario` (dt multiplied,
  `reloadTicks` scaled up rounding, multiple 1 a no-op, original never mutated) and
  `toCoarseTick`/`toFineTick` (exact round-trip when the fine tick is a multiple of the rung);
  `quantizeHeading`/`quantizeSpeed` (wrap into `[0, HEADING_TURN)`, round to the nearest mm/s,
  never negative); `evaluateLaunch` penalty ordering (rejected > body hit > miss) against a small
  hand-verified scenario (a star/moon pair sized so a narrow-cone rejection, a body hit, and a
  plain short-flight miss are each independently confirmed by a throwaway geometry check before
  being asserted -- see "the fixture's rail/contact geometry" note in GRV-0017's own evidence for
  why guessing at absolute heading vs. local-vertical geometry is not safe) and against the real
  compiler fixture (the committed solution scores at or below zero; a heading perturbed 0.3 rad
  scores a real, bounded miss, not a penalty tier); `solveLevel` against the real compiler fixture
  *ignoring its committed solution* (finds its own launch, `verifyLevel` passes) and a determinism
  test (two runs byte-identical, given a 20 s timeout -- the default 5 s vitest budget flaked under
  full-suite CPU contention); an unreachable level (a non-spinning body, a contact on its far side,
  a short window) fails cleanly with a useful `best`, respecting the eval budget, in well under the
  test's own 10 s wall-clock assertion.
- **`levels-solve.ts`** (`levels-solve.test.ts`, 4 tests, temp `levels/` dir seeded with the real
  compiled compiler fixture -- this module needs a level that is actually solvable, not the
  smallest `createSim` accepts): no `--write` writes nothing; `--write` writes both the solution
  and a regenerated, passing evidence file; a missing level file fails cleanly; an artificially
  unsolvable level (capture radius shrunk to 1 mm, window and flight budget both cut to almost
  nothing) reports failure and writes nothing.

Both files failed to compile against the pre-implementation tree (`solve.ts`, `levels-solve.ts`
did not exist); all pass once the implementation landed. `solve.test.ts`'s two `solveLevel`
end-to-end tests and the unreachable-level test exercise the real numerical search, not mocks, the
same way GRV-0017's own `verify.test.ts` exercises a real replay.

## The bug that made the hard case take an hour, and its fix

The staged search (seeding, per-rung compass refinement, integer polish) passed `budgetLeft()`
directly as a `compassSearch` call's `maxEvals` in several places: "however much of the level's
overall eval budget is still unspent." For a level with plenty of budget to spare, that is nearly
unbounded. A `compassSearch` call that keeps finding marginal improvements without its step ever
shrinking below its floor -- which the hard-case level's own gravity-curved, multi-day objective
turned out to do, in a stage added specifically to nudge a 39.4 km-vs-40 km near-miss over the
line by trying nearby integer launch ticks -- can then run for as long as that near-unbounded
`maxEvals` allows. It did: a run left going was still on the exact same `dt*1`-rung progress line
after well over an hour, all inside a *single* `compassSearch` call the team lead had to kill
manually. Fixed with one hard ceiling, `MAX_COMPASS_EVALS = 300`, applied via
`Math.min(MAX_COMPASS_EVALS, budgetLeft())` everywhere a compass search was started (`solve.ts`):
the overall per-contact budget still buys many restarts, but no single restart can ever spend more
than 300 evaluations chasing a landscape that never actually bottoms out. This is a correctness
fix, not a loosening -- nothing about capture radius, `dt`, or `verifyLevel`'s pass criteria
changed; a bounded search only ever finds *fewer* solutions than an unbounded one, never more.

## The hard case's own finding: orbital phase has to be chosen, not just muzzle speed and cone

The hard-case level's first geometry (Ilvaeth's `meanAnomalyAtEpoch` copied verbatim from
ADR-0006 §A.6's own illustrative example, 108.9 deg) never got closer than 327 km across a wide
seeding grid, a compass-search refinement, and (once discovered as too small) a nearby-tick sweep.
A purely geometric diagnostic (`runs/find-phase.ts`, throwaway, not committed) confirmed why: for
*every* flight duration whose analytic straight-line-lead speed falls inside the rail's 60-300 km/s
muzzle band, the required heading sits outside its 69 deg firing cone. No amount of extra search
budget fixes that -- the target is not reachable by a direct launch from that rail at that epoch,
full stop. This generalises GRV-0017's own finding (a fixed contact needs a target whose angular
size gives the heading quantum room to work with) one level up: **an interplanetary contact also
needs an epoch the rail's own cone can actually reach.** `runs/find-phase.ts` swept Ilvaeth's mean
anomaly against flight duration and found 10 deg gives a comfortable in-cone, in-band ~4-day
transfer (cosine deficit -0.64, well clear of the cone's own 0 boundary) -- the same kind of
by-construction-solvable choice GRV-0015 and GRV-0017 each made for their own fixtures, not a
solver capability gap. `runs/hard-case.level.yaml` records this in a comment for the next reader.

## The three recorded solver runs

All three use `runEvidenceSolve` (`runs/solve-common.ts`, throwaway, not committed): compiles the
YAML, calls `solveLevel` with progress logged to stderr, then replays the result through
`verifyLevel` exactly as `levels-verify.ts` would.

### The compiler fixture, from scratch

`node runs/solve-fixture.ts` (`levels/T00-compiler-fixture.level.yaml`, default window/max-flight,
budget 8000) -- ignores the committed `T00-compiler-fixture.solution.json` entirely and finds its
own:

```
contact tender-hulk rail 0 dt*16: 1034 evals, best 0.000 km
contact tender-hulk rail 0 dt*4: 1152 evals, best 0.000 km
contact tender-hulk rail 0 dt*1: 1274 evals, best 0.000 km
contact tender-hulk rail 0 polish: 1351 evals, best 0.000 km

=== T00-compiler-fixture ===
wall time: 4.4 s
evaluations (last progress event): 1351
solution: {"level":"T00-compiler-fixture","simVersion":3,"ticks":212,"log":[{"tick":0,"kind":"launch","rail":0,"heading":2570774122,"speed":62911903}]}
verifyLevel failures: []
outcome: {"contactsCleared":1,"contactsTotal":1,"probesLaunched":1,"probesGranted":3,"propellantRemaining":[680]}
contacts: [{"id":"tender-hulk","cleared":true,"impactTick":207,"timeOfFlightSeconds":6210,"closingSpeed":63737.28580663286,"impactEnergy":2234342881098.022,"minimumImpactEnergy":1500000000000}]
dtConvergence: [{"id":"tender-hulk","clearedAtDt":true,"clearedAtHalfDt":true,"impactTimeSecondsAtDt":6210,"impactTimeSecondsAtHalfDt":6225,"impactTimeDifferenceSeconds":15,"closingSpeedAtDt":63737.28580663286,"closingSpeedAtHalfDt":63738.30443882635}]
```

A different launch (heading 2570774122 vs. the committed solution's 2570577009, speed 62911903 vs.
65426813 mm/s) clears the same contact with a 61% energy margin, in seconds, from nothing but the
compiled level -- the acceptance line "solves the compiler fixture in seconds" measured directly.

### GRV-0017's own failed pairing

`node runs/solve-pairing.ts` (`runs/grv0017-original-pairing.level.yaml`, reconstructed verbatim
from git history commit `4fe9d7b` -- rail on the planet `sadal`, contact on the small moon `tesh`
4e8 m away, the pairing GRV-0017's evidence reports its author could not aim by hand: a 0.04 deg
heading change moved the impact point ~900 km, and a shooting-method correction diverged):

```
contact tender-hulk rail 0 dt*16: 1058 evals, best 0.000 km
contact tender-hulk rail 0 dt*4: 1176 evals, best 0.000 km
contact tender-hulk rail 0 dt*1: 1298 evals, best 0.000 km
contact tender-hulk rail 0 polish: 1375 evals, best 0.000 km

=== grv0017-original-pairing ===
wall time: 2.0 s
evaluations (last progress event): 1375
solution: {"level":"grv0017-original-pairing","simVersion":3,"ticks":303,"log":[{"tick":128,"kind":"launch","rail":0,"heading":422338451,"speed":77500000}]}
verifyLevel failures: []
outcome: {"contactsCleared":1,"contactsTotal":1,"probesLaunched":1,"probesGranted":3,"propellantRemaining":[680]}
contacts: [{"id":"tender-hulk","cleared":true,"impactTick":298,"timeOfFlightSeconds":5100,"closingSpeed":76721.62613529326,"impactEnergy":3237414354264.0425,"minimumImpactEnergy":2400000000000}]
dtConvergence: [{"id":"tender-hulk","clearedAtDt":true,"clearedAtHalfDt":true,"impactTimeSecondsAtDt":8940,"impactTimeSecondsAtHalfDt":8955,"impactTimeDifferenceSeconds":15,"closingSpeedAtDt":76721.62613529326,"closingSpeedAtHalfDt":76721.63778905752}]
```

Cleared in 2 seconds with a 35% energy margin (3.237 TJ delivered vs. 2.4 TJ minimum), launched at
tick 128 (3840 s into the window), flight time 5100 s (85 min). The staged search -- analytic aim
plus a real heading x speed grid plus compass refinement, not a single shooting-method correction
-- handles exactly the small-angular-size-target regime GRV-0017's evidence flagged as needing "a
proper multi-dimensional Newton solve" or "a design rule steering contacts onto large-enough
bodies." It needed neither: the launch tick, not just heading, was also free to move, which gives
the search a second degree of freedom to trade against the target's small angular size.

### The hard case (interplanetary, multi-day)

`node runs/solve-hard-case.ts` (`runs/hard-case.level.yaml`, throwaway, not committed to `levels/`
-- research §B.1's own Level-3-shaped problem: rail on a planet at 0.92 au, fixed contact on a
1820 km-radius moon of a gas giant at 1.44 au, muzzle band 60-300 km/s, capture radius 40 km, `dt`
60 s; window widened to ~6 rotations of the rail's host, budget 20000, after the fix above):

```
contact tender-hulk rail 0 dt*16: 1442 evals, best 0.000 km
contact tender-hulk rail 0 dt*4: 1562 evals, best 0.000 km
contact tender-hulk rail 0 dt*1: 1686 evals, best 0.000 km
contact tender-hulk rail 0 polish: 1763 evals, best 0.000 km

=== hard-case ===
wall time: 36.7 s
evaluations (last progress event): 1763
solution: {"level":"hard-case","simVersion":3,"ticks":28861,"log":[{"tick":8880,"kind":"launch","rail":0,"heading":285404894,"speed":61589355}]}
verifyLevel failures: []
outcome: {"contactsCleared":1,"contactsTotal":1,"probesLaunched":1,"probesGranted":3,"propellantRemaining":[680]}
contacts: [{"id":"tender-hulk","cleared":true,"impactTick":28856,"timeOfFlightSeconds":1198560,"closingSpeed":73051.44728330748,"impactEnergy":2935082672602.219,"minimumImpactEnergy":2400000000000}]
dtConvergence: [{"id":"tender-hulk","clearedAtDt":true,"clearedAtHalfDt":true,"impactTimeSecondsAtDt":1731360,"impactTimeSecondsAtHalfDt":1731360,"impactTimeDifferenceSeconds":0,"closingSpeedAtDt":73051.44728330748,"closingSpeedAtHalfDt":73051.44728330748}]
```

Launched at tick 8880 (5.9 days into the window), flight time 1 198 560 s (**13.87 days**, matching
research §B.1's own ~10.9-day reference figure for a closely analogous problem), muzzle speed
61.59 km/s (just above the rail's own 60 km/s floor), a 22% energy margin (2.935 TJ vs. 2.4 TJ
minimum). The `dt/2` replay agrees exactly -- 1731360 s at both `dt` and `dt/2`, a 0 s difference,
not merely "close": this launch sits well inside the capture disk, not grazing its edge. 36.7
seconds and 1763 evaluations, comfortably inside "minutes" and nowhere near the ~15-minute ceiling
-- once the search was pointed at a reachable epoch and no longer at risk of one restart consuming
the whole budget.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0018


 Test Files  34 passed (34)
      Tests  424 passed (424)
   Start at  08:01:38
   Duration  13.51s (transform 998ms, setup 0ms, import 2.52s, tests 27.73s, environment 3ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: T00-compiler-fixture ok
```

## `pnpm docs:validate`

```
$ node scripts/validate-docs.ts
docs: ok
```

## `pnpm build`

```
$ vite build
vite v8.2.2 building client environment for production...
transforming...
✓ 20 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                 0.74 kB │ gzip: 0.41 kB
dist/assets/index-CNM6V6Di.js  25.60 kB │ gzip: 9.34 kB │ map: 138.24 kB

✓ built in 37ms
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
185548.4 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
21148.0 ticks/s
```

Both goldens replay to their recorded hash unchanged -- `src/sim/**` was not touched in this unit
(the rule was checked, not merely followed: `git diff` against `src/sim/` is empty for the whole
unit).

## `pnpm e2e` tail

```
Running 34 tests using 4 workers
  ... (console-gate, parity, screenshot specs, chromium + firefox)
  2 skipped
  32 passed (5.8s)
```

2 skipped are the pre-existing Firefox screenshot tests, unrelated to this unit (same as noted in
GRV-0015's and GRV-0017's own evidence).

## Deviations from the design brief, and why

- **No mid-course burn stage.** The brief allows one "optionally... if the direct launch cannot
  clear," with an explicit out if it would balloon the unit. Every level this unit had to solve --
  the compiler fixture, GRV-0017's own failed pairing, and the hard interplanetary case -- cleared
  with a direct launch alone, matching GRV-0015's own finding for a closely analogous geometry. The
  acceptance line is satisfied by this documented omission rather than by unused machinery.
- **`evaluate` renamed `evaluateLaunch`.** The brief's own pseudocode names the objective function
  `evaluate`; `evaluateLaunch` is more specific about what it evaluates (one trial launch against
  one contact) and avoids a name that reads as a generic evaluator.
- **Stage 1's "keep the best K seeds" is `SEED_KEEP = 5`,** not a smaller number originally tried
  (3): the hard case's own investigation (see above) showed a narrower seed keep can plateau well
  short of the true optimum on a longer, gravity-curved transfer, and 5 costs little extra against
  the eval budgets in play.
- **A tick-radius local sweep was added to stage 3** (`TICK_POLISH_RADIUS`, `polishFrom`) beyond
  what the design brief's five stages describe, specifically because heading/speed alone landed at
  39.4 km against a 40 km capture radius on the hard case (the solver's own tick-boundary objective
  and the real simulation's finer substep impact test do not agree to the metre -- research §B.4).
  This is the stage that surfaced the `MAX_COMPASS_EVALS` bug above; it is bounded per restart
  (`TICK_POLISH_EVALS_PER_RESTART = 24`) for exactly that reason.

## Problems outside this unit (for the team lead to file)

- None found beyond the bug already fixed within this unit (see "The bug that made the hard case
  take an hour" above) -- caught and corrected before this evidence was recorded, not left for a
  follow-up.
