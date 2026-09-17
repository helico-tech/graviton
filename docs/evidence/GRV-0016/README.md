# GRV-0016 evidence — level compiler

2026-09-17, branch `GRV-0016-level-compiler`. Node v24.14.0, pnpm 11.25.0.

## What was built

ADR-0006 §1-3, §6: levels are authored as `levels/<id>.level.yaml` and compiled at build time to
the canonical JSON the game, the headless runner and every hash read (`src/levels/{units,schema,
compile}.ts`, `scripts/levels-build.ts`). No YAML parser and no valibot ship in the app bundle.

1. **`src/levels/units.ts`.** Dimension-scoped unit suffixes (length, mass, duration, speed,
   force, angle, energy) per research A.5: `m` is metres in a length and minutes in a duration,
   because the table is looked up by the caller's declared dimension, never globally. A bare
   number is already SI. `parseQuantity` tokenizes a string into `<number><unit>` pairs (handling
   both "71492 km" -- one quantity, a space between number and unit -- and "9h 55m" -- two
   quantities, no space before each unit) and sums them, so compound durations ("1d 2h 3m 4s")
   fall out of the same code path as a single quantity. Never throws: an unreadable string or a
   wrong-dimension unit is a `{ ok: false, message }` result.
2. **`src/levels/schema.ts`.** The valibot source schema (ADR-0006 §2-3): only what the simulation
   implements today (bodies with spin, rails, one probe type, fixed contacts, streams, `dt`).
   `strictObject` throughout, so an unknown key anywhere is an error. Each unit-suffixed field is
   `pipe(union([number, string]), rawTransform(...))`, converting to SI during validation via
   `units.ts`; positivity/range checks (eccentricity `<= 0.8`, `headingCone` in `(0, 180 deg]`,
   etc.) are additional pipe steps so they get the same line/column mapping as everything else.
   One deliberate gap: `muzzleSpeed.max >= min` is *not* checked here -- it is exactly the kind of
   thing `createSim` already rejects, and is left to `compileLevel`'s `createSim` fallback (see
   below), both to avoid duplicating the simulation's own rule and to exercise that fallback.
   `generateLevelJsonSchema()` wraps `@valibot/to-json-schema` (`errorMode: 'ignore'`, draft-07);
   unit fields degrade to `anyOf: [number, string]`, which is the right editor hint.
