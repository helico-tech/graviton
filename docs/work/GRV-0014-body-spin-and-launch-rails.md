---
id: GRV-0014
epic: EPIC-04
status: done
---
# GRV-0014 Body spin and launch rails

**Goal.** Probes launch from rails that ride their host's spin and orbit, so the launch window
is a rotation phase (GAME-0001 §4.2); the radial placeholder launch goes away.

**Files.** `src/sim/ephemeris/bodies.ts` (spin), `src/sim/rails.ts`, `src/sim/commands.ts`,
`src/sim/sim.ts`, tests, golden.

**Acceptance.**
- Bodies carry `rotationPeriod` and `axialPhaseAtEpoch`; surface phase at a tick is O(1), reduced
  before any trig, and spins prograde.
- A rail has a host, a longitude, a muzzle speed band, a heading cone half-angle about the local
  vertical and a reload time. Launch command: rail, absolute heading, speed. Position is the
  rail's surface point; velocity is host velocity plus surface rotation velocity plus the muzzle
  vector.
- A launch outside the cone or the band, or before the rail has reloaded, is rejected
  deterministically with a reason; the rail's last launch tick is state (hashed, serialised).
- The golden is re-recorded once with `SIM_VERSION` bumped, and the evidence says why.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm headless`.

**Delivered.** `BodyDef` carries `rotationPeriod`/`axialPhaseAtEpoch`; `surfacePhase` reduces the
turn fraction before the `2*pi` multiply, so the trig argument stays small at any `t` and spin is
always prograde. New `src/sim/rails.ts` (`RailDef`, `createRailTable`, `railGeometry`) computes a
rail's surface point and host-plus-rotation velocity; `LaunchCommand.body` is gone, replaced by
`rail`. `checkLaunch` (`commands.ts`) is a pure `'capacity' | 'reloading' | 'speed' | 'cone' |
null` predicate that `applyLaunch` and (later) the planner UI both call; rail state
(`railLastLaunchTick`, `NEVER_LAUNCHED` = -1) is part of `Sim`, hashed and serialised
(`FORMAT_VERSION` 1 -> 2). The golden is re-authored with a rail-based launch from the moon
(`SIM_VERSION` 1 -> 2, closest approach 3.02 giant radii, max substep level 5, burn completes, no
collision over 6000 ticks). See `docs/evidence/GRV-0014/README.md`.
