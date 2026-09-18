---
status: triaged
priority: P1
filed: 2026-09-18
filed-by: agent
work: GRV-0030
---
# segmentBlocked false-positives occluded for a target far from the post, on its own host's surface

## Observation

Found while building GRV-0030 (telemetry, T01-far-post fixture) while checking whether a distant
post can issue commands to a rail on a different body at all. `segmentBlocked`'s existing
`OCCLUSION_EPSILON` slack (`src/sim/lightcone.ts:238-282`, added in GRV-0029 for the post/rail's
own "endpoint sits exactly on its own host's surface" grazing) only guards the two early-exit
branches, which both test point A's (the segment's *source*) own `c2` against the body being
tested. It does nothing for the quadratic crossing test (`disc = b2*b2 - dd*c2`, `t1`) when point B
(the *target*, e.g. a rail on a distant body) sits exactly on some *other* body's own surface far
from the source -- a case the existing fix wasn't written for.

Repro: a post ~1.8e11 m from a rail on a different body (radius 1e5 m), with the rail's own
longitude chosen so it sits exactly on the straight line from the post to that body's centre (the
worst-case exact tangent alignment -- the rail is, after all, a surface point, so this is not a
contrived input). `c2` and `b2` for that body both come out ~3.24e22 (huge, nearly equal in
magnitude); subtracting them for `disc` loses enough precision that `t1` comes out as
`0.9999988889821696` instead of the true `1.0` -- inside `[0, 1]`, so `segmentBlocked` reports
blocked and `checkLaunch`/`checkBurn` reject with `'occluded'` even though the rail is only ever
grazed at its own endpoint, never actually inside the body along the segment's interior. This is
inherent to computing two ~1e45-magnitude nearly-equal quantities and subtracting them (classic
ray-sphere-intersection precision loss at astronomical distances), not specific to these numbers --
any post-to-far-rail (or telemetry post-to-far-object) segment landing near this alignment will
hit it.

Does **not** currently block T01-far-post's own committed launch geometry (that level's moon sits
at `meanAnomalyAtEpoch: 90 deg` specifically clear of the exact tangent alignment, confirmed
directly against the compiled level). It *does* hit immediately inside `observedState`
(src/sim/telemetry.ts, GRV-0030) once the post itself is checked as an endpoint via
`segmentBlocked` -- the post is always exactly on its own host's surface, so any occlusion check
involving it needs the same protection a distant rail/contact target needs. Upgraded to P1: real,
and this unit needs it fixed to draw a correct occlusion picture at all, not just to avoid a
specific level's launch geometry.

Suggested direction (not investigated in depth): mirror the existing source-side fix
symmetrically for the target endpoint -- if the corresponding `t1`-graze is within the same
relative tolerance of exactly 1 (rather than only checking `t1 >= 0 && t1 <= 1` verbatim), treat
it as clear rather than blocked, matching the "an endpoint sits exactly on its own host's surface"
reasoning already applied to the source.

## Resolution
