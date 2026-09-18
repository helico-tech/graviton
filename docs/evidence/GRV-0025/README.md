# GRV-0025 evidence — flight plan and ghost integration

2026-09-18, branch `GRV-0025-flight-plan-and-ghost`. Node v24.14.0, pnpm 11.25.0.

## What was built

`src/planner/{plan,ghost,readout}.ts` (docs/work/GRV-0025-flight-plan-and-ghost.md, EPIC-06,
GAME-0001 §4.4-4.6, §7 must-have 3; ADR-0005 "Consequences"). `src/sim/**` untouched;
`src/levels/solve.ts` reused (`sweptSegmentDistance`), not modified.

- **`plan.ts`**: `FlightPlan`/`BurnNode` as plain data in the command log's own integer units.
  `validatePlan` checks node count against the level's per-probe budget (`burnNodeCapacity /
  capacity` — exact, since the compiler always sets `burnNodeCapacity = count * nodeBudget` for the
  level's one probe type), sortedness, integer-ness, and `atTick > launchTick`, never re-checking
  what `checkLaunch` already owns. `planToCommands` issues every node's burn command at the plan's
  own `launchTick` (GAME-0001 §4.4: the whole plan is loaded onto the probe at launch and executed
  autonomously) — the only way a plan becomes commands, and what a real commit appends to the log.
- **`ghost.ts`**: `integrateGhost({ level, log, plan, fromTick, horizonTick, cache? })` replays
  `log` (everything already committed) to `fromTick`, then integrates the plan forward with the
  live simulation's own `advance`, sampling x/y/vx/vy/mass/burning per tick into preallocated
  `Float64Array`/`Uint8Array` buffers (`horizonTick - fromTick + 1` long) and collecting events:
  `launch`, `nodeStart`/`nodeEnd` per node (from burning edges), `closestApproach` per contact
  (tick-level swept-segment distance, reusing `solve.ts`'s helper), `impact`, `bodyHit`. Stops early
  on an impact or a body hit.
- **`readout.ts`**: `solutionReadout({ ghost, level })` — per-contact closest approach/tick,
  cleared, impact tick/closing speed/energy (straight from the ghost's own final `contactState`
  read), plus `timeOfFlight`, `deltaVRemaining` (`exhaustVelocity * dlog(mass / dryMass)`, the sim's
  own `dlog` kernel, at the ghost's last sample) and `arrivalSpeed` (relative to whichever contact
  the ghost impacted or came closest to, from the ghost's own velocity sample and the contact's own
  ephemeris velocity).

## A deliberate deviation: lazy internal issuance, not `planToCommands`, inside the ghost

`planToCommands` issues every burn command at `launchTick` — correct for a *commit*, since a real
probe loads its whole plan at launch. But ADR-0005 requires the planner to "cache from the earliest
edited node", and with every node already enqueued in the sim's pending-burn queue on the very
first tick, a checkpoint taken mid-flight cannot cleanly swap out an edited downstream node — the
stale (pre-edit) queue entry is already sitting there.

`integrateGhost`'s own internal trial log instead issues each node's burn command lazily, at its
own `atTick`. This is physically equivalent: `activateDueBurnNodes` (sim.ts) only ever checks
whether a pending node's `atTick` has arrived and the probe is free, never how long the command sat
in the queue first, so the resulting x/y/vx/vy/mass/burning trajectory is bit-identical either way.
The ghost invariant test proves this directly — it compares the ghost (lazy issuance internally)
against a live simulation advanced with `planToCommands`'s real, all-at-launch commands, and every
sample matches `Object.is`. Lazy issuance is what makes the cache correct: resuming from a
checkpoint and issuing a fresh command for an edited node is then exactly what a fresh log entry
does, nothing stale is already queued.

Flagging this because it wasn't literally what the design note for `planToCommands` describes for
"the ghost's own commands" — on inspection the two issuance orders turned out to need to differ for
the cache to be correct at all, and the invariant test is exactly the mechanism that keeps that
claim honest.

## Overlap with `src/levels/solve.ts`

`evaluateLaunch` (solve.ts) and `integrateGhost` both: create a `Sim`, advance it tick by tick,
track a swept-segment closest-approach against a contact, and stop early on a body hit. They differ
in real ways (the solver's objective is a single scalar for a search algorithm and only ever tracks
one contact against one trial launch with no burns; the ghost samples full per-tick state into
buffers, tracks every contact, supports burn nodes and mid-flight caching) but the tick-loop
skeleton and the swept-segment bookkeeping are close enough that a shared "per-tick sim walker"
abstraction is worth considering. Left as-is per the unit's own scope (`solve.ts`: reuse only) —
noting it for a follow-up rather than refactoring solve.ts here.

## Public API

```ts
// plan.ts
interface BurnNode { atTick: number; prograde: number; lateral: number }
interface FlightPlan { rail: number; launchTick: number; heading: number; speed: number; nodes: BurnNode[] }
function validatePlan({ plan, level }: { plan: FlightPlan; level: CompiledLevel }): string[]
function planToCommands({ plan, probeIndex }: { plan: FlightPlan; probeIndex: number }): Command[]

