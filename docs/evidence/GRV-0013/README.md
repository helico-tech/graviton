# GRV-0013 evidence — launch heading in 1/2^32 turn

2026-09-17, branch `GRV-0013-heading-quantum`. Node v24.14.0, pnpm 11.25.0.

## What was built

Picks up `docs/issues/2026-09-17-heading-quantum-too-coarse-for-intercepts.md` (P1, ADR-0006 §4):
`commands.ts` quantised launch heading to 1/65536 turn, which the research measured as tens of
thousands of kilometres of miss over an eleven-day flight -- no level with a free-flight leg was
solvable. The fix is one constant.

1. **`src/sim/commands.ts`.** `HEADING_TURN` moves from `65536` to `4294967296` (2^32). The angle
   formula itself, `(command.heading * TWO_PI) / HEADING_TURN`, is untouched -- the whole change
   is the constant's value, plus the doc comments on `HEADING_TURN` and `LaunchCommand.heading`
   and the `requireRange` bound (`HEADING_TURN - 1`), which already derived from the constant.
   Rescaling by a power of two is exact, so a heading that is a multiple of the old 65536-unit
   quantum, expressed in the new unit (multiplied by 65536), produces the bit-identical direction
   the old formula gave -- proven directly, not assumed (see below).
2. **Every command-log fixture with a heading value is multiplied by 65536**, preserving what it
   meant under the old unit: `tests/golden/flyby-burn.json` (49152 -> 3221225472),
   `src/sim/sim.test.ts` (32768 -> 2147483648, the escaping probe's launch), `src/app/
   debug-api.test.ts` (16384 -> 1073741824), `src/sim/commands.test.ts`'s quarter-turn test
   (16384 -> 16384*65536).
3. **`src/sim/commands.test.ts`** gains two new `describe` blocks: the bit-identical formula
   check, and a direct measurement of heading sensitivity (both below). The old boundary test
   (`heading out of [0, 65535]`) becomes `heading out of [0, 2^32)`, plus a new test that
   `2^32 - 1` is accepted.

`SIM_VERSION` (`src/sim/version.ts`) is **not** bumped: every existing command log's heading value
is unchanged in meaning (multiplying by 65536 is exact), so no stored result moves. The golden's
own `expectedHash` is unchanged, checked in Node, Chromium and Firefox (below).

## Test-first

- **Bit-identical formula.** `describe('heading quantum', ...)`: for 0, 1, 16384, 32768, 65535 and
  300 pseudo-random old headings (`Math.random`, fine in a test file), computes the direction via
  the old formula (`oldHeading * TWO_PI / 65536`) and via the production formula fed
  `oldHeading * 65536` (a fixed literal, not derived from `HEADING_TURN`, so the test cannot pass
  by construction), and asserts `Object.is` equality on both `dcosOut` and `dsinOut`. Run against
  the pre-fix code (`HEADING_TURN` still `65536`): failed --
  `expected false to be true // Object.is equality` -- because feeding it `oldHeading * 65536`
  divided by the old `65536` computes a completely different (usually out-of-domain) angle. Passed
  once `HEADING_TURN` became `4294967296`.
- **Range validation.** `heading: 4294967296` and `heading: -1` now throw; `heading: 4294967295`
  (2^32 - 1) does not. Run against the pre-fix code: `4294967295` threw
  (`heading must be in [0, 65535], got 4294967295`); `4294967296` and `-1` already threw (for the
  wrong reason -- the old upper bound). Passed once the range extended to `2^32`.
- **Sensitivity.** `describe('heading sensitivity over an eleven-day coast', ...)`: one primary
  (Earth-like `mu`/`radius`, matching the file's other scenarios), a single probe launched at
  200 km/s (200 000 000 mm/s), coasting 15 840 ticks (11 days at `dt = 60`) with no burns. Three
  launches from an arbitrary base heading (1 000 000 000, clear of both range edges): the base
  heading, the base plus 1 (adjacent new-unit heading) and the base plus 65536 (one old-unit
  quantum, in new units). Run against the pre-fix code: every heading above 65535 threw
  (`heading must be in [0, 65535], got 1000000000`). Passed once the range extended, with the
  measured misses below.
- **Fixture updates** (`flyby-burn.json`, `sim.test.ts`, `debug-api.test.ts`, the quarter-turn
  test in `commands.test.ts`): each un-rescaled heading is now out of the old-code's `[0, 65535]`
  range once multiplied by 65536, so every one of these failed against the pre-fix code with the
  same `heading must be in [0, 65535]` error before the constant changed.

## Measured sensitivity

From the sensitivity test above, run standalone to record exact values:

```
base position: x=20434413784.682713 y=188685696249.55292 (m)
adjacent new-unit heading (base + 1):        miss =       277.6 m
one old quantum away (base + 65536):         miss = 18195790.6 m  (18 195.8 km)
```

Under 1 km for an adjacent new-unit heading; thousands of kilometres for one old quantum, exactly
as ADR-0006 §4 and `docs/work/GRV-0013-heading-quantum.md`'s acceptance require. (This scenario is
a plain two-body coast, not the flyby ADR-0006 quotes 0.4 km / 27 000 km for -- a flyby amplifies
sensitivity near periapsis -- but the two-orders-of-magnitude relationship the unit asks for holds
either way, and 18 195.8 km / 277.6 m ≈ 65 545, matching the 65536x unit ratio almost exactly,
since this coast is close enough to a straight line that miss scales linearly with heading error.)

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0013


 Test Files  20 passed (20)
      Tests  190 passed (190)
   Start at  22:10:41
   Duration  2.61s (transform 636ms, setup 0ms, import 1.21s, tests 4.15s, environment 1ms)
```

`pnpm docs:validate`: `docs: ok`. `pnpm build`: succeeds (`vite build`, 18 modules, ~50 ms).

## `pnpm e2e` tail (Chromium + Firefox)

```
$ pnpm build && playwright test
...
Running 6 tests using 4 workers

  ✓  3 [chromium] › tests/e2e/parity.spec.ts:100:1 › window.graviton is not installed without ?debug=1 (126ms)
  ✓  2 [chromium] › tests/e2e/parity.spec.ts:54:1 › run() replays the golden log and matches the Node hash (216ms)
  ✓  1 [chromium] › tests/e2e/parity.spec.ts:74:1 › load/command/step in uneven batches replays the same golden log to the same hash (257ms)
  ✓  4 [firefox] › tests/e2e/parity.spec.ts:54:1 › run() replays the golden log and matches the Node hash (1.1s)
  ✓  5 [firefox] › tests/e2e/parity.spec.ts:74:1 › load/command/step in uneven batches replays the same golden log to the same hash (1.1s)
  ✓  6 [firefox] › tests/e2e/parity.spec.ts:100:1 › window.graviton is not installed without ?debug=1 (879ms)

  6 passed (4.0s)
```

Both browsers' `run()` test asserts the hash equals `flyby-burn.json`'s `expectedHash`, which is
`e18434ee2785b566` -- so the rescaled heading (`heading: 3221225472`) replays to the same hash the
old `heading: 49152` did, in Chromium and Firefox as well as Node.

## `pnpm headless tests/golden/flyby-burn.json`

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash e18434ee2785b566
MATCH
241853.7 ticks/s
```

Hash unchanged from GRV-0011 (`e18434ee2785b566`), as expected: rescaling a heading that is a
multiple of the old quantum by 65536 is exact, and every other field in the golden is untouched.
