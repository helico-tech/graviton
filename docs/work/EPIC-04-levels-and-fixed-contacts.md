---
id: EPIC-04
status: done
---
# EPIC-04 Levels, rails and fixed contacts

Everything campaign beats 1 to 6 need below the screen (GAME-0001 §6, ADR-0006):
launch rails on spinning hosts, fixed contacts with a real impact test, levels
as compiled data, a replay verifier with generated evidence, the solver, and
the first authored level. Done when `pnpm levels:verify` replays a solver-made
solution of level 01 in CI and its evidence file is committed.

The simulation is planar, so rails and fixed contacts sit at a longitude on
their host's equator; the research schema's `latitude` is not adopted.

Stories: GRV-0013 to GRV-0019. Only the next one or two are specified in
detail; the rest are refined when picked up.
