---
status: resolved
priority: P1
filed: 2026-09-18
filed-by: agent
work: GRV-0030
---
# evaluateLaunch (levels/solve.ts) ignores the uplink delay when the post is offset from the rail

## Observation

Found while building GRV-0030's `T01-far-post` fixture -- the first level whose post is genuinely
offset from the rail's own host (10 light-minutes, ~20 ticks of uplink delay at dt=30s), rather
than sitting on it (every level T00-compiler-fixture/L01-intercept's own solver runs against).

`evaluateLaunch` (`src/levels/solve.ts:212`) builds its trial command as
`{ tick: launchTick, kind: 'launch', rail, heading, speed }` -- using the *candidate* `launchTick`
directly as the command's `tick`, i.e. its own issue tick, then runs the real `advance()` loop
against it and reads `sim.objects.x/y[probeIndex]` starting the very next step. This is exactly
right when the post sits on the rail's own host (`uplinkArrival(issueTick) === issueTick`, the
whole reason every existing level's search "evaluates every candidate as if issue and effect were
the same tick" and gets away with it, per this same function's own module-level comment). It is
wrong whenever the post is genuinely offset: the *real* simulation (the same `applyCommand`/
`checkLaunch`/`launchArrivalTick` this function itself calls into via `advance`) computes a real
`uplinkArrival(issueTick)`, queues the launch as a pending arrival, and only materialises the
probe once `sim.tick` reaches *that* tick -- not `launchTick`.

Confirmed directly against the compiled T01-far-post level: `uplinkArrival({ target: rail 0,
issueTick: 54 })` returns `74`, not `54`. So when `evaluateLaunch` is asked to evaluate
`launchTick = 54`, its trial command is only issued then -- the probe doesn't actually exist in
`sim.objects` until real tick 74. For the 20 ticks in between, `evaluateLaunch`'s own loop already
reads `sim.objects.x[probeIndex]`/`sim.objects.y[probeIndex]` (`probeIndex` is `sim.objects.count`
*before* the probe exists) as if it were the live probe position -- those array slots are still
whatever the fixed-capacity `Float64Array` happened to hold (0, or a stale value from a prior
probe at that index), not the probe. `sweptSegmentDistance`/`best`/`cleared` are all computed
against that garbage for the first 20 ticks, and the resulting "closest approach" and "cleared"
verdicts are meaningless.

Empirically: `solveLevel`/the CLI (`pnpm levels:solve T01-far-post`) reliably reports "solution
found but verifyLevel failed: not all contacts cleared" or a large (hundreds of thousands of km)
miss, and a hand-rolled hill-climb built directly on `evaluateLaunch` (bypassing the multi-stage
search entirely) confidently reports `distance: 0, cleared: true` for a candidate that, replayed
for real through `advance()` with the command properly issued (`tick = issueTickFor(...)`, not
`launchTick`), actually hits body 1 (the planet) nowhere near the contact -- confirming the
corruption is in `evaluateLaunch`'s own trial evaluation, not the real simulation or `checkLaunch`/
`segmentBlocked` (both independently verified correct and non-occluding for this level's own
geometry).

## Resolution

**Resolved 2026-09-18** in GRV-0030, commit 2495fa2. `evaluateLaunch` (`src/levels/solve.ts`) now
issues its own trial command through `issueTickFor` -- exactly the path the real committed
log/`planToCommands` uses -- treating `launchTick` as the tick the probe should *exist* at (the
search's own window/compass-search machinery already reasoned in those terms) rather than the
issue tick. The probe is only ever read once `sim.objects.count` shows it actually exists; the
flight-tick budget is extended by the pre-materialisation wait so a delayed post gets the same
flight-time budget a co-located one always did. Test-first (`src/levels/solve.test.ts`): the old
code scored T01's own known-good candidate (real replay: clears, distance ~0) as a 223,200 km
miss; the fixed code agrees with the real replay. `T00-compiler-fixture`'s and `L01-intercept`'s
own committed solutions still reproduce byte-identically (`pnpm levels:verify --check`) -- both
are zero-delay levels, unaffected by construction. `levels/T01-far-post.solution.json` is now the
solver's own, unmodified `pnpm levels:solve T01-far-post --write` output.
