# GRV-0020 evidence — bounds on level data

2026-09-18, branch `GRV-0020-level-bounds`. Node v24.14.0, pnpm 11.25.0.

## What was built

Four post-epic review findings closed, each one bounding a number the level compiler or the
simulation's own load-time validation had left open:
`docs/issues/2026-09-18-reload-ticks-wrap-int32.md`,
`docs/issues/2026-09-18-probe-count-unbounded.md`,
`docs/issues/2026-09-18-unbounded-angles-reach-trig-kernel.md`,
`docs/issues/2026-09-18-rails-dead-export-and-stale-comment.md`. Test-first throughout: every new
assertion below was observed failing against the pre-change code, then made to pass.

1. `reloadTicks` now has an Int32 upper bound in `createRailTable` (`src/sim/rails.ts`), and the
   compiler (`src/levels/compile.ts`) checks it too, at the `reloadTime` field's own position,
   rather than falling through to the whole-document `createSim` fallback.
2. `probes[].count` <= 64 and `nodeBudget` <= 16 in the schema (`src/levels/schema.ts`,
   `v.maxValue` with a message); `validateScenario` (`src/sim/sim.ts`) rejects `capacity` or
   `burnNodeCapacity` above 4096, one named constant (`MAX_SCENARIO_ALLOCATION`) stated once with
   its own one-line why.
3. The compiler normalises the four source angles (`axialPhaseAtEpoch`, `longitude`,
   `argPeriapsis`, `meanAnomalyAtEpoch`) to `[0, 2pi)` with one function
   (`normalizeAngle` in `compile.ts`), written once and used at every construction site;
   `createBodyTable`, `createRailTable` and `createContactTable` independently bound the same
   angles to `[-2pi, 2pi]` at load, so a scenario built directly (not through the compiler) gets
   the same protection.
4. The dead `RailGeometry` export is gone from `src/sim/rails.ts` (`railGeometry` now returns
   `SurfacePoint` directly — nothing imported the type name, only the function); the duplicated
   "rail last-launch ticks, rail last-launch ticks" phrase in `sim.ts`'s `hashSim` doc comment is
   fixed to say it once.

## The three reproduced diagnostics

Each is the pre-existing issue's own demonstrated input, run through `compileLevel` after the fix
(script below, not committed — a scratch repro against the fixture YAML used by
`src/levels/compile.test.ts`).

**1. `reloadTime: 100000000000 h`** (the exact value `docs/issues/2026-09-18-reload-ticks-wrap-
int32.md` demonstrated compiling silently to `-138625024` in an `Int32Array`) — now a positioned
compiler error, not a silent wrap:

```json
[
  {
    "severity": "error",
    "message": "reloadTime (360000000000000 s) is 12000000000000 ticks at dt=30 s, which exceeds the Int32 limit (2147483647)",
    "path": "rails[0].reloadTime",
    "line": 37,
    "column": 17
  }
]
```

**2. `probes[0].count: 1000000000`** (the exact value `docs/issues/2026-09-18-probe-count-
unbounded.md` demonstrated allocating 8 GB) — now a schema issue, caught before it reaches
`createSim`:

```json
[
  {
    "severity": "error",
    "message": "count must be <= 64",
    "path": "probes[0].count",
    "line": 41,
    "column": 12
  }
]
```

**3. `axialPhaseAtEpoch: 100000000 deg`** (the exact value `docs/issues/2026-09-18-unbounded-
angles-reach-trig-kernel.md` demonstrated throwing the trig kernel's `|x| <= 2^18` RangeError on
`advance()`'s first tick) — this one is not an issue any more: the compiler normalises it in place,
so the level compiles and `createSim` accepts it cleanly:

```
compiled successfully.
bodies[0].axialPhaseAtEpoch = 4.886921905679628
createSim: ok, bodies.axialPhaseAtEpoch[0] = 4.886921905679628
```

(`4.886921905679628` is `100000000 deg` reduced into `[0, 2pi)` — `100000000 * pi/180 mod 2*pi`.)

## Angle normalisation: existing artefacts unchanged

`normalizeAngle`'s bit-identity for in-range values is a compiler test
(`src/levels/compile.test.ts`, `Object.is` at 0, 0.1, pi, `2pi - 1e-9`, and the largest double below
`2pi`). Proved at the repo level, not just per-function:

```
$ pnpm levels:build
levels: ok
$ git diff --stat levels/
 levels/schema/level.schema.json | 2 ++
 1 file changed, 2 insertions(+)
```

Only the editor JSON Schema changed (two new `maximum` constraints, from item 2's schema bounds —
expected, since the schema itself changed). No `.level.json` compiled golden moved.

```
$ pnpm levels:build --check
levels: ok
$ pnpm levels:verify --check
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

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0020

 Test Files  34 passed (34)
      Tests  461 passed (461)
   Start at  08:57:54
   Duration  14.41s (transform 1.13s, setup 0ms, import 2.69s, tests 26.36s, environment 3ms)

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
dist/assets/index-kQe39QRB.js  25.94 kB │ gzip: 9.43 kB │ map: 139.69 kB

✓ built in 40ms
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
213081.5 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
24546.2 ticks/s
```

Both goldens replay to their recorded hash unchanged — the new bounds sit strictly outside what
these committed scenarios ever used, and the angle normalisation is a no-op for their (already
in-range) angles.

## `pnpm e2e` tail

```
Running 34 tests using 4 workers
  ... (console-gate, parity, screenshot specs, chromium + firefox)
  2 skipped
  32 passed (5.7s)
```

2 skipped are the pre-existing Firefox screenshot tests, unrelated to this unit (same as noted in
GRV-0015's, GRV-0017's, GRV-0018's and GRV-0019's own evidence).

## Problems outside this unit (for the team lead to file)

- None found.
