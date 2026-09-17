---
id: EPIC-02
status: in-progress
---
# EPIC-02 Simulation core

The headless deterministic core in `src/sim/` (ADR-0002, ADR-0005,
`docs/domain/simulation-determinism.md`): own transcendentals, hashing and
named random streams, the analytic ephemeris, PEFRL with the per-object
substep ladder, finite burns, and the tick loop driven by a quantised command
log. Done when a probe can be launched and flown through a flyby headless,
and the contract's determinism tests (warp invariance, ghost isolation,
serialisation round-trip, substep determinism, golden replay) are green in CI.

Signal delay, exposure, contacts, debris, levels, the planner and everything
rendered are later epics.

Reference implementations from the numerics research are ported, not
re-derived: `docs/research/2026-09-03-02-simulation-numerics.md` §11.

Stories: GRV-0003, GRV-0004, GRV-0005, GRV-0006, GRV-0007.
