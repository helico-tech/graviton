---
id: EPIC-06
status: in-progress
---
# EPIC-06 Planner

The game's core promise: a plotted trajectory is what will happen (GAME-0001
§4.4-4.6, §7 must-have 3; determinism contract "Ghost invariant"). A flight
plan (rail, launch tick, heading, speed, burn nodes) is integrated by the
live simulation's own step function into a ghost, the player edits it by
dragging on the plot, the solution readout says what the ghost does, and
committing it appends to the command log. Time control gains the events the
planner creates: automatic drop to one times and warp to event (GAME-0001
§4.11). Done when level 01 can be solved by hand in the page, the ghost
invariant is enforced by test, and a committed plan's replay is bit-identical
to its ghost.

Signal delay, the command and information horizons, uncertainty and reachable
ellipses, conditional clauses and exposure are later epics; the planner here
is the fully-informed version those will constrain.

Stories: GRV-0025, GRV-0026, GRV-0027. The next one is specified in detail.
