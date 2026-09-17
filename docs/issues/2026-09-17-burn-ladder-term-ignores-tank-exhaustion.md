---
status: resolved
priority: P3
filed: 2026-09-17
filed-by: agent
work: GRV-0008
---
# Burn ladder term uses target-only t_burn_remaining, ignoring tank exhaustion

## Observation

GRV-0007's unit file specifies the burn ladder term's `t_burn_remaining` as
exactly `(m/mdot)*(1 - dexp(-rem/v_e))` (the rocket equation from state alone),
which is what `ladder.ts`'s `substepLevel` implements. For a burn whose
propellant runs out before the requested delta-v is reached (the tank-limited
case in `pefrl.ts`'s kick, GRV-0007), the *true* remaining burn time is
`min(t_burn_remaining, (m - dryMass)/mdot)`, which can be shorter than what
the ladder term uses -- the formula only knows about the target, not the dry
mass. This could under-refine the ladder for the last tick or two of a
tank-limited burn (the analytic cutoff in the kick is still exact regardless
of L, so this is a resolution/timing concern, not a delivered-delta-v
correctness one -- `burn.test.ts`'s tank-limited test passes with the current
ladder behaviour). Not fixed here: the unit's instructions give the formula
explicitly without a dry-mass term, and no acceptance criterion exercises the
gap.

## Resolution

**Resolved 2026-09-17** in GRV-0008, commit 57155a4. Fixed: substepLevel's burn term now takes an optional dryMass and uses min(t_target_remaining, (m - dryMass)/mdot); stepTick passes objects.dryMass[i] through. Failing test first in ladder.test.ts (tank with 3 kg left goes from level 0 to level 2 under dt=60s).
