---
id: GRV-0014
epic: EPIC-04
status: todo
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
