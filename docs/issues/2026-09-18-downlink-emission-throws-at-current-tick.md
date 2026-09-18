---
status: triaged
priority: P1
filed: 2026-09-18
filed-by: agent
work: GRV-0030
---
# downlinkEmission throws when receiveTick equals the object's last recorded history tick

## Observation

Found while building GRV-0030 (telemetry), which needs `observedState({ sim, object, atTick })`
(new `src/sim/telemetry.ts`, this unit) to answer "what does the post see right now", i.e.
`atTick === sim.tick`. `sim.ts`'s `advance` always leaves `history.lastTick[object] === sim.tick`
after it returns (every live object's history is recorded at the end of every tick), so this is
the single most common call shape for telemetry, not a corner case.

`downlinkEmission`'s starter (`src/sim/lightcone.ts:150-156`) computes
`probe = tr < upperBoundT ? tr : upperBoundT` and then `sampleClamped(probe)`. Whenever
`receiveTick === history.lastTick[object]` (i.e. `tr === upperBoundT` exactly), `probe` is
`upperBoundT`, and `sampleState` (`src/sim/history.ts:112-132`) needs both `t0` and `t0 + 1`
samples to interpolate; at this exact boundary `t0 === last` and `t1 === last + 1` doesn't exist
yet, so it throws.

Repro (independent of geometry -- confirmed both at zero distance and at a real, non-degenerate
~1.1e11 m post-to-object distance): create a `Sim`, launch a probe, `advance` it forward some
ticks, then call `downlinkEmission({ sim, object, receiveTick: sim.tick })`. Throws
`sampleState: object <n> has no retained sample covering t=<t> (tick <n>)`. The same call with
`receiveTick: sim.tick - 1` succeeds.

Root cause: `sampleState`'s bound check (`t1 > last` -> throw) is stricter than the maths needs.
Cubic Hermite interpolation at `s = 0` (i.e. `t` exactly on a recorded tick) reduces to exactly the
`t0` sample -- the basis functions `h01`/`h11` (the ones that read `x1`/`vx1` etc.) are both zero
at `s = 0`. So a query for `t` exactly at `last * dt` doesn't actually need a `t1` sample; the
current code demands one anyway.

Suggested minimal fix (not applied -- out of GRV-0030's scope, `src/sim/**` limited to the new
`telemetry.ts` + read-only use of existing modules): in `sampleState`, when `t0 === last`, return
`{ x: history.x[i0], y: history.y[i0], vx: history.vx[i0], vy: history.vy[i0] }` directly (the s=0
identity) instead of falling through to the `t0+1`-requiring interpolation path; keep the existing
throw for `t0 > last` (still genuinely out of bounds) and `t0 < first`.

## Resolution
