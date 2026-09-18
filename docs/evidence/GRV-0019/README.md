# GRV-0019 evidence — level 01, Intercept

2026-09-18, branch `GRV-0019-level-01-intercept`. Node v24.14.0, pnpm 11.25.0.

## What was built

GAME-0001 §6 beat 1 ("Intercept. Fixed contact, one rail, gravity negligible.") as data:
`levels/L01-intercept.level.yaml`, its compiled JSON, its solver-found solution and evidence
(ADR-0006 §5), plus the `levels:verify` gate that fails a campaign level with no solution
(GRV-0018's own solver and GRV-0017's own verifier untouched -- `src/sim/**` and `src/levels/**`
were not modified this unit, checked below, not merely followed).

## The system

Corvai, Meskel and Yarune -- an invented system (ADR-0001 §"Decision", GAME-0002 naming tone),
none of it reused from the research report's or the compiler fixture's own illustrative examples
(Kerwen/Sadal/Tesh, Ilvaeth). Corvai is a brown-dwarf-class primary, 2.5e28 kg (~13.2 Jupiter
masses, the low end of the class -- above it, deuterium fusion starts). Meskel (rail host) and
Yarune (contact host) are two small rocky/icy bodies on the same 0.66 au orbit around Corvai,
1.7 deg apart in mean anomaly at epoch: ~3.0e6 km apart, which Meskel Rail's own muzzle band
(120-280 km/s) covers in a few hours -- the GAME-0001 §4.3 "1e5 m/s band" cruise regime, not a
slingshot or a multi-day transfer. `runs/geometry-search.ts` (throwaway, gitignored, not
committed) is the script that picked the semi-major axis and phase offset: it evaluates the real
`evaluateEphemeris` against candidate elements directly rather than by hand algebra, and also
carries the order-of-magnitude deflection estimate (`theta ~= 2*G*M / (b*v^2)`, a straight-chord
flyby approximation) that motivated 0.66 au as "large enough that a brown-dwarf-class primary
still bends the path well under a degree, small enough to stay inside GAME-0001 §4.1's 0.6-4.8 au
system scale."

Meskel Rail's headingCone (60 deg) and reloadTime (4 h) are real, load-bearing numbers -- the
solver has to search a heading/speed grid inside the cone and respect the reload floor on a retry
-- without being the lesson: the rail's rotation period (16 h) sets the default solve window
(1.5 rotations, `defaultWindow` in `src/levels/solve.ts`), so the search finds a launch phase
rather than being handed one. `probes[0].count: 2` grants a spare probe rather than the bare
minimum: this is the player's first level, and the failure mode a first attempt is likeliest to
hit is a bad heading drag, not a bad plan -- a second probe forgives that without weakening the
teaching point (the solved level only ever launches one). `nodeBudget: 0`: this beat is the
direct-launch case that beats 5 ("Budget") and 6 ("Slingshot") build on, so no mid-course-burn
budget is granted at all, matching GRV-0018's own finding that a direct launch alone cleared every
level it solved.

## The compiler

```
$ pnpm levels:build
$ node scripts/levels-build.ts
levels: ok
```

No errors, no warnings (the muzzle-band-reach and wide-cone warnings from `compile.ts` both stay
silent: 280 km/s over 40 days reaches far past the worst-case Corvai-primary separation bound, and
60 deg is under the 80 deg wide-cone threshold).

## The two solver runs (determinism)

`pnpm levels:solve L01-intercept --write`:

```
contact drift-hulk rail 0 dt*16: 1172 evals, best 0.000 km
contact drift-hulk rail 0 dt*4: 1288 evals, best 0.000 km
contact drift-hulk rail 0 dt*1: 1408 evals, best 0.000 km
contact drift-hulk rail 0 polish: 1485 evals, best 0.000 km
levels: L01-intercept solved and written (levels/L01-intercept.solution.json, levels/L01-intercept.evidence.json)
```

`pnpm levels:solve L01-intercept` (no `--write`, immediately after, nothing on disk touched):

```
contact drift-hulk rail 0 dt*16: 1172 evals, best 0.000 km
contact drift-hulk rail 0 dt*4: 1288 evals, best 0.000 km
contact drift-hulk rail 0 dt*1: 1408 evals, best 0.000 km
contact drift-hulk rail 0 polish: 1485 evals, best 0.000 km
levels: L01-intercept solved (not written -- pass --write)
```

Identical eval counts and identical "best" at every stage. To confirm byte-identity rather than
just matching progress lines: the committed solution and evidence were copied aside, `--write` was
run a third time, and `diff` against the copies reported no difference (`SOLUTION IDENTICAL`,
`EVIDENCE IDENTICAL`) -- the committed files are exactly what the solver writes, never hand-edited,
per ADR-0006 §5 and this unit's acceptance line.

