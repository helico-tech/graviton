---
id: GRV-0016
epic: EPIC-04
status: todo
---
# GRV-0016 Level compiler

**Goal.** Levels are authored as `levels/<id>.level.yaml` and compiled to the canonical JSON the
game, the headless runner and every hash read (ADR-0006 §1-3, §6).

**Files.** `src/levels/{schema,units,compile}.ts`, `scripts/levels-build.ts`,
`levels/schema/level.schema.json`, `levels/T00-compiler-fixture.level.{yaml,json}`, `package.json`, tests.

**Acceptance.**
- `compileLevel({ source, path })` returns the compiled level or issues with line and column.
  Compiled level: `schema`, `id`, `name`, `brief`, `debrief`, `seed`, display names and body
  classes, and a `scenario` the simulation takes as is (ids resolved to indices, SI doubles,
  `mass` to `mu` with one stated `G`, durations to ticks where the simulation wants ticks).
- Only what the simulation implements: bodies with spin, rails, one probe type with `count` and
  `nodeBudget`, fixed contacts, streams, `dt`. Unknown keys are errors, not ignored.
- Units are dimension-scoped suffix strings, compound durations included (`9h 55m`); a unit from
  the wrong dimension is an error naming the accepted units; a bare number is SI.
- Errors: bodies not parent-first, unknown id references, duplicate ids, `id` not matching the
  filename, `reloadTime` not a whole number of ticks, everything `createSim` would reject.
  Warnings (ADR-0006 §6 and the shallow-launch issue): `headingCone` above 80 degrees; a rail's
  muzzle band unable to cross the widest body separation inside 40 days.
- Canonical JSON: sorted keys, shortest round-trip doubles, trailing newline; compiling twice is
  byte-identical. The compiled file is committed beside its source; `pnpm levels:build` writes
  it and `pnpm levels:build --check` fails when any is stale or has issues (run by `pnpm check`).
- The JSON Schema for editors is generated from the valibot schema and committed, with the same
  staleness check.
- No YAML parser and no valibot in the app bundle (checked on the built `dist/`).

**Verification.** `pnpm check`, `pnpm build`, `pnpm levels:build --check`.
