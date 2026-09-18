---
id: GRV-0033
epic: EPIC-08
status: todo
---
# GRV-0033 Mobile contacts

**Goal.** A contact that flies: a derelict whose drive is stuck open, with a collision-avoidance
reflex, integrated by the same code as probes, impactable, observed through telemetry like
everything dynamic (GAME-0001 §4.8; research 03 §A.6 `kind: mobile`; ADR-0005 "Dynamic objects").

**Files.** `src/sim/{contacts,sim,commands,telemetry}.ts`, `src/sim/dynamics/{step,ladder}.ts`,
`src/levels/{schema,compile}.ts`, `src/app/{observed,events,confirmed,selection}.ts`,
`src/render/frame.ts`, `levels/T02-drifter.level.yaml`, tests.

**Acceptance.**
- A mobile contact is a dynamic object with `kind: contact` (explicit per-object kind array):
  mass, radius, capture radius, minimum impact energy, initial state at epoch, `agility` (sustained
  acceleration, m/s²) along a fixed `driveBearing`, and an optional avoidance reflex
  `{ triggerRange, acceleration, lead }`: when any probe is within `triggerRange` and closing, the
  contact adds `acceleration` perpendicular to the closing direction (deterministic choice of
  side: away from the probe's lateral offset, ties by index), for `lead` seconds after the last
  trigger. Reflex, not intent: no pursuit, no anticipation beyond `lead`.
- Thrust of a contact is applied in the same PEFRL kick as probe burns (mass depletion may be
  ignored: the derelict's tank is treated as unlimited, stated once); its substep ladder gets the
  burn term while thrusting.
- Impact: the swept-segment test between the probe and the contact object's own segment over
  the substep (relative motion of two integrated objects), same energy rule; a mobile contact
  hit by a probe is expended too (it breaks up or is deflected: for now `cleared`).
- Contacts appear in the history and the observed view exactly like probes: `observedState`,
  the dotted extrapolation (ballistic + known thrust bearing, no reflex), the same blackout rules.
- Compiler: `kind: mobile` per research §A.6 (position, velocity, agility, driveBearing,
  avoidance); `T02-drifter` fixture: one rail, one mobile contact at 1 g agility ten light-minutes
  out with avoidance on; a direct-launch solution the solver finds (the contact's path is
  deterministic, so the omniscient solver still can) and evidence verified. Where the solver's
  objective needs the contact's future position it must take it from the simulation's own
  object state per tick, never a separate model.
- Determinism tests cover a mobile contact: warp invariance, round-trip mid-avoidance, ghost
  isolation (a probe's integration must not depend on the contact except through impact), golden
  `tests/golden/drifter.json` with a hit on a reflexing contact.

**Verification.** `pnpm check`, `pnpm e2e`, three goldens MATCH, `levels:verify` green.