3. **`src/levels/compile.ts`.** `compileLevel({ source, path })` parses with `yaml`'s
   `parseDocument`/`LineCounter` (YAML 1.2 core schema, unique keys), runs the schema, then the
   checks a schema alone cannot express: bodies parent-first (with two distinct messages --
   "unknown body id" for a reference that doesn't exist at all, "bodies must be parent-first" for
   one that exists but appears later), duplicate ids (bodies/rails/probes/contacts each their own
   namespace), `id` matching the filename stem, `reloadTime` a whole number of ticks (a small
   relative tolerance absorbs the sub-ULP rounding a unit conversion can introduce), and exactly
   one probe entry. If every check passes, it builds a `Scenario` (ids resolved to indices, `mu =
   G * mass` with `G` stated once, angles to radians by plain `deg * pi/180` arithmetic -- no
   trig), strips the not-yet-existing `contacts` field and calls the simulation's own `createSim`
   in a try/catch as the final, authoritative check ("everything `createBodyTable`/
   `createRailTable`/`validateScenario` would reject"). Every valibot issue and every semantic
   check's own path is mapped back to a YAML line/column via `doc.getIn(path, true).range`, with a
   fallback to the nearest ancestor node and finally the document root. `canonicalJson(value)`
   sorts object keys recursively (via a replacer-free `sortKeysDeep` pass handed to
   `JSON.stringify(..., null, 2)`, which already gives shortest-round-trip number formatting and
   array-order preservation for free) plus a trailing newline.
4. **`scripts/levels-build.ts`.** `buildLevels({ levelsDir, check })` compiles every
   `levels/*.level.yaml`, writes `<id>.level.json` beside it and regenerates
   `levels/schema/level.schema.json`; `--check` writes nothing and fails if any output is stale,
   missing, or any level has issues (warnings do not fail `--check`). `pnpm levels:build [--check]`;
   `--check` is appended to `pnpm check`.
5. **Fixture** `levels/T00-compiler-fixture.level.yaml` (a star, a planet, a moon; one rail; one
   probe type; one fixed contact) exercises every unit dimension, including a compound duration
   (`25h 33m`). Its compiled JSON is committed. `src/levels/fixture.test.ts` loads that JSON,
   strips `contacts`, and runs `createSim` plus 300 ticks to prove the artefact is loadable by the
   real simulation, not just valid JSON.
6. **`src/levels/bundle-isolation.test.ts`** statically walks `src/app` and `src/sim` for an
   import of `yaml`, `valibot`, `@valibot/to-json-schema`, or `src/levels/{compile,schema,units}`;
   none exists. The authoritative proof is the `dist/` grep below.

## Public API

```ts
// src/levels/units.ts
type Dimension = 'length' | 'mass' | 'duration' | 'speed' | 'force' | 'angle' | 'energy'
type QuantityResult = { ok: true; value: number } | { ok: false; message: string }
function parseQuantity(raw: string, dimension: Dimension): QuantityResult

// src/levels/schema.ts
const LevelSourceSchema: /* valibot strictObject schema */
type LevelSource = v.InferOutput<typeof LevelSourceSchema>
function generateLevelJsonSchema(): Record<string, unknown>

// src/levels/compile.ts
interface Issue { severity: 'error' | 'warning'; message: string; path: string; line: number; column: number }
interface CompiledContact { host: number; longitude: number; captureRadius: number; minimumImpactEnergy: number }
interface CompiledLevel {
  schema: 1; id: string; name: string; brief: string; debrief: string; seed: number
  names: { bodies: string[]; rails: string[]; contacts: string[] }
  bodyIds: string[]; railIds: string[]; contactIds: string[]; bodyClasses: string[]
  scenario: Scenario & { contacts: CompiledContact[] }
}
type CompileLevelResult = { level: CompiledLevel; warnings: Issue[] } | { issues: Issue[]; warnings: Issue[] }
function compileLevel(args: { source: string; path: string }): CompileLevelResult
function canonicalJson(value: unknown): string

// scripts/levels-build.ts
interface BuildLevelsResult { ok: boolean; messages: string[] }
function buildLevels(args: { levelsDir: string; check: boolean }): BuildLevelsResult
```

## Test-first, by area

- **Units** (`units.test.ts`, 27 tests): every dimension's bare-SI passthrough; one conversion per
  dimension including `au`/`ls`/`lm` and the `180 deg === Math.PI` bit-identical edge; both
  compound-duration cases from research A.5 (`9h 55m` = 35700 s, `1d 2h 3m 4s` = 93784 s); the
  report's own four rejection cases verbatim, including the exact accepted-units message text;
  malformed input (empty string, unit with no number, two bare numbers with no units).
- **Schema** (`schema.test.ts`, 7 tests): a minimal valid source accepts; an unknown key at the
  top level and nested inside a body both reject; a unit string converts to SI; eccentricity above
  0.8 rejects; the generated JSON Schema is draft-07 with a unit field as `anyOf`.
- **Compile** (`compile.test.ts`, 30 tests, table-driven): a full success path with numeric
  spot-checks on the compiled `Scenario` (mu, reloadTicks, capacity, burnNodeCapacity, contacts);
  a bare-SI number and its unit-suffixed equivalent compile identically; **line/column asserted
  for three different issue kinds** -- a schema/unit issue (`bodies[1].radius` at line 21), a
  semantic issue (`id` at line 2), and a YAML syntax issue (a duplicate key at line 4, the
  duplicate occurrence's own line, not the original's) -- plus every named error class (unknown
  key, eccentricity, bad class, duplicate ids, parent-first vs. unknown-id-reference as two
  distinct messages, missing/extra orbit, unknown rail/contact host, non-integer reload ticks,
  zero and two probe entries), an unresolvable YAML alias (caught, not an uncaught throw), an
  explicit `%YAML 1.1` directive (rejected), the `createSim` fallback (muzzle band inverted), both
  warning classes (`headingCone` above/at-exactly 80 deg, muzzle band vs. 40-day reach), and
  `canonicalJson` (key sorting, byte-identical on repeat compiles, the `24.1 d` round-trip case,
  trailing newline).
- **CLI** (`levels-build.test.ts`, 7 tests, temp directory per test, never the real `levels/`): an
  empty directory still writes the schema; a valid level writes JSON and round-trips through
  `--check`; `--check` reports and does not write a missing output; `--check` fails when committed
  JSON no longer matches; a broken level is reported and not written, in both modes; a warning
  does not fail `--check`; the schema file is checked alongside the levels.
- **Fixture loadability** (`fixture.test.ts`, 1 test) and **bundle isolation**
  (`bundle-isolation.test.ts`, 2 tests) as described above.

Every one of these failed before the corresponding implementation existed (`Cannot find module
'./units.ts'` etc. -- confirmed for `units.test.ts` before `units.ts` was written; the same
red-then-green cycle was used for `schema.ts` and `compile.ts`).

## Sample issue output for a deliberately broken level

A level with a wrong-dimension unit (`radius: 600000 h`) and an eccentricity of 0.95:

```
broken.level.yaml:14:13 error unit "h" is not a length unit (accepted: m, km, Mm, Gm, au, ls, lm)
broken.level.yaml:27:10 error eccentricity must be <= 0.8
```

(The file also had `id: wrong-id` not matching its filename and an `orbit.parent: ghost`
reference to a body that doesn't exist -- both semantic checks, which never ran here because
schema validation already failed and `compileLevel` returns schema issues without attempting
semantic checks on data that didn't parse. Fixing the two issues above and rerunning would surface
those next.)

## Bundle check

```
$ vite build
✓ built in 43ms
dist/assets/index-B2W_TS0X.js  21.82 kB │ gzip: 8.27 kB │ map: 114.36 kB

$ grep -i "valibot" dist/assets/*.js; echo "exit: $?"
exit: 1

$ grep -i "yaml" dist/assets/*.js; echo "exit: $?"
exit: 1
```

Exit 1 from `grep` means no match: neither marker appears anywhere in the built bundle.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0016

 Test Files  29 passed (29)
      Tests  344 passed (344)
   Start at  23:09:10
   Duration  3.38s (transform 946ms, setup 0ms, import 2.31s, tests 4.35s, environment 2ms)

$ node scripts/levels-build.ts --check
levels: ok
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
✓ 19 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                 0.74 kB │ gzip: 0.41 kB
dist/assets/index-B2W_TS0X.js  21.82 kB │ gzip: 8.27 kB │ map: 114.36 kB

✓ built in 43ms
```

## `pnpm headless tests/golden/flyby-burn.json`

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash 7bbff52a2e74df1a
MATCH
223358.9 ticks/s
```

Unchanged golden and hash: this unit touches no simulation code.

## `pnpm e2e` tail

```
Running 30 tests using 4 workers
  ✓ 28 passed
  - 2 skipped
  28 passed (5.5s)
```

The 2 skipped are the Firefox screenshot spec's pre-existing project-level skip (unrelated to this
unit -- the same pair skips on `main`).

