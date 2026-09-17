# GRV-0008 evidence — simulation state, command log and the determinism tests

2026-09-17, branch `GRV-0008-sim-command-log-and-determinism-tests`. Node v24.14.0.

## What was built

`src/sim/sim.ts`: `Scenario` (plain JSON-able level definition: `dt`, `capacity`, `bodies`,
`probe`, `streams`), `createSim({ scenario, seed })`, `advance({ sim, log, ticks })`,
`hashSim(sim)`, `serializeSim(sim)` / `deserializeSim({ scenario, bytes })`.
`src/sim/commands.ts`: `Command` (`LaunchCommand` | `BurnCommand`, quantised-integer payloads)
and `applyCommand({ sim, command })`. `src/sim/selfcheck.ts`: `kernelGoldenVector()`,
`checkGoldenVector(expected)`, `selfCheck()`. `src/headless/run.ts`: `runGolden(golden)` and a
CLI (`pnpm headless <golden.json>`). `tests/golden/flyby-burn.json` +
`tests/golden/golden-replay.test.ts`.

## Design decisions worth recording

**Burn commands enqueue, they don't arm.** `applyCommand` on a `'burn'` command only pushes a
row onto `Sim.pending` (dense `object`/`atTick`/`prograde`/`lateral` arrays, explicit `count`).
`advance`'s `activateDueBurnNodes` runs every tick, after commands and before `stepTick`, and
arms (`startBurn`) any node whose `atTick <= sim.tick` **and** whose probe isn't already
burning; otherwise the node stays pending and is re-checked next tick. This is what makes
"a node due while another burn is active waits" deterministic: the condition is state (is the
probe burning right now), never a queue position or wall time, so two runs of the same log
always arm nodes on the same tick. Swap-remove keeps the pending arrays dense; iteration order
among the *remaining* pending nodes never matters because each only ever touches its own object.

**The command log cursor is local to `advance`, not stored in `Sim`.** The log itself isn't
part of the simulation's state (a level run is `(scenario, seed, log)`, not `(scenario, seed)`
with the log folded in), so persisting "how far we got through *this* log" on `Sim` would only
be valid as long as every caller passes the same log object back in, which isn't guaranteed by
the API. `advance` instead binary-searches the (validated-sorted) log for the first command at
or after `sim.tick` once per call, then walks forward with a local index — O(log₂ n) up front,
O(1) amortised per command, and correct regardless of what `log` is on the next call.

**Launch geometry is a radial placeholder**, exactly as the unit brief and GAME-0001 §4.2
require: position and velocity share the same heading-derived unit direction because there is
no launch rail yet to set them independently. One consequence worth flagging for whoever reads
this next: a launch directly from a *non-rotating, non-orbiting* body is necessarily a
zero-angular-momentum (purely radial) trajectory relative to that body — it can only fall back
and collide (sub-escape speed) or recede forever (super-escape speed), never curve. The golden
fixture sidesteps this by launching from a *moon*, whose own orbital velocity supplies the
angular momentum a radial kick alone cannot.

**Pending-node queue capacity is bounded by `scenario.capacity`.** A burn node is scheduled for
exactly one object, so there can never be more useful pending nodes than objects; sizing the
dense pending arrays to `capacity` avoids a separate configuration knob and `applyCommand`
throws plainly if it's ever exhausted.

