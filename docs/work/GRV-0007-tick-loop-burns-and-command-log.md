---
id: GRV-0007
epic: EPIC-02
status: todo
---
# GRV-0007 Tick loop, finite burns, command log and the determinism tests

**Goal.** A runnable headless simulation: `(level, seed, command log)` in,
state and hash out, with the contract's required tests guarding it.

**Files.** `src/sim/sim.ts` (state, `step`, `applyCommand`, serialise), `src/sim/dynamics/burn.ts`,
`src/sim/commands.ts`, `src/sim/selfcheck.ts`, `src/headless/run.ts`, `tests/golden/`.

**Acceptance.**
- Integer tick is the only clock; commands are quantised integers (heading 1/65536 turn,
  delta-v mm/s, times in ticks) applied in log order at their tick.
- Finite burn at max thrust with mass depletion; direction frozen at activation without trig;
  cut on accumulated delta-v with the final partial stage analytic; delivered delta-v within
  1e-9 relative of the request. Ladder burn term: at least one substep inside an active burn.
- Startup self-check hashes the 256-input kernel golden vector against a stored constant.
- Tests: warp invariance (ticks batched 1/10/1000 per call), serialisation round-trip mid-flight,
  substep determinism across save/reload either side of a level boundary, golden replay of a
  launch + burn + flyby scenario, and the same replay with banned `Math` members stubbed to throw.
- `node src/headless/run.ts <golden>` prints the final hash.

**Verification.** `pnpm check`, `pnpm build`, headless run output in `docs/evidence/GRV-0007/`.
