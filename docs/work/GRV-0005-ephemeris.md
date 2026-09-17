---
id: GRV-0005
epic: EPIC-02
status: todo
---
# GRV-0005 Kepler solver and analytic ephemeris

**Goal.** Tier one of the two-tier model: O(1) position and velocity of every
celestial body at any tick (ADR-0005 "Kepler solver", research §1).

**Files.** `src/sim/ephemeris/kepler.ts`, `src/sim/ephemeris/bodies.ts`, tests.

**Acceptance.**
- Danby starter plus exactly three Danby–Burkardt corrections, no tolerance branch; final
  `sin E, cos E` by first-order rotation (three `dsincos` calls).
- Residual `|E - e sin E - M| <= 1e-15` for `e` in [0, 0.8] over 4096 mean anomalies.
- Mean anomaly reduced to `[0, 2pi)` before any trig.
- Body table validation throws on `e > 0.8` and on `parent[i] >= i`; parent chains resolve
  in one pass to primary-centred state vectors.
- A circular and an eccentric orbit match closed-form position, velocity and period;
  a moon's state is its parent's plus its own.

**Verification.** `pnpm check`.
