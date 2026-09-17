# GRV-0005 evidence — Kepler solver and analytic ephemeris

2026-09-17, branch `GRV-0005-ephemeris`. Node v24.14.0 (the version actually
installed here).

## Port derivation

`src/sim/ephemeris/kepler.ts`'s `solveKepler` is a line-for-line port of
`solveKepler` in
`docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs`: Danby
starter, three Danby-Burkardt quartic corrections sharing one `dsincos` call
each, final `sinE`/`cosE` by first-order rotation of the last pair. `kepE`,
`kepSin`, `kepCos` keep the reference's exported-mutable-register shape
(matching `dsincos`'s own `dsinOut`/`dcosOut` and `src/sim/state`'s
mutate-in-place convention) rather than returning a tuple or object.

`src/sim/ephemeris/bodies.ts`'s per-body formulas (`meanMotion = sqrt(mu_parent/a^3)`,
`semiMinorAxis = a*sqrt(1-e^2)`, `g = sqrt(mu_parent*a)`, the perifocal
position/velocity, the periapsis-argument rotation, the parent-chain
composition `x[i] = x[parent[i]] + rotate(...)`) are an unchanged port of
research §1.3-1.4 and `q5_perf2.mjs`'s `ephemeris()`. `bodies.ts` itself is
new: the reference's system is a flat, hardcoded 6-body array with module-level
mutable arrays and no validation; this unit generalises that into a reusable
`createBodyTable(defs)` / `evaluateEphemeris(table, t, out)` pair per the work
item's acceptance criteria, with the same dense-array, index-order-is-
evaluation-order layout and the same one-pass parent-chain composition.

**Deviations from the reference:**

- **Validation** (`e > 0.8`, `e < 0`, `parent[i] >= i`, non-positive `a`/`mu`)
  has no counterpart in `q5_perf2.mjs`, which hardcodes an already-valid
  system. New in the port, required by this unit's acceptance criteria.
- **No direction (prograde/retrograde) field.** Checked every probe
  (`q1_core.mjs`, `q5_perf2.mjs`, `p3b_reduction_and_kepler.py`) and the
  research doc's burn-direction sections (§2.5, §3.6): the reference has no
  such field anywhere, and all mean motions are positive (prograde only).
  Omitted rather than speculatively added (YAGNI).
- **A discriminated-union `BodyDef`** (`PrimaryBodyDef` with `parent: -1` and
  no orbital elements vs. `OrbitingBodyDef` with `parent: number` and the
  full element set) rather than one object with optional fields, so a moon
  literally cannot be constructed without `a`/`e`/etc., and the primary
  cannot carry meaningless orbital fields. TypeScript can't narrow this union
  on `parent === -1` (`OrbitingBodyDef.parent` is typed `number`, not a
  literal, so it isn't a usable discriminant), so `createBodyTable` narrows on
  `'a' in def` instead and validates the `parent` value separately.

## Lint config gap found

The `src/sim` import guard refused `../math/kernels.ts` although it stays inside the core.
Fixed on the epic branch before this unit merged; see
`docs/issues/2026-09-17-sim-lint-bans-imports-between-core-subdirectories.md`.

## Measured residuals

All measured by running the actual test suite (`kepler.test.ts`,
`bodies.test.ts`), not estimated.

| Check | Measured | Asserted bound |
|---|---|---|
| Kepler residual `\|E - e sinE - M\|`, e in [0, 0.8] x 4096 M's | `8.881784197001252e-16` | `<= 1e-15` |
| Kepler E/sinE/cosE, M=1 e=0.6 | exact bit match | exact |
| Circular orbit radius, relative spread over one period | `4.08e-16` | `< 1e-9` |
| Circular orbit speed vs. `sqrt(mu/a)` | `1.22e-16` | `< 1e-9` |
| Circular orbit position after one period vs. start | `0` | `< 1e-9` |
| Eccentric (e=0.5) periapsis/apoapsis vs. `a(1-+e)` | `0` | `< 1e-9` |
| Eccentric vis-viva speed, 6 anomalies | `3.05e-16` | `< 1e-9` |
| Eccentric specific angular momentum, 6 anomalies | `2.59e-16` | `< 1e-9` |
| Eccentric velocity vs. centred finite difference (dt=1s) | `4.42e-10`, `3.23e-10` | `< 1e-8` |
| Moon: 3-level chain vs. independent 2-body computation | `3.83e-15`..`5.64e-15` | `< 1e-11` |
| Large t (10 years) vs. time-reduced equivalent | `1.78e-11` | `< 1e-9` |

The Kepler residual bound is the unit's own literal acceptance figure
(`<= 1e-15`) and held with no fudging needed: research §1.2's `8.9e-16` at
e=0.8 was measured at only 6 discrete e values, this sweeps e in [0, 0.8] by
0.1 over the same 4096-M grid as `q2_selftest.mjs`'s Q2b and lands on the
same figure. The finite-difference and large-t bounds carry a larger, honest
margin above measurement (roughly 20x-50x) because both mix in an
independent source of numerical noise (truncation error, `%`'s own
rounding) that isn't part of what's being tested; the other bounds sit within
~2-3 orders of magnitude of the double-precision floor and are tight.

## Test-detects-real-failures check

Before recording the above as green: the M=1,e=0.6 cross-check was mutated
(last hex digit of `kepE`'s expected value, `...f19` -> `...f10`) and
confirmed to fail with the exact mismatch reported; the residual bound was
tightened to `1e-30` and confirmed to fail reporting the real measured
`8.881784197001252e-16`. Both reverted before this run.

## `pnpm check` (tail)

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0005-ephemeris


 Test Files  10 passed (10)
      Tests  59 passed (59)
   Start at  19:53:20
   Duration  2.71s (transform 390ms, setup 0ms, import 745ms, tests 3.49s, environment 1ms)
```

`pnpm docs:validate` -> `docs: ok`.