// ghost.ts
interface GhostSamples { x, y, vx, vy, mass: Float64Array; burning: Uint8Array; count: number }
type GhostEvent =
  | { kind: 'launch'; tick: number }
  | { kind: 'nodeStart' | 'nodeEnd'; tick: number; node: number }
  | { kind: 'closestApproach'; tick: number; contact: number; distance: number }
  | { kind: 'impact'; tick: number; contact: number }
  | { kind: 'bodyHit'; tick: number; body: number }
interface Ghost {
  fromTick: number; horizonTick: number; probeIndex: number;
  samples: GhostSamples; events: GhostEvent[];
  contacts: { cleared: boolean; impactTick: number; impactSpeed: number; impactEnergy: number }[];
  ticksIntegrated: number;
}
interface GhostCache { /* opaque; pass back into the next integrateGhost call */ }
function integrateGhost(args: {
  level: CompiledLevel; log: readonly Command[]; plan: FlightPlan;
  fromTick: number; horizonTick: number; cache?: GhostCache;
}): { ghost: Ghost; cache: GhostCache }

// readout.ts
interface ContactReadout {
  closestApproach: number; closestTick: number; cleared: boolean;
  impactTick?: number; closingSpeed?: number; impactEnergy?: number;
}
interface SolutionReadout {
  contacts: ContactReadout[]; timeOfFlight: number; deltaVRemaining: number; arrivalSpeed: number;
}
function solutionReadout({ ghost, level }: { ghost: Ghost; level: CompiledLevel }): SolutionReadout
```

## Throughput

`runs/ghost-throughput.ts` (throwaway, gitignored), warmed once then timed:

```
L01-intercept full flight (3303 ticks): 8.559 ms
flyby-burn golden (6000 ticks): 19.810 ms
```

Both well under the 100 ms bar (docs/work/GRV-0025-flight-plan-and-ghost.md's acceptance).

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm levels:build --check && pnpm levels:verify --check
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0025


 Test Files  53 passed (53)
      Tests  702 passed (702)
   Start at  11:57:29
   Duration  15.00s (transform 2.60s, setup 0ms, import 6.27s, tests 31.84s, environment 4ms)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
```

`pnpm docs:validate`: `docs: ok`. `pnpm build`: succeeds (60.06 kB JS, unchanged shape — the
planner isn't wired into `src/app` yet, by design; this unit is `src/planner` only).

## `pnpm e2e` (Chromium + Firefox)

64 passed, 2 skipped (the pre-existing `screenshot.spec.ts` Chromium-only skips, unrelated to this
unit) — unchanged from before this unit, since nothing under `src/app`/`src/ui`/`src/render`
changed.

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
176641.4 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
24532.8 ticks/s
```

Both hashes unchanged — expected, `src/sim/**` was not touched.

## Deviations from the brief

- **Ghost's internal command issuance timing** — see "A deliberate deviation" above. `planToCommands`
  itself matches the brief exactly (issue every node at `launchTick`).
- Everything else (module layout, `Ghost`/`GhostCache` shape, cache-from-earliest-edited-node,
  throughput target) matches the brief as given.
