---
id: GRV-0029
epic: EPIC-07
status: todo
---
# GRV-0029 Light cone, the post and command arrival

**Goal.** The simulation knows where the post is, solves the light cone both ways, keeps the
history it needs, and applies every command when it arrives (ADR-0007 §1-5, §7; ADR-0005
"Light cone"; research 02 §5).

**Files.** `src/sim/{lightcone,history,post}.ts`, `src/sim/{sim,commands}.ts`, `src/levels/{schema,compile,verify,solve}.ts`,
`levels/*`, `tests/golden/*`, tests.

**Acceptance.**
- `Scenario.post: { host, longitude }` (compiler: `post:` block; the fixture and level 01 put it
  on the rail's host). `Scenario.historyTicks` sized by the compiler from the largest body
  separation (`ceil(2 · sep / c / dt)` with margin); the ring buffer holds per-object position and
  velocity per tick, is hashed and serialised (`FORMAT_VERSION` moves), and survives a
  round-trip mid-flight.
- `uplinkArrival({ sim, target, issueTick })` and `downlinkEmission({ sim, object, receiveTick })`:
  exactly three Newton iterations from the geometric starter, cubic Hermite between ticks, `ceil`
  and `floor` quantisation; a test compares three iterations with twelve to within 1e-9 s over a
  few thousand cases at up to 40 light-minutes, and a straight-line case against the closed form.
- Occlusion: `segmentBlocked({ sim, from, to, tick })` against every body with its grazing margin
  (a new optional body field `atmosphereMargin`, default 0); tested on a body between, beside and
  behind the segment.
- Commands apply at their arrival tick: `advance` holds issued commands in a pending queue (state,
  hashed, serialised) keyed by arrival tick; `applyCommand` at issue time only validates and
  computes arrival; a burn node with `atTick < arrivalTick` is rejected `locked`; an occluded path
  at issue time is rejected `occluded`. `checkLaunch`/`checkBurn` report the arrival tick.
- `issueTickFor({ sim, target, atTick })`: the latest issue tick whose arrival is at or before
  `atTick` (fixed point over the uplink; tested against `uplinkArrival`). The solver and the
  verifier use it so a solution's launch is issued early enough; the compiler fixture's and
  level 01's solutions are re-solved and re-verified; level 01's replay must produce the same
  impact tick as before.
- Debug API `state()` gains `post`; both goldens re-recorded once with `SIM_VERSION` bumped and
  the reason in the evidence; ghost invariant tests stay green.

**Verification.** `pnpm check`, `pnpm e2e`, both goldens MATCH, `levels:verify` green.
