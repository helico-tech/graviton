---
status: triaged
priority: P2
filed: 2026-09-18
filed-by: agent
work: GRV-0030
---
# ghost.ts's lazy burn issuance cannot cross a long occlusion stretch

## Observation

`src/planner/ghost.ts`'s own module doc claims lazy, per-node burn issuance (`issueTickFor(probe,
node.atTick)`, computed once the probe actually exists) is "physically equivalent" to
`planToCommands`'s batched issuance (every command issued at the launch's own tick, "same issue
batch") -- and that this is "proven by the ghost invariant test below" (`ghost.test.ts`'s "the
ghost is bit-identical to the live replay"). That equivalence assumed occlusion between issuing
and a node's own `atTick` was either absent or briefly crossable; the GRV-0030 occlusion fix
(`segmentBlocked`'s catastrophic-cancellation correction) makes a long, real blocked stretch
directly observable for the first time (`tests/golden/flyby-burn.json`'s own moon-in-the-way
window, 2278-4403 ticks at this scenario's dt=60s), and `issueTickFor`'s bounded backward search
(a fixed step count by design, `ISSUE_TICK_FOR_MAX_STEPS`, determinism rule 7) genuinely cannot
cross a blocked stretch that long from a naive `atTick`-anchored estimate -- unlike a caller
willing to search exhaustively for the latest clear tick (which is how the flyby-burn golden's own
committed burn, now issued at tick 2277 rather than the pre-GRV-0030 2997, was actually found: not
through `issueTickFor` alone). Confirmed directly: `ghost.test.ts`'s own "the ghost is bit-
identical to the live replay" test, reusing the golden's own `atTick: 3000` node (deep inside the
blocked window), fails with `burn: rejected (occluded)` under lazy issuance even though the exact
same node timing replays fine through the real committed (batched-issuance) log. Worked around in
this unit by moving that test's own node to `atTick: 2000` (a tick lazy issuance's bounded search
*can* reach) rather than fixing `ghost.ts` itself -- `src/planner/ghost.ts` was not in GRV-0030's
authorized file list, and a real fix (a longer bound, an exhaustive fallback search, or reusing the
already-solved batched-issuance tick when lazy issuance fails) is a planner-internals design
decision, not a mechanical one.

## Resolution