**Serialisation excludes `scenario` and `scratch`.** Per research §8.3 ("nothing derived
belongs in the state"), `deserializeSim` takes `scenario` as a parameter and rebuilds the body
table and step scratch from it, exactly mirroring `createSim`. The binary layout (`DataView`,
little-endian, no `TextEncoder`) is: a header (format version, `SIM_VERSION`), then
`tick`/`seed`/`count`, then the live object prefix (the same twelve `float64` fields plus
`hitBody`/`burning` that `hashSim` reads, in the same order), then pending nodes, then stream
words. `deserializeSim` throws on either version mismatch and on a stored count exceeding the
given scenario's capacity.

## The golden fixture: a moon-launched Jupiter flyby with a mid-course burn

`tests/golden/flyby-burn.json`: primary (Sun-like, `mu = 1.32712440018e20`), a gas giant
(`mu = 1.26687e17`, `R = 7.1492e7`, Jupiter's own orbit, matching `step.test.ts`'s fixture) and
an Io-like moon of it (`mu = 5.959e12`, `R = 1.8216e6`, `a = 4.217e8 m`, `e = 0.0041`). The
probe launches from the moon (heading and speed chosen so the combined velocity is retrograde
relative to the moon's own orbital motion around the giant, per a vis-viva target periapsis —
see `tune-golden2.mjs`-style derivation, not checked in) and swings past the giant at:

- **Closest approach:** ≈ 1.7474 × 10⁸ m ≈ **2.44 Jupiter radii**, at tick 758 (≈ 0.53 simulated
  days after launch).
- **Max substep level reached:** **5** (asserted directly in
  `golden-replay.test.ts`'s "the flyby genuinely exercises the substep ladder above level 0").
- **Mid-course burn:** scheduled at tick 2500, activates at tick 3000 (well clear of the flyby),
  requests `(prograde, lateral) = (200, 50)` m/s (≈ 206.16 m/s total) and completes within the
  run (`burning` returns to 0, `burnDelivered ≈ 206.155` m/s).
- **Total run:** 6000 ticks × 60 s = 360 000 s ≈ **4.17 simulated days**, no collision
  (`hitBody` stays -1 throughout).
- **Expected hash:** `e18434ee2785b566`.

## `pnpm headless tests/golden/flyby-burn.json`

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash e18434ee2785b566
MATCH
238293.8 ticks/s
```

Repeated runs land in the 232 000–247 000 ticks/s band (single object, mostly cruise with a
brief level-5 spike during the flyby) — close to research §9.2's single-object cruise figure
(235 226 ticks/s) and comfortably inside the ADR-0005 "86 000 ticks/s for 50 objects" baseline's
own natural ballpark for one object.

## The two triaged issues

**`docs/issues/2026-09-17-burn-ladder-term-ignores-tank-exhaustion.md`** — fixed in commit
`57155a4` (this branch's first commit): `substepLevel` gained an optional `dryMass` and now uses
`min(t_target_remaining, (m - dryMass)/mdot)` for the burn ladder term, per the issue's own
proposed fix; `stepTick` passes `objects.dryMass[i]` through so production actually benefits,
not just the option. Failing test first in `ladder.test.ts`: a burn with a far-off delta-v
target (`t_target_remaining ≈ 1726 s`) but only 3 kg of propellant left (`tauDry = 22.5 s`)
stayed at level 0 under the old target-only formula despite `dt = 60 s`; the fixed formula lands
on level 2.

**`docs/issues/2026-09-17-tick-allocates-argument-objects.md`** — resolved by measurement, no
code change. Measured with the headless runner now built:

| scenario | objects | ticks | ticks/s (3 runs) |
|---|---|---|---|
| golden flyby-burn | 1 (peaks at level 5) | 6000 | 232 025 – 238 294 |
| synthetic cruise, dt=60, scattered 1–3 AU, no close encounters | 50 | 20 000 | 148 588 – 154 735 |

The 50-object cruise figure (≈150 000 ticks/s) is **1.7×** ADR-0005's quoted 86 000 ticks/s
baseline for the same shape of scenario on this VM — inside the "perf varies ±40%" note and well
inside the unit's own "within ~2x, resolve by measurement" bar, in the *faster* direction. No
allocation problem is visible at these numbers, so `stepTick`'s per-object-per-tick argument
literals (flagged as unmeasured in GRV-0006's review) are left as they are; V8 is evidently
scalar-replacing them as the original doc comment assumed. This commit doesn't touch the issue file itself, since it can't reference its own sha; a small
follow-up commit resolves it via `node scripts/issues.ts resolve
docs/issues/2026-09-17-tick-allocates-argument-objects.md --work GRV-0008 --commit <sha> --note
"..."`, citing this commit's sha once known.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0008-sim


 Test Files  19 passed (19)
      Tests  131 passed (131)
   Start at  21:12:19
   Duration  2.55s (transform 560ms, setup 0ms, import 1.07s, tests 3.99s, environment 1ms)
```

`pnpm docs:validate`: `docs: ok`. `pnpm build`: succeeds (`vite build`, 4 modules, ~30 ms).
