# GRV-0010 evidence — validate the scenario at load

2026-09-17, branch `GRV-0010-scenario-validation`. Node v24.14.0.

## What was built

The EPIC-02 review found `createSim` validated nothing in `scenario.probe` or `scenario` itself,
unlike `createBodyTable`, and that `createBodyTable` itself accepted `radius <= 0`
(`docs/issues/2026-09-17-scenario-probe-and-body-radius-unvalidated.md`). Two changes:

1. **`validateScenario` (`src/sim/sim.ts`), called from both `createSim` and `deserializeSim`.**
   Mirrors `createBodyTable`'s validation style (throw with a field-specific message, one check
   per field). Rejects `dt <= 0` or non-finite; non-integer or non-positive `capacity`; non-integer
   or negative `burnNodeCapacity` (zero is a legitimate "no burn nodes" scenario, so only negative
   is rejected there); probe `dryMass <= 0`, `propellantMass < 0`, `thrust <= 0`,
   `exhaustVelocity <= 0`; and non-finite values throughout. Body validation stays inside
   `createBodyTable`, called after `validateScenario` in both `createSim` and `deserializeSim`.
2. **`createBodyTable` (`src/sim/ephemeris/bodies.ts`) now rejects `radius <= 0`** (previously
   only `mu` and, for orbiting bodies, `e`/`a`/`parent` were checked) **and non-finite `mu`,
   `radius`, `a`, `e`, `argPeriapsis`, `meanAnomaly0`** (previously `<= 0`/range checks alone let
   `NaN` slip through silently, since e.g. `NaN <= 0` and `NaN > MAX_ECCENTRICITY` are both
   `false`).

`Number.isFinite`/`Number.isInteger` are plain `Number` statics, not `Math.*` or a restricted
global (`eslint.config.js`'s `no-restricted-globals` for `src/sim/**` lists `Date`, `performance`,
`window`, `document`, `navigator`, `requestAnimationFrame`, `setTimeout`, `setInterval`, `crypto`,
`fetch`, `localStorage`, `Intl` — no `Number`), so no lint exception was needed; `pnpm lint`
confirms.

## Failing tests first

- `src/sim/ephemeris/bodies.test.ts` — two `test.each` tables (orbiting body, primary body) over
  `radius`/`mu`/`a`/`e`/`argPeriapsis`/`meanAnomaly0` set to `0`, a negative value, `NaN`, or
  `Infinity`. Before the fix: every `radius` and non-finite case failed with `expected [Function]
  to throw an error` (12 failures in the orbiting table, 5 in the primary table); after, all pass.
- `src/sim/sim.test.ts`, `describe('scenario validation')` — two `test.each` tables (scenario-level
  fields `dt`/`capacity`/`burnNodeCapacity`; probe fields `dryMass`/`propellantMass`/`thrust`/
  `exhaustVelocity`), each row asserting **both** `createSim` and `deserializeSim` throw, plus a
  dedicated test for the two failure modes demonstrated in the issue (`thrust: 0`,
  `exhaustVelocity: 0`) at `createSim`, plus one test that a valid scenario still passes through
  both entry points untouched. Before the fix: every row failed with `expected [Function] to throw
  an error` (11 scenario-field failures, 11 probe-field failures, 1 demonstrated-failure-mode
  failure = 23); after, all pass, and the existing suite (warp invariance, serialisation
  round-trip, substep determinism, seed, hash sensitivity, pending burn node ordering) still
  passes unchanged.

All new tests were run and observed failing against the pre-fix code before either fix was
applied, then re-run green. No existing fixture needed changing — `tests/golden/flyby-burn.json`
and every scenario literal in the test suite already used positive finite `dt`, a positive integer
`capacity`, a positive `dryMass`/`thrust`/`exhaustVelocity`, a non-negative `propellantMass`, and
positive-radius bodies.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0010


 Test Files  19 passed (19)
      Tests  181 passed (181)
   Start at  21:39:56
   Duration  3.07s (transform 698ms, setup 0ms, import 1.32s, tests 4.00s, environment 2ms)
```

`pnpm docs:validate`: `docs: ok`. `pnpm build`: succeeds (`vite build`, 4 modules, ~30 ms).

## `pnpm headless tests/golden/flyby-burn.json`

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash e18434ee2785b566
MATCH
241162.9 ticks/s
```

Hash unchanged from GRV-0009 (`e18434ee2785b566`): the fixture's `probe`
(`dryMass: 400, propellantMass: 400, exhaustVelocity: 3000, thrust: 500`) and all three bodies
(`radius` 6.957e8/7.1492e7/1.8216e6) were already valid under the new checks, so `validateScenario`
and the extended `createBodyTable` checks pass through without changing any recorded state.