Committed `levels/L01-intercept.solution.json`:

```json
{
  "level": "L01-intercept",
  "log": [
    {
      "heading": 973673621,
      "kind": "launch",
      "rail": 0,
      "speed": 120000000,
      "tick": 2464
    }
  ],
  "simVersion": 3,
  "ticks": 3303
}
```

Launch at tick 2464 (20.53 h into the rail's own solve window), muzzle speed exactly 120 km/s (the
rail's own floor -- the geometry at this launch phase wants the slowest speed the band allows, not
a coincidence of a narrow band). Committed `levels/L01-intercept.evidence.json`:

```json
{
  "contacts": [
    {
      "cleared": true,
      "closingSpeed": 120098.8659332821,
      "id": "drift-hulk",
      "impactEnergy": 7933055679153.257,
      "impactTick": 3298,
      "minimumImpactEnergy": 5000000000000,
      "timeOfFlightSeconds": 25020
    }
  ],
  "dtConvergence": [
    {
      "clearedAtDt": true,
      "clearedAtHalfDt": true,
      "closingSpeedAtDt": 120098.8659332821,
      "closingSpeedAtHalfDt": 120098.8659332821,
      "id": "drift-hulk",
      "impactTimeDifferenceSeconds": 0,
      "impactTimeSecondsAtDt": 98940,
      "impactTimeSecondsAtHalfDt": 98940
    }
  ],
  "finalStateHash": "0220ac8ab37933b0",
  "level": "L01-intercept",
  "levelHash": "sha256:871469a8225489d166411b0c4c03d5cac033970c2923f82150c2c18e3122d406",
  "outcome": {
    "contactsCleared": 1,
    "contactsTotal": 1,
    "probesGranted": 2,
    "probesLaunched": 1,
    "propellantRemaining": [680]
  },
  "simVersion": 3,
  "solutionHash": "sha256:bcce4f0349607e6f7e350cd192bcf478a271265c3d93cc551dc5b5163c15a98d"
}
```

Time of flight 25 020 s (6.95 h -- "a flight of a few hours"), impact energy 7.93 TJ against a
5 TJ minimum (59% margin), and the `dt/2` replay agrees exactly: 98 940 s at both `dt` and `dt/2`,
0 s difference -- this launch sits well inside `captureRadius` (35 km), not grazing its edge, which
the gravity-negligible measurement below confirms directly (7.6 km).

## Gravity-negligible evidence

`runs/gravity-negligible.ts` (throwaway, gitignored, not committed): replays the committed
solution's exact log once against `level.scenario` as compiled, and once against every body's
`mu` scaled by 1e-6, and reports, for each run, the closest approach to `drift-hulk` and the
deflection angle of the probe's velocity (launch vs. final, in Corvai's primary-centred frame)
over the whole 3303-tick flight. Since a contact's position is its host's analytic ephemeris
(`contacts.ts`'s `contactPoint`) evaluated at a tick -- never a function of any `mu` -- Yarune (and
`drift-hulk` riding it) sits in exactly the same place at exactly the same tick in both runs; only
the probe's own path changes.

```
=== full mu ===
cleared: true
closest approach to drift-hulk: 7.605 km (captured at tick 3298, dense scan within that tick's own dt, probe frozen at impact)
launch speed: 124095.283 m/s, final speed: 124118.391 m/s
deflection (launch v vs. final v, primary frame, over the whole 3303-tick flight): 0.007581 deg

=== mu scaled by 1e-6 ===
cleared: false
closest approach to drift-hulk: 12068.210 km (never captured -- swept-segment minimum over the whole flight)
launch speed: 119969.984 m/s, final speed: 119969.984 m/s
deflection (launch v vs. final v, primary frame, over the whole 3303-tick flight): 0.000001 deg
```

0.0076 deg over the whole flight is the number the acceptance line asks for -- "well under a
degree" by two orders of magnitude, confirming this beat is what GAME-0001 §6 calls it (fixed
contact, gravity negligible), not a disguised gravity-assist puzzle.

A closest-approach reading needed one piece of care to report honestly. An impacting object
freezes -- position and velocity both stop changing the instant `dynamics/step.ts`'s substep
impact test marks it hit (confirmed directly: `objects.x`/`y`/`vx`/`vy` at tick 3299 through 3303
are bit-identical in a direct trace). Sampling distance only at tick boundaries *after* that freeze
therefore measures the frozen probe against a contact that has kept moving for the rest of that
tick and beyond (Yarune's combined orbital + rotational speed here is ~4.1 km/s, so ~120 km per
30 s tick) -- not a physics effect, an artefact of tick-boundary sampling once one side of the pair
has stopped. The fix used above: the frozen probe position is exact and constant, and the
contact's own position is a closed-form function of continuous time (`evaluateEphemeris` accepts
any `t`, not just tick multiples), so the true minimum within the one tick the impact happened in
is a dense scan (100 000 samples) against that single fixed point, no re-simulation involved. The
"never captured" run has no such freeze, so its closest approach is the ordinary swept-segment
minimum (`sweptSegmentDistance`, the same geometry `solve.ts` and `step.ts` both use) over
consecutive tick-boundary positions across the whole flight.

