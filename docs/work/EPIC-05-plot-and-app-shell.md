---
id: EPIC-05
status: done
---
# EPIC-05 Plot renderer and app shell

The first thing a player sees: a compiled level loaded in the browser, the
system plot drawn to the aesthetic spec (GAME-0002), time control with the
warp ladder, pan and zoom, selection with readouts as DOM text, and the
renderer half of the debug API (ADR-0004: `render`, `frameHash`, `readouts`,
`select`, `view`, `pnpm render`). Done when level 01's committed solution
replays in the page at warp, the hero frame is captured by both `pnpm render`
and `pnpm screenshot`, every displayed number is a `data-readout` sourced from
the simulation, and the console gate is clean.

The renderer reads a read-only view of the state and never writes it
(determinism rule 10, ADR-0002 guard-rail 6). No planner, no ellipses, no
exposure strip, no sound yet; those are later epics.

Stories: GRV-0021, GRV-0022, GRV-0023. The next one is specified in detail;
the rest are refined when picked up.
