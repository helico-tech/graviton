---
id: GRV-0010
epic: EPIC-02
status: todo
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
