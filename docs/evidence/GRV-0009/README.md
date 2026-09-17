# GRV-0009 evidence — burn node edge cases

2026-09-17, branch `GRV-0009-burn-node-edge-cases`. Node v24.14.0.

## What was built

Three edge cases flagged by the EPIC-02 review
(`docs/issues/2026-09-17-burn-node-edge-cases-crash-or-stall-the-sim.md`), each fixed at the
point a bad command or a bad state first becomes visible, not downstream where it used to crash
or stall:

1. **`applyBurn` (`src/sim/commands.ts`) rejects `prograde === 0 && lateral === 0`.** A zero
   delta-v target has no burn direction to freeze; `startBurn` (`burn.ts`) already throws on it,
   but only once the node comes due, ticks after the command was logged and long after the
   command that caused it could be pinned down. Rejected at apply time instead, alongside the
   command's other range checks.
2. **`activateDueBurnNodes` (`src/sim/sim.ts`) drops a due node whose probe has already hit a
   body**, instead of arming it. A hit object is frozen -- every drift and kick in `pefrl.ts`
   skips it -- so an armed burn on a hit probe would never end, and stay `burning` forever; any
   later node queued for the same probe would then wait forever too, since a node due while its
   probe is burning always waits. The drop reuses `removePendingNode`'s stable shift, the same
   deterministic removal firing already used, so a hit probe's nodes are dropped in queue order
   and nodes belonging to other probes are untouched.
3. **`testCollisions` (`src/sim/dynamics/step.ts`) clears `burning` in the same pass that sets
   `hitBody`.** Previously a probe that hit mid-burn kept `burning === 1` forever (nothing ever
   cleared it, since every subsequent kick skips a hit object), even though its burn had
   definitely stopped. `burning` is explicit state, not derived from `burnDelivered` vs.
   `burnTarget` (see `pefrl.ts`'s own doc comment on the field) precisely so `hashSim`/
   `serializeSim` see a consistent object; the fix keeps that invariant across a collision, not
   just across an ordinary burn completion.

## Failing tests first

- `src/sim/commands.test.ts` -- `'throws when both prograde and lateral are zero'`: a burn
  command with `prograde: 0, lateral: 0` on a real launched probe. Failed (`expected [Function] to
  throw an error`) before the `applyBurn` guard, passed after.
- `src/sim/sim.test.ts` -- `'a due node for a hit probe is dropped, not armed; nodes for other
  probes fire normally'`: launches two probes, one on a sub-escape radial trajectory chosen to
  fall back and hit the body (empirically timed via a throwaway run, not a closed-form time of
  flight -- the exact tick depends on the integrator), the other on an escape trajectory. Two
  burn nodes are queued for the hit probe (one due shortly after impact, one much later) and one
  for the surviving probe, all logged before the hit is known to have happened. Before the fix:
  `expected 1 to be +0` on `sim.objects.burning[0]` -- the hit probe's first due node armed it
  anyway. After the fix: the hit probe's nodes are dropped one at a time as each comes due
  (`pending.count` steps 3 -> 1 -> 0, `burning[0]` stays 0 throughout) while the surviving probe's
  node arms and delivers delta-v normally (`burnDelivered[1] > 0`).
- `src/sim/dynamics/step.test.ts` -- `'a probe hit mid-burn has burning cleared the same tick the
  hit is recorded'`: a probe aimed at a body, armed with a burn whose target and tank both
  outlast the ~2400 s run (1 N thrust, an unreachable delta-v target), so nothing but the
  collision itself can end the burn. Before the fix: `expected 1 to be +0` -- `burning` was still
  set well after `hitBody` had recorded the hit. After the fix: `burning` reads 0 in the exact
  same `stepTick` call that first reports `hitBody !== -1`, and stays 0 (along with the frozen
  position/velocity/mass/`burnDelivered`) for every tick after.

All three were run and observed failing against the pre-fix code before the corresponding fix was
applied, then re-run green.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0009


 Test Files  19 passed (19)
      Tests  138 passed (138)
   Start at  21:29:33
   Duration  3.02s (transform 670ms, setup 0ms, import 1.32s, tests 3.86s, environment 1ms)
```

`pnpm docs:validate`: `docs: ok`. `pnpm build`: succeeds (`vite build`, 4 modules, ~28 ms).

## `pnpm headless tests/golden/flyby-burn.json`

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash e18434ee2785b566
MATCH
234437.8 ticks/s
```

Hash unchanged from GRV-0008 (`e18434ee2785b566`), as expected: the fixture's single burn node
never sees a zero-delta-v request, waits on a probe that never hits a body, and the probe itself
never collides (`hitBody` stays -1 for the whole run) -- none of the three fixed paths are
exercised by this fixture, so nothing about its recorded state could move.
