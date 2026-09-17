# GRV-0014 evidence — body spin and launch rails

2026-09-17, branch `GRV-0014-body-spin-and-launch-rails`. Node v24.14.0, pnpm 11.25.0.

## What was built

GAME-0001 §4.2: probes launch from rails that ride their host's spin and orbit, so the launch
window is a rotation phase. The radial-launch placeholder (`LaunchCommand.body`, a fixed offset
above the surface, no spin) goes away with no compatibility path.

1. **Spin (`src/sim/ephemeris/bodies.ts`).** `BodyDef` (both `PrimaryBodyDef` and
   `OrbitingBodyDef`) gains `rotationPeriod` (s, finite, > 0) and `axialPhaseAtEpoch` (rad,
   finite). `BodyTable` gains matching `Float64Array`s plus a precomputed `angularRate` (`2*pi /
   rotationPeriod`, computed once at table creation). `surfacePhase(table, body, t)` returns
   `axialPhaseAtEpoch + 2*pi * frac(t / rotationPeriod)`, taking the fractional part of the turn
   count *before* the `2*pi` multiply (research §2.2's reduce-before-trig rule), so the value
   handed to a trig kernel stays inside `[axialPhaseAtEpoch, axialPhaseAtEpoch + 2*pi)` for any
   `t`, including a 10-year query. Spin is always prograde: the phase strictly increases with `t`
   because `rotationPeriod > 0` is validated at table creation.
2. **Rails (new `src/sim/rails.ts`).** `RailDef` (host, longitude, muzzle speed band, heading cone
   half-angle, reload ticks). `createRailTable` validates every field (host in range, longitude
   finite, `0 < muzzleSpeedMin <= muzzleSpeedMax`, `headingCone` in `(0, pi]`, `reloadTicks` a
   non-negative integer) and precomputes `cosHeadingCone` with the sim's own `dcos`.
   `railGeometry({ bodies, rails, rail, t, eph })` returns the rail's surface point and
   host-plus-rotation velocity (the muzzle term is the caller's to add -- it is the one term that
   is not purely geometric).
3. **Launch command (`src/sim/commands.ts`).** `LaunchCommand.body` -> `.rail`. `checkLaunch({
   sim, command })` is a pure `'capacity' | 'reloading' | 'speed' | 'cone' | null` predicate:
   `applyLaunch` throws with the reason when it is non-null, and the same function is exported
   (via `sim.ts`) for the planner UI to call speculatively, at any tick, without touching `Sim`
   state (`checkLaunch` does evaluate the ephemeris into `sim.scratch.eph`, but that is derived,
   per-run scratch space, never part of `hashSim`/`serializeSim` -- proven directly, see below).
   Velocity is the exact sum of three terms: host velocity + surface rotation velocity (`omega *
   radius * (-sin(phi), cos(phi))`) + the muzzle vector (`speed` along the command's absolute
   inertial heading). Position is exactly the rail's surface point, independent of heading.
4. **Rail state (`src/sim/sim.ts`).** `Scenario.rails: RailDef[]`; `Sim.rails: RailTable` (static,
   derived from the scenario like `bodies`, excluded from `hashSim`/`serializeSim`) and
   `Sim.railLastLaunchTick: Int32Array` (mutable, one entry per rail, `NEVER_LAUNCHED` = -1 until a
   rail has fired -- included in both `hashSim` and `serializeSim`/`deserializeSim`).
   `FORMAT_VERSION` (the binary serialisation layout) moves 1 -> 2 for the new rail-state record.
5. **`SIM_VERSION`** (`src/sim/version.ts`) moves 1 -> 2: every existing command log with a launch
   now produces a different trajectory (different position formula, an added rotation-velocity
   term), so any stored result that includes a launch moves.
6. **Golden (`tests/golden/flyby-burn.json`)** re-authored: the launch is now `{ kind: 'launch',
   rail: 0, heading, speed }` from a rail on the moon (body 2), with `rotationPeriod` added to all
   three bodies and a `rails` array added to the scenario. See "Golden search" below.

## Public API additions/changes

```ts
// src/sim/ephemeris/bodies.ts
interface PrimaryBodyDef  { ...; rotationPeriod: number; axialPhaseAtEpoch: number }
interface OrbitingBodyDef { ...; rotationPeriod: number; axialPhaseAtEpoch: number }
interface BodyTable { ...; rotationPeriod: Float64Array; axialPhaseAtEpoch: Float64Array; angularRate: Float64Array }
function surfacePhase(table: BodyTable, body: number, t: number): number

// src/sim/rails.ts (new)
interface RailDef { host: number; longitude: number; muzzleSpeedMin: number; muzzleSpeedMax: number; headingCone: number; reloadTicks: number }
interface RailTable { count: number; host: Int32Array; longitude: Float64Array; muzzleSpeedMin: Float64Array; muzzleSpeedMax: Float64Array; headingCone: Float64Array; cosHeadingCone: Float64Array; reloadTicks: Int32Array }
const NEVER_LAUNCHED = -1
function createRailTable(defs: RailDef[], bodies: BodyTable): RailTable
interface RailGeometry { x: number; y: number; vx: number; vy: number; ux: number; uy: number }
function railGeometry(args: { bodies: BodyTable; rails: RailTable; rail: number; t: number; eph: EphemerisOut }): RailGeometry

// src/sim/commands.ts
interface LaunchCommand { tick: number; kind: 'launch'; rail: number; heading: number; speed: number } // `body` removed
type LaunchRejection = 'capacity' | 'reloading' | 'speed' | 'cone'
function checkLaunch(args: { sim: Sim; command: LaunchCommand }): LaunchRejection | null

// src/sim/sim.ts
interface Scenario { ...; rails: RailDef[] }
interface Sim { ...; rails: RailTable; railLastLaunchTick: Int32Array }
// re-exports: RailDef, checkLaunch, LaunchRejection (alongside the existing BodyDef, Command)
```

## Test-first, by area

- **Spin** (`bodies.test.ts`): t=0 reads back `axialPhaseAtEpoch`; phase returns to the same value
  one rotation period later (advanced by exactly one turn and wrapped); phase rate over a short
  interval matches `2*pi/rotationPeriod`; prograde (phase strictly increases); a 10-year query
  stays inside `[axialPhaseAtEpoch, axialPhaseAtEpoch + 2*pi)` and matches the time-reduced
  equivalent. Validation `test.each` extended with bad `rotationPeriod`/`axialPhaseAtEpoch` for
  both primary and orbiting bodies. Run against the pre-implementation code: every one of these
  failed to compile (`rotationPeriod` did not exist on `BodyDef`) or threw/returned `undefined`;
  passed once `surfacePhase` and the new fields landed.
- **Rails** (new `rails.test.ts`, 25 tests): `createRailTable` validation table (host bounds,
  non-finite longitude, non-positive/inverted speed band, `headingCone` outside `(0, pi]`,
  non-integer/negative `reloadTicks`) plus acceptance of the `headingCone = pi` and
  `muzzleSpeedMin === muzzleSpeedMax` edges; `cosHeadingCone` checked against an independent
  `Math.cos` oracle; `railGeometry` position checked against a `Math.cos`/`Math.sin` oracle at a
  known phase (exactly on the surface, at the predicted angle); velocity checked term-by-term
  (rotation-only on a stationary primary; host-plus-rotation on a circular-orbit host, with the
  host term read off the independently-verified ephemeris); the "launch window" property --
  local vertical is antipodal half a rotation period later, and repeats after a full period.
- **Commands** (`commands.test.ts`, rewritten): position is exactly the rail surface point and
  independent of heading; velocity is host + rotation + muzzle (checked against closed forms, both
  for a stationary primary and, separately, a circular-orbit host); `checkLaunch` purity (`hashSim`
  unchanged after calling it); speed-band edges (accepted at min/max, rejected just outside);
  heading-cone edges (accepted at the boundary, rejected just past it, rejected at dot = -1 unless
  `headingCone = pi`); reload timing, including a same-tick double launch from one rail rejected as
  `'reloading'` once `reloadTicks > 0`; the launch-window property end-to-end through `checkLaunch`
  (accepted at t=0, rejected at T/2, accepted again at T); no self-collision on launch, both
  straight along the local vertical and exactly at an 80-degree cone edge (see below). All ported
  from the pre-rails suite: format/range validation, capacity, probe/dry-mass/thrust/exhaust-
  velocity assignment, the heading-quantum bit-identical check and the eleven-day sensitivity
  measurement (unaffected by rails -- they exercise the heading-to-direction formula directly).
- **Sim** (`sim.test.ts`): `railLastLaunchTick` round-trips through `serializeSim`/`deserializeSim`
  (both the fired and the `NEVER_LAUNCHED` sentinel case) and is hash-sensitive (flipping one entry
  changes `hashSim`). Warp invariance, serialisation round-trip, substep-boundary determinism and
  burn-node ordering all re-verified with rail-based launches.

Run against the pre-implementation `commands.ts` (still radial `body`-based launches), every rail
test above failed to compile (`rail` did not exist on `LaunchCommand`, `checkLaunch` did not
exist); the rewritten fixtures then exercised the real formulas once the implementation landed.

## No self-collision on launch

A launch starts exactly on the host's surface (no clearance offset, unlike the old radial
placeholder's 1000 m), so the acceptance criterion required checking directly that the substep
endpoint collision test (`step.ts`'s `testCollisions`) never flags a probe that launched outward.
Two cases, both with a real Earth-like host and km/s-class muzzle speeds (`commands.test.ts`,
`describe('no self-collision on launch')`):

- **Straight along the local vertical** (dot = 1, maximum radial component): passes.
- **Exactly at an 80-degree cone edge** (dot = cos(80 deg) = 0.174, the smallest radial component
  this unit tests): still passes -- the radial component of the *total* velocity (host + rotation +
  muzzle) is comfortably positive, and over one 60 s tick the outward drift is orders of magnitude
  larger than gravity's pull-back.

**A related, unrelated-fixture finding, reported rather than patched.** While chasing a test
failure in `sim.test.ts`'s "burn nodes for a hit probe" test, the "escaping" probe used
`heading: 32768 * 65536` -- a leftover quarter-turn constant from the pre-rails suite, where
`body`'s heading *was* the launch direction, so a quarter turn meant "straight up, radially". Under
rails, heading is decoupled from position: with that scenario's `axialPhaseAtEpoch = longitude =
0`, the rail's local vertical at t=0 is `(1, 0)`, and a quarter-turn heading is `(0, 1)` --
*exactly* tangential (dot = 0). The launch's total velocity happened to still be exactly tangential
too (both the rotation and muzzle terms pointed straight along +y), so periapsis sat exactly on the
surface -- and the PEFRL substep integrator's discretisation dipped it under the radius within the
first tick, hitting immediately. This is not a formula bug (a purely tangential launch is a
genuinely ambiguous physical edge, not "launching outward"); the fix was to change that fixture's
heading to 0 (radial, matching the local vertical) so the escape is unambiguous, not to add any
collision-test fudge. Flagging for whoever picks up the level validator (ADR-0006 §"Validator
warnings"): a level author who sets a wide `headingCone` and a longitude/phase combination that
puts a valid heading near-tangential to the rail's local vertical could hit the same fragility --
worth a validator warning once the compiler exists, not a simulation-side change.

## Golden search

`tests/golden/flyby-burn.json`'s three bodies (star, giant, moon) are unchanged in mass/orbit;
`rotationPeriod`/`axialPhaseAtEpoch` were added to each (giant: 35730 s / 9h55m, matching the
Jupiter-like figure used elsewhere in the test suite; moon: 152882 s, tidally locked to its own
~1.77-day orbit around the giant, matching real Io's figures at this `a`/`mu`). A rail was added on
the moon (`host: 2`, `longitude: 0`, muzzle speed 15-60 km/s, `headingCone: pi/2`, `reloadTicks:
100`). A throwaway grid search (`runs/search-flyby.ts`, not committed -- `runs/` is gitignored)
swept 720 headings x 10 speeds, tracking closest approach to the giant and rejecting any hit or any
heading outside the cone, to find a genuine close flyby in the 2-4 giant-radii band the unit asks
for. The burn command is unchanged (`atTick: 3000`, `prograde: 200000`, `lateral: 50000`).

**Chosen launch:** `heading: 3447904301` (289.00 deg), `speed: 35000000` (35 km/s).

**Measured trajectory facts** (`node` run of the golden, dt=60, 6000 ticks = 100 h):

```
closest approach to the giant: 215805188 m = 3.019 giant radii, at tick 3401 (after the burn)
max substep level reached:      5
burn: burning[0] = 0 (completed), burnDelivered[0] = 206.16 m/s
hitBody[0]: -1 (no collision over the whole run)
final tick: 6000
```

`SIM_VERSION` moved 1 -> 2 (see above), so `expectedHash` is a fresh recording, not a rescale:
**`7bbff52a2e74df1a`**.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0014


 Test Files  21 passed (21)
      Tests  255 passed (255)
   Start at  22:41:45
   Duration  2.69s (transform 706ms, setup 0ms, import 1.35s, tests 4.38s, environment 1ms)
```

## `pnpm docs:validate`

```
$ node scripts/validate-docs.ts
docs: ok
```

## `pnpm build`

```
$ vite build
vite v8.2.2 building client environment for production...
transforming...
✓ 19 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                 0.74 kB │ gzip: 0.41 kB
dist/assets/index-DAFpoZSv.js  21.82 kB │ gzip: 8.27 kB │ map: 114.36 kB

✓ built in 41ms
```

## `pnpm headless tests/golden/flyby-burn.json`

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash 7bbff52a2e74df1a
MATCH
224802.5 ticks/s
```

## `pnpm e2e` tail

```
Running 6 tests using 4 workers

  ✓  1 [chromium] › tests/e2e/parity.spec.ts:100:1 › window.graviton is not installed without ?debug=1 (157ms)
  ✓  2 [chromium] › tests/e2e/parity.spec.ts:74:1 › load/command/step in uneven batches replays the same golden log to the same hash (248ms)
  ✓  4 [chromium] › tests/e2e/parity.spec.ts:54:1 › run() replays the golden log and matches the Node hash (215ms)
  ✓  3 [firefox] › tests/e2e/parity.spec.ts:54:1 › run() replays the golden log and matches the Node hash (1.1s)
  ✓  5 [firefox] › tests/e2e/parity.spec.ts:74:1 › load/command/step in uneven batches replays the same golden log to the same hash (1.0s)
  ✓  6 [firefox] › tests/e2e/parity.spec.ts:100:1 › window.graviton is not installed without ?debug=1 (837ms)

  6 passed (3.9s)
```

Cross-engine hash parity confirmed with the new golden (`7bbff52a2e74df1a`) in both Chromium and
Firefox against the Node hash.

## Deviations from the design brief, and why

- **`checkLaunch` lives in `src/sim/commands.ts`, not `rails.ts`.** It needs `Sim` (host velocity,
  object count/capacity, rail last-launch state), and it subsumes the object-capacity check that
  already lived next to `applyLaunch` -- `rails.ts` stays purely about the static `RailTable` and
  pure geometry (`railGeometry`), with no `Sim` dependency (only a type-only import of `Sim` would
  have been needed there anyway, mirroring how `commands.ts` already imports `Sim` as a type to
  avoid a runtime cycle).
- **Rejection check order** is capacity -> reloading -> speed -> cone (cheapest first; cone is the
  only check that evaluates the ephemeris). The brief's union type lists the reasons in a different
  order, but doesn't mandate a precedence, and nothing in the design depends on which reason wins
  when several would apply.
- **`checkLaunch` and `applyLaunch` each independently evaluate the ephemeris and rail geometry**
  (both write into the shared `sim.scratch.eph`, which is scratch, not state) rather than threading
  one geometry computation through both. Launches are rare (at most one per rail per reload
  window), so the small duplicated `O(bodies.count)` work is not worth the coupling it would add
  between the two functions.
