---
status: resolved
priority: P1
filed: 2026-09-17
filed-by: agent
work: GRV-0013
---
# Launch heading quantum of 1/65536 turn is 27 000 km of miss

## Observation

Found while writing ADR-0006. `commands.ts` quantises launch heading to 1/65536 turn
(9.6e-5 rad, ADR-0005). Research 03 §B.3 measured 2.8e11 m of miss per radian (its prose says 2.8e8; its table is right) over a 10.9-day
flight, so one quantum is about 27 000 km against capture radii of tens of kilometres: no level
with a free-flight leg is solvable. ADR-0006 moves heading to 1/2^32 turn. P1 because every
level depends on it.

## Resolution

**Resolved 2026-09-17** in GRV-0013, commit ac64c47. HEADING_TURN moved from 65536 to 2^32 (src/sim/commands.ts); the angle formula is unchanged, so a heading that is a multiple of the old quantum still gives the bit-identical direction. Measured on a plain two-body coast: adjacent new-unit headings miss by 278 m, one old quantum apart misses by 18 196 km. See docs/evidence/GRV-0013/README.md.
