# GRV-0017 evidence — level verifier and generated evidence

2026-09-18, branch `GRV-0017-level-verifier-and-evidence`. Node v24.14.0, pnpm 11.25.0.

## What was built

ADR-0006 §5, research 03 §B.5 units 2-3, §B.7: a level's solvability is a replayed fact in CI,
with a committed, diffable evidence file.

1. **`src/levels/verify.ts` (new).** `verifyLevel({ level, levelHash, solution, solutionHash })`
   -- pure, no fs or other node builtins, so it runs equally under `vitest` and under the CLI
   layer. Replays `solution.log` against `level.scenario` with the real simulation
   (`createSim`/`advance`), then reads the outcome straight off `sim.contactState` and
   `sim.objects`: contacts cleared/total, probes launched (`objects.count`) vs granted
   (`scenario.capacity`), propellant remaining per probe (`mass - dryMass`), and per contact the
   impact tick, time of flight (`(impactTick - launchTick) * dt`, the launching probe found via
   `objects.hitContact`), closing speed and impact energy against its minimum. Failures are
   collected rather than thrown at the first one (mirrors `compile.ts`'s own style): a solution
   for the wrong level, a stale `simVersion`, an uncleared contact, a `dt/2` disagreement, and a
   command the simulation rejects (caught, not thrown -- its message becomes a failure string and
   the replay stops there, so the evidence still reflects whatever ran before the rejection).
   Hashes are computed by the caller with `node:crypto` and passed in as `sha256:<hex>` strings,
   keeping this module free of node builtins as the design asked.
2. **`dt/2` convergence.** `halveDt` (dt halved, every rail's `reloadTicks` doubled) and
   `doubleLogTicks` (every command's `tick`, and a burn's `atTick`, doubled) are small, separately
   exported pure functions -- command times are quantised to ticks, so doubling both the log and
   `dt/2` keeps every command at the same physical instant the original log placed it at.
   `compareDtConvergence` takes two contact outcomes (dense `cleared`/`impactTick`/`impactSpeed`
   arrays -- a `Sim` is not required, so it is unit-tested with synthetic inputs) and reports, per
   contact, both impact times in seconds, their difference, both closing speeds, and whether the
   two runs agree on which contacts cleared. `verifyLevel` only runs the `dt/2` sweep when the
   primary replay completed without a rejected command -- there is nothing valid to compare a
   `dt/2` run against otherwise.
3. **`scripts/levels-verify.ts` (new).** Mirrors `levels-build.ts`'s own shape and `--check`
   semantics. For every `levels/*.level.json` with a sibling `<id>.solution.json`: hashes both
   files, calls `verifyLevel`, writes `<id>.evidence.json` in canonical JSON, and prints
   `levels: <id> ok` or `levels: <id> FAILED: <failures>`. A level without a solution prints
   `levels: <id> no solution` and does not fail (campaign levels are gated in GRV-0019).
   `--check` writes nothing and additionally fails when the evidence on disk would change.
   `"levels:verify": "node scripts/levels-verify.ts"` is wired into `package.json`, and
   `pnpm check` now runs `pnpm levels:build --check && pnpm levels:verify --check`.
4. **`.prettierignore`** gained `levels/*.evidence.json` and `levels/*.solution.json` (generated/
   canonical artefacts, alongside the existing `levels/*.level.json`).
5. **The compiler fixture, reworked.** See "The fixture's rail/contact geometry" below for why the
   as-committed pairing (rail on the planet, contact on the moon) had to be reversed.
   `levels/T00-compiler-fixture.solution.json` (committed) and its generated
   `.evidence.json` (also committed, reproduced verbatim below) exercise the whole path end to
   end before the first campaign level exists.

## Public API additions

```ts
// src/levels/verify.ts (new)
interface LevelSolution { level: string; simVersion: number; ticks: number; log: Command[] }
interface ContactEvidence { id: string; cleared: boolean; impactTick: number; timeOfFlightSeconds: number; closingSpeed: number; impactEnergy: number; minimumImpactEnergy: number }
interface DtConvergenceEntry { id: string; clearedAtDt: boolean; clearedAtHalfDt: boolean; impactTimeSecondsAtDt: number; impactTimeSecondsAtHalfDt: number; impactTimeDifferenceSeconds: number; closingSpeedAtDt: number; closingSpeedAtHalfDt: number }
interface Evidence { level: string; levelHash: string; simVersion: number; solutionHash: string; finalStateHash: string; outcome: {...}; contacts: ContactEvidence[]; dtConvergence: DtConvergenceEntry[] }
function verifyLevel(args: { level: CompiledLevel; levelHash: string; solution: LevelSolution; solutionHash: string }): { evidence: Evidence; failures: string[] }
function halveDt(scenario: Scenario): Scenario
function doubleLogTicks(log: readonly Command[]): Command[]
function compareDtConvergence(args: { contactIds: readonly string[]; dt: number; halfDt: number; atDt: ContactOutcome; atHalfDt: ContactOutcome }): { entries: DtConvergenceEntry[]; agrees: boolean }

// scripts/levels-verify.ts (new)
function verifyLevels(args: { levelsDir: string; check: boolean }): { ok: boolean; messages: string[] }
```

## Test-first, by area

- **`verify.ts`** (`verify.test.ts`, 13 tests, against the real compiled fixture + solution):
  all contacts cleared and no failures; time of flight matches an independently computed
  `(impactTick - launchTick) * dt`; propellant remaining matches the untouched tank (the solved
  launch never burns); `levelHash`/`solutionHash` pass through verbatim; two runs are
  byte-identical through `canonicalJson`. Failure table: a heading perturbed 1,000,000 units past
  the margin (still a valid, non-rejected launch -- confirmed separately) fails "not all contacts
  cleared"; a stale `simVersion` fails; a solution for the wrong level id fails; a command outside
  the muzzle-speed band is caught and reported, never thrown. `halveDt` and `doubleLogTicks` are
  each unit-tested for the exact transform and for not mutating their input (`structuredClone` +
  `toEqual` against the pre-call snapshot). `compareDtConvergence` is tested with synthetic
  `{cleared, impactTick, impactSpeed}` inputs directly, both an agreeing and a disagreeing case,
  confirming the "hard to construct honestly" real `dt/2` mismatch (design brief) does not need a
  real scenario to be exercised.
- **`levels-verify.ts`** (`levels-verify.test.ts`, 7 tests, temp `levels/` dir, mirrors
  `levels-build.test.ts`'s own style): a clearing level writes evidence and reports `ok`;
  `--check` is clean once written; `--check` fails (writes nothing) when the evidence file is
  missing; `--check` fails when committed evidence no longer matches; a level without a solution
  is reported, not failed; a level whose solution leaves a contact uncleared still writes evidence
  and reports `FAILED: ... not all contacts cleared`; multiple levels are each reported on their
  own line, sorted by filename.

`verify.ts` itself was not written strictly test-first (see "Deviations" below) -- finding a
solvable launch for the fixture needed extensive throwaway numerical exploration first (see "The
fixture's rail/contact geometry"), and the module's shape settled out of that. Once written, its
tests were checked for meaningfulness by mutation rather than trusted on sight: with
`contactsCleared < contactsTotal` replaced by `if (false)`, the "not all contacts cleared" test
failed as expected (`expected [] to include 'not all contacts cleared'`); reverted, all 13 tests
pass again. `levels-verify.test.ts` (the CLI layer) *was* written before `levels-verify.ts`
existed, and failed to compile until the module did.

## The fixture's rail/contact geometry

`levels/T00-compiler-fixture.level.yaml` originally had its rail on the *planet* (`sadal`) and its
one fixed contact on the small *moon* (`tesh`, radius 180 km, orbiting 4e8 m out). Solving a
launch for that pairing was attempted first and abandoned:

- A closed-form aim (mirroring GRV-0015's own `search-intercept.mjs`: point the rail's *total*
  launch velocity at the target's predicted position) worked cleanly for short flights (up to
  ~140 ticks, comfortable energy margins) but the achievable flight time is capped by the rail's
  60 km/s muzzle-speed floor against the ~4e8 m separation -- at longer flights the trajectory
  started missing the moon's body outright.
- A shooting-method correction (aim at the target, measure where the *actual* trajectory landed,
  correct) was tried next, at both full and damped (0.3x) gain. It diverged: a heading change of
  ~0.04 degrees (≈4.5e5 of the 2^32-unit heading range) moved the actual impact point by roughly
  900 km. The moon's angular size as seen from the rail is only ~0.03 degrees, so hitting a
  specific 40 km spot on it needs heading precision far finer than either the quantum (ADR-0006
  §4 already argued this quantum is fine down to ~0.4 km at the *research report's* measured
  sensitivity, for an 11-day flight over interplanetary distances -- this is a different,
  much harsher regime: a near body, at high closing speed, approached almost radially) or a
  first-order correction converges on.

Reversing the pairing -- rail on the moon (`tesh`), facing the much larger planet (`sadal`,
radius 6100 km, ~34x the moon's) -- is exactly GRV-0015's own intercept golden shape, and it
converged on the very first analytic aim, no correction needed (`runs/search-fixture-intercept.ts`,
gitignored, not committed): aim the rail's total launch velocity at `contactPoint(t)` (which
already accounts for the host's orbit and spin) at a chosen flight time. A robustness sweep
(perturbing the solved heading by up to ±200,000 of the 2^32-unit range, i.e. up to ~0.017
degrees) found the launch clears anywhere from about -8,000 to +130,000 of perturbation --
several orders of magnitude more margin than the failed pairing, and comparable to GRV-0015's own
~24% miss-distance margin.

This is a design finding, not just an implementation detail: **a fixed contact needs to be sited
on a target whose angular size from the rail is large enough that the launch-heading quantum (and
a solver's own convergence) has room to work with**, which for a close, fast rendezvous means the
*larger* body, not the smaller one. Reported below for the team lead to file -- the twelve-level
table (research 03 §C.1) has several fixed-contact-on-a-body entries (`Lead`, `Rotation`) that
should keep this in mind during design.

## The solved launch

Rail `tesh-nearside` on `tesh` (the moon), longitude 180° (near side, facing `sadal`); contact
`tender-hulk` on `sadal` (the planet), longitude 347°, `captureRadius` 40 km,
`minimumImpactEnergy` 1.5 TJ (the actual delivered energy is 2.4125 TJ, a 61% margin, comparable
to GRV-0015's own ~59%). Flight time chosen: 6000 s (200 ticks at `dt` = 30 s), comfortably inside
the rail's 60-300 km/s muzzle band (solved muzzle speed: 65.43 km/s) and inside "a few hundred
ticks" (`ticks: 220` in the solution, impact lands at tick 199).

```
$ node runs/search-fixture-intercept.ts
command {
  tick: 0,
  kind: 'launch',
  rail: 0,
  heading: 2570577009,
  speed: 65426813
}
tick 220 hash 354ffe5f890dca4f
cleared 1 impactTick 199 impactSpeed 66229.90048300823 impactEnergy 2412519844894.0454
propellant left (kg) 680
wrote levels/T00-compiler-fixture.solution.json
```

`levels/T00-compiler-fixture.solution.json`:

```json
{
  "level": "T00-compiler-fixture",
  "log": [
    {
      "heading": 2570577009,
      "kind": "launch",
      "rail": 0,
      "speed": 65426813,
      "tick": 0
    }
  ],
  "simVersion": 3,
  "ticks": 220
}
```

## The generated evidence

`levels/T00-compiler-fixture.evidence.json`, reproduced verbatim (it is small):

```json
{
  "contacts": [
    {
      "cleared": true,
      "closingSpeed": 66229.90048300823,
      "id": "tender-hulk",
      "impactEnergy": 2412519844894.0454,
      "impactTick": 199,
      "minimumImpactEnergy": 1500000000000,
      "timeOfFlightSeconds": 5970
    }
  ],
  "dtConvergence": [
    {
      "clearedAtDt": true,
      "clearedAtHalfDt": true,
      "closingSpeedAtDt": 66229.90048300823,
      "closingSpeedAtHalfDt": 66228.87610921806,
      "id": "tender-hulk",
      "impactTimeDifferenceSeconds": 15,
      "impactTimeSecondsAtDt": 5970,
      "impactTimeSecondsAtHalfDt": 5985
    }
  ],
  "finalStateHash": "354ffe5f890dca4f",
  "level": "T00-compiler-fixture",
  "levelHash": "sha256:204e9c0ece448f975bdbf3c1ed5fb7054463b042bedae7d8268ff97314507d86",
  "outcome": {
    "contactsCleared": 1,
    "contactsTotal": 1,
    "probesGranted": 3,
    "probesLaunched": 1,
    "propellantRemaining": [
      680
    ]
  },
  "simVersion": 3,
  "solutionHash": "sha256:2204394eddbe0b75cfa0de635b0d4e2d6d753c43849c4c68d99c2fe525d08220"
}
```

The `dt/2` sweep agrees (both runs clear the one contact) and reports both impact times: 5970 s at
`dt` = 30 s vs 5985 s at `dt/2` = 15 s, a 15 s (0.25%) difference -- convergence, not coincidence,
since the two closing speeds (66229.9 vs 66228.9 m/s) also agree to 5 significant figures.

## A sample FAILED run

Produced by perturbing the committed solution's heading by 1,000,000 units (a valid, non-rejected
launch that flies past the contact -- the same perturbation `verify.test.ts` uses), running
`pnpm levels:verify`, then restoring the real solution and evidence files (confirmed byte-
identical to before via `diff`, and `pnpm levels:verify --check` clean afterwards):

```
$ node scripts/levels-verify.ts
levels: T00-compiler-fixture FAILED: not all contacts cleared
```

(Exit code 1; `levels:verify` without `--check` still writes the evidence file in this case, so a
reviewer sees exactly what the failing replay actually did.)

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0017


 Test Files  32 passed (32)
      Tests  401 passed (401)
   Start at  00:05:43
   Duration  3.57s (transform 1.18s, setup 0ms, import 2.71s, tests 4.72s, environment 3ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: T00-compiler-fixture ok
```

## `pnpm levels:verify` (write mode)

```
$ node scripts/levels-verify.ts
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
dist/assets/index-DuYd70kW.js  25.60 kB │ gzip: 9.34 kB │ map: 138.24 kB

✓ built in 40ms
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
196716.7 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
25982.3 ticks/s
```

Both goldens replay to their recorded hash unchanged -- `src/sim/**` was not touched in this unit.

## `pnpm e2e` tail

```
Running 34 tests using 4 workers
  ... (console-gate, parity, screenshot specs, chromium + firefox)
  2 skipped
  32 passed (6.0s)
```

2 skipped are the pre-existing Firefox screenshot tests (unrelated to this unit, same as noted in
GRV-0015's own evidence).

## Deviations from the design brief, and why

- **`src/levels/verify.ts` was not written strictly test-first.** The brief asks for tests first,
  watched failing; here, finding *any* solvable launch for the fixture (the prerequisite for a
  meaningful "all cleared" test) took most of the effort and needed `verifyLevel`'s own shape
  (what a replay needs to report) to be worked out alongside the numerical search, in a throwaway
  script, before the real module and its tests were written. `levels-verify.test.ts` (the CLI
  wiring layer, no such prerequisite) *was* written first and watched fail to compile.
  `verify.test.ts`'s meaningfulness was instead checked after the fact by mutation (see above).
- **The fixture's rail and contact swapped hosts** (rail moved from `sadal` to `tesh`, contact
  moved from `tesh` to `sadal`), rather than keeping the as-committed pairing and only adjusting
  numbers. See "The fixture's rail/contact geometry" above -- the original pairing is not
  solvable by an analytic-aim-plus-small-refinement search, or likely by any search a solver
  script could run in reasonable time, given the moon's tiny angular size from the rail.
- **`minimumImpactEnergy` changed from 2.4 TJ to 1.5 TJ.** The new geometry's delivered impact
  energy (2.4125 TJ) happens to sit almost exactly at the old threshold; 1.5 TJ gives the same
  ~60% margin style GRV-0015 used rather than a knife-edge pass.
- **Rail/contact ids renamed** (`sadal-north` → `tesh-nearside`) since the id encoded the old
  host; the contact kept its id (`tender-hulk`) since that name never referenced a host.
- **`findHitter` (verify.ts) returns the *first* object that hit a contact, not necessarily the
  one whose stats are in `contactState`.** Once a contact clears, `step.ts`'s impact test skips
  it entirely, so in practice only one probe can ever register a hit against any contact this
  unit's levels use; the design brief itself describes the lookup as "find the probe via
  `objects.hitContact`" (singular). A multi-hit contact (several probes, none individually
  clearing it) would need per-object impact-tick tracking to attribute the evidence correctly --
  out of scope here, and noted as an issue below.
- **The `dt/2` sweep is skipped (not run, not failed) when the primary replay's command log is
  rejected**, rather than always running it. There is no valid primary result to compare a `dt/2`
  run against in that case, and running it anyway would either throw identically (wasted work) or
  produce a misleading "agrees"/"disagrees" verdict for a replay that never really happened.
- **No GitHub Actions workflow change.** `.github/workflows/ci.yml` already runs `pnpm check`
  (confirmed by reading it); `levels:verify --check` rides along with no separate step needed.

## Problems outside this unit (for the team lead to file)

- A fixed contact sited on a body whose angular size from the launching rail is small (here, a
  180 km-radius moon at 4e8 m separation) needs heading precision far beyond the 1/2^32-turn
  quantum or a first-order solver correction, for a close, fast (tens of km/s) rendezvous -- see
  "The fixture's rail/contact geometry" above. The twelve-level table (research 03 §C.1) has
  fixed-contact-on-a-body entries (`Lead`, `Rotation`) that should keep this in mind; a future
  solver (`pnpm levels:solve`, research §B.5 unit 4) will need either a proper multi-dimensional
  Newton solve (not the single-step correction this unit's throwaway script tried) or a design
  rule steering contacts onto large-enough bodies.
