---
id: GRV-0020
epic: EPIC-04
status: todo
---
# GRV-0020 Bounds on level data

Post-epic review findings: `2026-09-18-reload-ticks-wrap-int32.md`, `2026-09-18-probe-count-unbounded.md`,
`2026-09-18-unbounded-angles-reach-trig-kernel.md`, `2026-09-18-rails-dead-export-and-stale-comment.md`.

**Goal.** Every number a level can state is bounded where it is stated and checked again where
the simulation stores it, so nothing wraps, allocates without limit or reaches a kernel out of
range.

**Files.** `src/levels/schema.ts`, `src/levels/compile.ts`, `src/sim/rails.ts`,
`src/sim/ephemeris/bodies.ts`, `src/sim/contacts.ts`, `src/sim/sim.ts`, tests.

**Acceptance.**
- `reloadTicks` must fit an Int32 (`createRailTable` throws; the compiler reports an issue).
- `probes[].count` <= 64 and `nodeBudget` <= 16 in the schema; `createSim` throws on `capacity`
  or `burnNodeCapacity` above 4096 (a level-load sanity limit, stated once).
- Source angles (`axialPhaseAtEpoch`, `longitude`, `argPeriapsis`, `meanAnomalyAtEpoch`) are
  normalised to `[0, 2pi)` by the compiler; `createBodyTable`, `createRailTable` and
  `createContactTable` throw on angles outside `[-2pi, 2pi]`. Existing compiled levels, goldens
  and hashes do not change.
- The dead export and the duplicated phrase are gone.

**Verification.** `pnpm check`, `pnpm e2e`, both goldens MATCH, `levels:build --check` reports nothing stale.