## Deviations from the design brief, and why

- **`muzzleSpeed.max >= min` has no dedicated schema check.** Every other numeric "would `createSim`
  reject this" condition the brief names explicitly (eccentricity, parent-first, reload ticks,
  filename match, one probe type) has one; this one doesn't, because it isn't named and it is
  exactly what `createRailTable` already rejects. Keeping it out of `schema.ts` avoids a second
  place that has to stay in sync with `rails.ts`'s own rule, and gives the `createSim` fallback a
  real, natural test case instead of only a hypothetical one.
- **The muzzle-band-vs-40-day warning's "worst-case separation" bound** is each body's `a * (1 +
  e)` summed up its parent chain (planar, so no inclination term), for both the rail's host and
  each contact's host, added together. This is deliberately the crudest honest closed form (worst
  case: every orbit in both chains simultaneously at apoapsis, on opposite sides) rather than a
  real transfer calculation -- consistent with the brief's "a crude closed-form bound is fine; say
  what it is," and the warning message states exactly what was computed.
- **Warnings are only computed on a fully successful compile.** `CompileLevelResult`'s type allows
  warnings alongside either `level` or `issues`, but in practice this compiler only returns a
  non-empty `warnings` array together with `level` -- an error run always returns `warnings: []`.
  Computing warnings against a scenario with unresolved ids/errors would be either meaningless or
  need its own error handling with no acceptance criterion asking for it (YAGNI).
- **`docs/issues/2026-09-17-shallow-launch-can-self-collide.md`** is resolved in a second commit:
  the `headingCone > 80 deg` warning above doubles as its fix, per the issue's own suggestion.
