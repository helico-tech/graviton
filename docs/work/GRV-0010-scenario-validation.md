---
id: GRV-0010
epic: EPIC-02
status: done
---
# GRV-0010 Validate the scenario at load

Post-epic review finding, `docs/issues/2026-09-17-scenario-probe-and-body-radius-unvalidated.md`.

**Goal.** A malformed scenario fails loudly in `createSim`, never silently mid-run.

**Files.** `src/sim/sim.ts`, `src/sim/ephemeris/bodies.ts`, tests.

**Acceptance.**
- `createSim` and `deserializeSim` throw on: `dt <= 0` or non-finite; non-integer or
  non-positive `capacity` / negative `burnNodeCapacity`; probe `dryMass <= 0`,
  `propellantMass < 0`, `thrust <= 0`, `exhaustVelocity <= 0`; any non-finite number.
- `createBodyTable` throws on `radius <= 0` and on non-finite elements.
- The golden hash does not move.

**Verification.** `pnpm check`, `pnpm headless tests/golden/flyby-burn.json`.

**Delivered.** `validateScenario` in `src/sim/sim.ts`, called from both `createSim` and
`deserializeSim`, covers every scenario-level and probe field in the acceptance list;
`createBodyTable` in `src/sim/ephemeris/bodies.ts` now rejects `radius <= 0` and non-finite
elements. Test-first, table-driven (`test.each`). `pnpm check`, `pnpm docs:validate`, `pnpm build`
all green; golden hash unchanged (`e18434ee2785b566`, MATCH). Evidence:
`docs/evidence/GRV-0010/README.md`.
