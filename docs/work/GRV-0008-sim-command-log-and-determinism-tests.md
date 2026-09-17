---
id: GRV-0008
epic: EPIC-02
status: todo
---
# GRV-0008 Simulation state, command log and the determinism tests

**Goal.** A runnable headless simulation: `(scenario, seed, command log)` in, state and hash
out, with the contract's required tests guarding it.

**Files.** `src/sim/sim.ts` (state, `step`, serialise, hash), `src/sim/commands.ts`,
`src/sim/selfcheck.ts`, `src/headless/run.ts`, `tests/golden/`.

**Acceptance.**
- Integer tick is the only clock; commands are quantised integers (heading 1/65536 turn,
  delta-v and speed in mm/s, times in ticks) applied in log order at their tick.
- Commands: launch a probe from a body, schedule a burn node. Launch geometry is a
  placeholder until rails exist (GAME-0001 §4.2, levels epic).
- The whole state, random streams included, serialises and restores without loss.
- Startup self-check hashes the 256-input kernel golden vector against a stored constant.
- Tests: warp invariance (ticks batched 1/10/1000 per call), serialisation round-trip mid-flight
  and mid-burn, substep determinism across save/reload either side of a level boundary, golden
  replay of a launch + burn + flyby scenario, the same replay with banned `Math` members stubbed
  to throw (ADR-0002 guard-rail 4).
- `node src/headless/run.ts <golden>` prints the final hash and ticks per second; resolves
  `docs/issues/2026-09-17-tick-allocates-argument-objects.md` by measurement.

**Verification.** `pnpm check`, `pnpm build`, headless run output in `docs/evidence/GRV-0008/`.