**Why turning gravity down by six orders of magnitude turns a 7.6 km hit into a 12 068 km miss,
despite only 0.0076 deg of total deflection.** This is not a contradiction, and it is not new: it
is the same extreme heading sensitivity ADR-0006 §"Context" already measured directly (a 1e-7 rad
heading change moves an eleven-day miss by 28 km) and the reason nobody hand-authors a solution at
all. The solver's chosen heading is aimed at exactly compensating the real trajectory's tiny
curvature; removing that curvature does not scale the miss down by the same tiny factor, because
the lateral drift of an uncorrected straight line from the true (barely) curved path grows with
flight distance, not with the deflection angle alone. As independent confirmation this is smooth,
expected sensitivity and not a bug: scanning intermediate `mu` factors (1, 0.999, 0.99, 0.9, 0.5,
0.1, 0.01, 1e-4, 1e-6) shows the miss growing monotonically from 0 (cleared) through 886 km
(factor 0.99) to the ~12 000 km asymptote as `mu` to 0, never a jump or a discontinuity.

## Brief and debrief

> Meskel Rail has a single contact in range: a derelict hulk settled on Yarune, a few hours out at
> cruise speed. Nothing else is moving nearby -- plan the launch, commit it, and clear the hulk
> before the window closes.

> The hulk never moved. Everything in the plan was aimed at where Yarune's spin would carry it by
> the time the probe arrived, not at where it sat when you looked. A launch vector is a promise
> about where the contact will be, not where it is.

One paragraph each, no characters, no dialogue: the brief states the job (one rail, one contact,
a time window), the debrief names the one idea GAME-0001 §2's whole design rests on -- a launch
vector aims at a future position, not a present one.

## `levels-verify.ts`: campaign levels without a solution now fail

Test-first in `scripts/levels-verify.test.ts`: the existing "a level without a solution is
reported, not failed" test used a bare id (`solo`); it was renamed to a `T`-prefixed id
(`T00-solo`) to keep it testing fixture behaviour specifically, and a new test asserts an
`L`-prefixed id with no solution now fails with `levels: L01-solo FAILED: no solution` and writes
no evidence file. Both failed against the pre-change `scripts/levels-verify.ts` (the new test with
a wrong `ok`/message, confirmed before implementing); `scripts/levels-verify.ts` then gained one
`id.startsWith('L')` branch. All 8 tests in the file pass after.

```
$ pnpm levels:verify
$ node scripts/levels-verify.ts
levels: L01-intercept ok
levels: T00-compiler-fixture ok
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

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0019

 Test Files  34 passed (34)
      Tests  425 passed (425)
   Start at  08:27:19
   Duration  14.16s (transform 1.04s, setup 0ms, import 2.78s, tests 27.94s, environment 3ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
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
dist/assets/index-CLM-g1AY.js  25.60 kB │ gzip: 9.34 kB │ map: 138.24 kB

✓ built in 40ms
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
159523.9 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
19928.6 ticks/s
```

Both goldens replay to their recorded hash unchanged -- `git diff` against `src/sim/` and
`src/levels/` is empty for the whole unit (checked, not merely followed; this unit's rules forbid
changes there and required messaging the team lead and waiting if one turned out to be needed --
it wasn't).

## `pnpm e2e` tail

```
Running 34 tests using 4 workers
  ... (console-gate, parity, screenshot specs, chromium + firefox)
  2 skipped
  32 passed (5.6s)
```

2 skipped are the pre-existing Firefox screenshot tests, unrelated to this unit (same as noted in
GRV-0015's, GRV-0017's and GRV-0018's own evidence).

## Deviations from the brief, and why

- **`probes[0].count: 2`, not 1.** The unit brief left this as "your call, say why." A second
  probe is a forgiveness margin for the player's very first level (a bad heading drag on a first
  attempt is a likelier failure mode than a bad plan), and costs nothing in the teaching point: the
  committed solution launches exactly one.
- **`nodeBudget: 0`, not a small positive number.** This beat is deliberately the "no mid-course
  correction" case that beats 5 and 6 build past; granting burn-node budget here would be unused
  machinery for a mechanic two beats away.

## Problems outside this unit (for the team lead to file)

- None found.
