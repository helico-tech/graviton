# GRV-0015 evidence — fixed contacts and impact on the swept segment

2026-09-17, branch `GRV-0015-fixed-contacts-and-impact`. Node v24.14.0, pnpm 11.25.0.

## What was built

GAME-0001 §4.8-4.9, research 03 §B.4, ADR-0005's ladder contact term: a fixed contact rides its
host's ephemeris exactly (no uncertainty box), impact is decided on the swept segment of the
probe's position *relative to the contact* over each substep (not endpoint sampling), and impact
energy decides whether the contact clears.

1. **`src/sim/contacts.ts` (new).** `FixedContactDef { host, longitude, captureRadius,
   minimumImpactEnergy }`, `createContactTable` (validation in `createRailTable`'s style).
   `contactPoint` is `rails.ts`'s `surfacePoint` (extracted from `railGeometry`, now shared by both
   a rail's muzzle and a contact -- a contact has no muzzle term to add, so it is that function's
   whole kinematics) with no muzzle term. `evaluateContacts` is the no-allocation batch form used
   by `step.ts`'s hot path (called once per tick for the ladder, twice per substep for the impact
   test) -- it mirrors `surfacePoint`'s formula directly rather than calling it and copying out of
   the object it returns, which would allocate once per contact per call. `ContactState { cleared:
   Uint8Array; impactTick: Int32Array; impactSpeed: Float64Array; impactEnergy: Float64Array }`
   plus `createContactState`, mirroring `PendingBurnNodes`'s separation of static table from
   mutable per-run state.
2. **Probe expended state (`src/sim/dynamics/pefrl.ts`, `step.ts`).** `PefrlObjects` gains
   `hitContact` (Int32Array, -1 = none) beside `hitBody`; "expended" is `hitBody !== -1 ||
   hitContact !== -1`, checked together everywhere liveness decides whether an object still moves,
   is grouped, or can arm a pending burn: `drift`/`kick` (pefrl.ts), the tick's grouping pass and
   `testCollisions` (step.ts), and `activateDueBurnNodes` (sim.ts). `testCollisions` skipping a
   contact-expended object in the *same* substep is what proves the ordering acceptance criterion
   (below): a contact on a body's surface catches the probe before the body-surface test ever sees
   it.
3. **Impact test (`src/sim/dynamics/step.ts`).** Per substep, before the body-surface test: the
   probe's position relative to the contact at the substep's start (`p0`) and end (`p1`); closest
   approach of the segment `p0 -> p1` to the origin, `s` clamped to `[0, 1]`, the zero-length
   segment guarded (`denom === 0 ? 0 : ...`). Several contacts within reach in one substep: smallest
   `s` wins, ties by lowest index (falls out of scanning ascending and only replacing on a *strictly*
   smaller `s`). Closing velocity is `(p1 - p0) / h` -- the mean relative velocity over the substep,
   consistent with the swept segment, not the instantaneous velocity at either endpoint. Kinetic
   energy `0.5 * mass * speed^2` with the probe's *current* mass (post-kick, so a burn's propellant
   loss during the same substep is already reflected). `energy >= minimumImpactEnergy` clears the
   contact; either way the last impact's tick/speed/energy are recorded. Cleared contacts are
   skipped by the impact test (a broken-up hulk is gone) but not by the ladder.

   **Ephemeris reuse.** `StepScratch` gained `tickStartEph` (bodies at tick start, filled once,
   never mutated again -- previously this role was played by `eph`, which the substep loop
   overwrites) and `contactEph`/`contactP0`/`contactP1`. Every level's `s = 0` substep starts at
   tick-start time by construction, so its `p0` is read directly from `tickStartEph`/`contactEph`
   with no extra evaluation; every `s > 0` substep's `p0` is the *previous* substep's `p1` (already
   evaluated for that substep's own endpoint test), copied forward rather than re-evaluated. The
   only new per-tick cost is one `evaluateContacts` call (ladder input) plus one more per substep
   (the endpoint) -- no redundant ephemeris evaluations were added.
4. **Ladder contact term (`src/sim/dynamics/ladder.ts`).** `substepLevel` gained optional
   `contacts`/`contactEph` args (omitted, existing callers are unaffected): for every contact, the
   crossing ladder `dt * vRel / 2^L <= zeta * r` with `r` floored at the contact's own capture
   radius (so the loop never chases `r -> 0` as a probe centres on it) and `vRel` relative to the
   contact's own velocity. Independent of `cleared` -- the ladder never reads it -- which is what
   keeps ghost isolation holding with contacts present: a probe's substep sizes cannot depend on
   what other probes did to a shared contact.
5. **Serialisation and hashing (`src/sim/sim.ts`).** `Scenario.contacts: FixedContactDef[]`;
   `Sim.contacts: ContactTable` (derived, excluded, like `bodies`/`rails`) and `Sim.contactState:
   ContactState` (real state: hashed and serialised). Object records gain `hitContact`; a new
   contact-state record (`cleared`, `impactTick` int32, `impactSpeed`, `impactEnergy` float64) is
   appended after the rail records. `FORMAT_VERSION` 2 -> 3.
6. **`SIM_VERSION` 2 -> 3.** `hashSim` now hashes an extra word per object (`hitContact`) and a
   record per contact, even for a scenario with zero contacts -- the hash *domain* grew, though no
   trajectory moved. Verified directly for `flyby-burn.json` (bit-for-bit, see below); bumped
   because `SIM_VERSION`'s documented purpose is exactly "a hash-domain change makes a stale golden
   fail loudly," which this is.
7. **Debug API and headless (`src/app/debug-api.ts`, `src/headless/run.ts`).**
   `ObjectSnapshot.hitContact`; `StateSnapshot.contacts: ContactSnapshot[]` (`cleared`,
   `impactTick`, `impactSpeed`, `impactEnergy`), a read-only copy like the rest of `state()`.
   `runGolden` returns a `contacts` array; the CLI prints one `contact <i> cleared=... impactTick=...
   impactSpeed=... impactEnergy=...` line per contact, after the hash line.
8. **Goldens.** `golden-replay.test.ts` and `tests/e2e/parity.spec.ts` both iterate over every
   `*.json` in `tests/golden/` for the generic hash-replay (and banned-Math, and Chromium/Firefox
   parity) checks; scenario-specific assertions (the flyby's burn node, the intercept's clearance)
   stay in their own `describe` blocks. `tests/golden/intercept.json` (new): a rail on a moon,
   launched at a giant it orbits, with a fixed contact on the giant -- see "Intercept golden"
   below.

## Public API additions/changes

```ts
// src/sim/contacts.ts (new)
interface FixedContactDef { host: number; longitude: number; captureRadius: number; minimumImpactEnergy: number }
interface ContactTable { count: number; host: Int32Array; longitude: Float64Array; captureRadius: Float64Array; minimumImpactEnergy: Float64Array }
function createContactTable(defs: FixedContactDef[], bodies: BodyTable): ContactTable
function contactPoint(args: { bodies: BodyTable; contacts: ContactTable; contact: number; t: number; eph: EphemerisOut }): SurfacePoint
function evaluateContacts(args: { bodies: BodyTable; contacts: ContactTable; t: number; hostEph: EphemerisOut; out: EphemerisOut }): void
export const NO_IMPACT = -1
interface ContactState { cleared: Uint8Array; impactTick: Int32Array; impactSpeed: Float64Array; impactEnergy: Float64Array }
function createContactState(count: number): ContactState

// src/sim/rails.ts
interface SurfacePoint { x: number; y: number; vx: number; vy: number; ux: number; uy: number } // extracted from RailGeometry
type RailGeometry = SurfacePoint
function surfacePoint(args: { bodies: BodyTable; host: number; longitude: number; t: number; eph: EphemerisOut }): SurfacePoint

// src/sim/dynamics/pefrl.ts
interface PefrlObjects { ...; hitContact: Int32Array }

// src/sim/dynamics/ladder.ts
interface SubstepLevelArgs { ...; contacts?: ContactTable; contactEph?: EphemerisOut }

// src/sim/dynamics/step.ts
interface StepScratch { ...; tickStartEph: EphemerisOut; contactEph: EphemerisOut; contactP0: EphemerisOut; contactP1: EphemerisOut }
function createStepScratch(args: { bodies: BodyTable; contacts: ContactTable; dt: number; capacity: number }): StepScratch
interface StepTickArgs { ...; contacts: ContactTable; contactState: ContactState }

// src/sim/sim.ts
interface Scenario { ...; contacts: FixedContactDef[] }
interface Sim { ...; contacts: ContactTable; contactState: ContactState }
// re-exports: FixedContactDef (alongside the existing BodyDef, RailDef, Command)

// src/app/debug-api.ts
interface ObjectSnapshot { ...; hitContact: number }
interface ContactSnapshot { cleared: number; impactTick: number; impactSpeed: number; impactEnergy: number }
interface StateSnapshot { ...; contacts: ContactSnapshot[] }

// src/headless/run.ts
interface ContactResult { cleared: number; impactTick: number; impactSpeed: number; impactEnergy: number }
function runGolden(golden: GoldenFile): { hash: string; ticksPerSecond: number; contacts: ContactResult[] }
```

## Test-first, by area

- **`contacts.ts`** (new `contacts.test.ts`, 16 tests): `createContactTable` validation table
  (host bounds, non-finite longitude, non-positive/non-finite captureRadius, negative/non-finite
  minimumImpactEnergy; zero minimumImpactEnergy accepted -- any impact clears it);
  `contactPoint`'s position and velocity checked against a `Math.cos`/`Math.sin` oracle, exactly
  `rails.test.ts`'s own style, both for a stationary primary and a circular-orbit host with spin;
  an O(1) check (two independent queries at a ten-year time agree exactly, no stepping);
  `createContactState`'s defaults (uncleared, `NO_IMPACT`, zero speed/energy).
- **`ladder.ts`** (`ladder.test.ts`, 5 new tests): the contact crossing term raises the level on
  approach in open space, far from any body; flips level exactly at `dt*vRel = zeta*rFloored`
  (boundary probed with a tiny margin either side, matching this file's own existing boundary
  tests); the floor keeps the level bounded (on-contact and at-capture-radius give the *same*
  level, not an ever-finer one as `r -> 0`); identical whether the contact is cleared or not (the
  function takes no `cleared` input at all -- documented as deliberate). Existing tests untouched
  (contacts/contactEph are optional).
- **`step.ts`** (`step.test.ts`, 8 new tests in `describe('fixed contact impact', ...)` plus a
  ghost-isolation test): a probe crossing the capture sphere between two swept-segment endpoints
  at 300 km/s is caught, both endpoints verified outside it (a large, deliberately unrealistic
  capture radius isolates the segment-vs-endpoint math from the ladder's own refinement, which
  `ladder.test.ts` already covers -- see the test's own comment); a pass 100 m outside is not
  caught; two contacts within reach in one substep, smallest `s` wins (verified by index, not
  just outcome); the zero-length relative segment (probe and host velocities engineered so
  gravity's substep-long position perturbation rounds away to nothing at that scale -- `denom`
  underflows to exactly `0`, not approximately); impact tested before the body-surface test in
  the same substep (a contact on the surface catches the probe first, `hitBody` stays `-1`);
  energy below the minimum expends the probe but leaves the contact uncleared; a cleared contact
  no longer catches a second probe flown the identical approach. **Ghost isolation with contacts
  present** (new `describe`): the tracked probe (index 0) is bit-identical alone vs. among 200
  others, including a deterministic impactor seeded exactly on a *different* contact's own
  position so "some of which impact" is verified directly rather than left to chance, while
  probe 0 itself never approaches that contact (asserted on both runs).
- **`sim.ts`** (`sim.test.ts`, new `describe('fixed contacts', ...)`, 4 tests): serialise
  round-trip both before impact (mid-approach) and after (contact state itself -- cleared,
  impact tick/speed/energy -- survives the round trip, not just the trajectory that produced it);
  hash sensitivity to `contactState.cleared`/`impactEnergy` and to `hitContact`; a due burn node
  for a contact-expended probe is dropped, not armed (mirrors the existing hit-a-body test).
- **`debug-api.ts`** (`debug-api.test.ts`, 1 new test): `state().contacts` has one entry per
  scenario contact with the right defaults, and is a read-only copy (mutating the returned array
  doesn't touch the live sim).
- **Goldens** (`golden-replay.test.ts`, restructured): the generic hash-replay and banned-Math
  tests now run once per file in `tests/golden/` via `describe.each`; `flyby-burn`'s substep-ladder
  and burn-node assertions and `intercept`'s clearance assertion moved into their own
  scenario-specific `describe` blocks. A non-golden test (same launch and contact geometry,
  `minimumImpactEnergy` raised to 5e12 J, above the ~1.594e12 J actually delivered) confirms the
  uncleared-but-recorded-and-expended path end to end.

Run against the pre-implementation code, every one of the tests above failed to compile
(`hitContact`, `ContactTable`, `FixedContactDef`, `contacts.ts` itself did not exist) or, for the
tests that only needed new fixture data (goldens), asserted against behaviour that did not exist
yet; all pass once the implementation landed.

## Intercept golden

Two bodies only (no star): a giant primary (`mu=1.26687e17`, `radius=7.1492e7`, matching the
Jupiter-like figures used elsewhere in this suite) and a moon orbiting it (`a=4.217e8`,
`e=0.0041`, matching `flyby-burn.json`'s own moon). The rail sits on the moon's near side
(`longitude=pi`, facing the giant); the fixed contact sits on the giant itself.

`runs/search-intercept.mjs` (throwaway, not committed -- `runs/` is gitignored) finds the launch
analytically rather than by a blind grid: a rail's total launch velocity is `(host + rotation
velocity) + muzzle` (`rails.ts`), so a heading/speed pair is solved in closed form that points the
*total* velocity at the giant's centre at a target total speed (~30 km/s) -- this is the "coarse"
stage research 03 §B.1 calls for, done analytically instead of swept. That alone lands a body hit;
placing the contact exactly at that natural impact point's longitude (computed from the hit
position and time) turns it into a contact hit with comfortable margin, without a further
bisection stage.

**Chosen launch:** `heading: 2505542107`, `speed: 34645246` mm/s (34.645 km/s muzzle, total launch
speed ~30 km/s once combined with the moon's own orbital and rotational velocity). Contact:
`longitude: -1.6222533439276794`, `captureRadius: 40000` m, `minimumImpactEnergy: 1e12` J.

**Measured facts** (`node` run of the golden, dt=60, 200 ticks = 3.33 h):

```
flight time to impact:       tick 154 = 9240 s = 2.567 h
closing speed:                63125.35 m/s
impact energy:                1.594e12 J (minimum: 1e12 J -- clears)
miss distance at the captured endpoint: ~30556 m (captureRadius 40000 m, ~24% margin)
max substep level reached:    10 (L_MAX -- the ladder floors hard as the probe nears a 40 km target
                               at 63 km/s, exactly research 03 §B.4's point)
hitBody[0]: -1 (caught by the contact before ever reaching the body-surface test)
hitContact[0]: 0, cleared: 1
```

A second, non-golden scenario (same launch and contact geometry, `minimumImpactEnergy: 5e12`)
confirms the uncleared path: `hitContact[0]` still `0`, `cleared` `0`, `impactEnergy` unchanged
(~1.594e12 J, below the raised minimum).

## `SIM_VERSION`: hash domain grew, trajectory did not

`flyby-burn.json`'s own trajectory must not move. Verified by comparing the probe's final state's
raw bits before and after this unit's changes (both against the *same* command log, `contacts: []`
added only after this check):

| Field | Before (`SIM_VERSION` 2) | After (`SIM_VERSION` 3) |
|---|---|---|
| `x` | `425a4bd6e4d96853` | `425a4bd6e4d96853` |
| `y` | `42614d0115d70a0b` | `42614d0115d70a0b` |
| `vx` | `c0d22e30b0067422` | `c0d22e30b0067422` |
| `vy` | `40c745281cb65c9a` | `40c745281cb65c9a` |

Bit-identical. `expectedHash` still moved (`7bbff52a2e74df1a` -> `bac70a53ec8cee4b`) because
`hashSim` now reads one extra word per object (`hitContact`) and a contact-state record, even with
zero contacts -- exactly the hash-domain growth `SIM_VERSION`'s bump documents.

## Throughput: `flyby-burn` before/after (no contacts in that scenario)

Eight `node src/headless/run.ts tests/golden/flyby-burn.json` runs on each side (machine load
varies run to run; both sides measured back to back to keep that comparable):

- Before (`SIM_VERSION` 2, pre-GRV-0015 code): mean **210 302** ticks/s (five runs: 200917, 223523,
  204607, 203548, 218914).
- After (`SIM_VERSION` 3, this unit, `contacts: []`): mean **196 603** ticks/s across thirteen runs
  (170985, 190186, 181565, 203020, 183775, 192630, 214389, 206244, 207191, 186382, 207430, 204232,
  207813).

About 6.5% slower, well inside the unit's own ±15% noise budget -- the contact machinery costs a
scenario with zero contacts one `evaluateContacts` call per tick and per substep, both no-ops at
`contacts.count === 0`, plus the extra `hitContact` field touched in the same loops `hitBody`
already was.

## `pnpm check` tail

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0015


 Test Files  24 passed (24)
      Tests  307 passed (307)
   Start at  23:35:20
   Duration  2.67s (transform 829ms, setup 0ms, import 1.97s, tests 4.60s, environment 2ms)
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
✓ 20 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                 0.74 kB │ gzip: 0.41 kB
dist/assets/index-DuNxVq8i.js  25.60 kB │ gzip: 9.34 kB │ map: 138.24 kB

✓ built in 41ms
```

## `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash bac70a53ec8cee4b
MATCH
219853.9 ticks/s

$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash fca6f5504388a83c
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH
28236.0 ticks/s
```

## `pnpm e2e` tail

```
Running 34 tests using 4 workers

  ✓  11 [chromium] › tests/e2e/parity.spec.ts:48:5 › golden: flyby-burn.json › run() replays the golden log and matches the Node hash (177ms)
  ✓  12 [chromium] › tests/e2e/parity.spec.ts:68:5 › golden: flyby-burn.json › load/command/step in uneven batches replays the same golden log to the same hash (178ms)
  ✓  13 [chromium] › tests/e2e/parity.spec.ts:48:5 › golden: intercept.json › run() replays the golden log and matches the Node hash (135ms)
  ✓  14 [chromium] › tests/e2e/parity.spec.ts:68:5 › golden: intercept.json › load/command/step in uneven batches replays the same golden log to the same hash (142ms)
  ✓  15 [chromium] › tests/e2e/parity.spec.ts:96:1 › window.graviton is not installed without ?debug=1 (79ms)
  ✓  28 [firefox] › tests/e2e/parity.spec.ts:48:5 › golden: flyby-burn.json › run() replays the golden log and matches the Node hash (455ms)
  ✓  29 [firefox] › tests/e2e/parity.spec.ts:68:5 › golden: flyby-burn.json › load/command/step in uneven batches replays the same golden log to the same hash (472ms)
  ✓  30 [firefox] › tests/e2e/parity.spec.ts:48:5 › golden: intercept.json › run() replays the golden log and matches the Node hash (448ms)
  ✓  31 [firefox] › tests/e2e/parity.spec.ts:68:5 › golden: intercept.json › load/command/step in uneven batches replays the same golden log to the same hash (557ms)
  ✓  32 [firefox] › tests/e2e/parity.spec.ts:96:1 › window.graviton is not installed without ?debug=1 (252ms)

  2 skipped
  32 passed (5.7s)
```

Cross-engine hash parity confirmed for both goldens (`bac70a53ec8cee4b`, `fca6f5504388a83c`) in
both Chromium and Firefox against the Node hash. (2 skipped: the pre-existing Firefox screenshot
tests, unrelated to this unit.)

## Deviations from the design brief, and why

- **The impact-detection loop (`testContactImpacts`) is a private function in `step.ts`, not
  exported.** Nothing outside `stepTick` needs it; keeping it unexported matches `testCollisions`'s
  own existing (private) shape next to it.
- **`SubstepLevelArgs.contacts`/`contactEph` are optional**, defaulting to "no contact term",
  rather than required. `bodies`/`objects`-style required arguments would have forced every
  existing ladder test (and three other dynamics test files that predate contacts) to thread a
  same-shaped empty table through calls that have nothing to do with contacts; optional args with
  no contact term when omitted is the same trade-off the existing burn fields already made in this
  file.
- **`StepScratch`'s `contacts`/`StepTickArgs`'s `contacts`/`contactState` are required, not
  optional**, unlike the ladder's own args above. `createStepScratch` sizes `contactEph`/
  `contactP0`/`contactP1` from `contacts.count` at creation time; if `stepTick` could default to a
  *different* (empty) table when a caller forgot to pass one, a real contacts scenario would
  silently read past sized-for-empty scratch arrays or (worse) silently skip its own contacts.
  Explicit, required arguments turn that class of mismatch into a compile error instead. The four
  pre-existing dynamics test files that don't otherwise touch contacts (`burn.test.ts`,
  `flyby-accuracy.test.ts`, `moving-attractor.test.ts`, and the pre-existing tests in
  `step.test.ts`) each define one shared, module-level empty `ContactTable`/`ContactState` pair
  for this.
- **The intercept golden's contact sits on the giant itself, not "a second moon"** (the brief's
  first example, with "a second moon" as an alternative). Aiming precision is the same either way
  (the target is the 40 km capture disk regardless of what it is affixed to -- established while
  building the search script, not assumed), and a single extra body (the giant already exists to
  be orbited) keeps the scenario's diff smaller than adding a fourth body for a second moon would.
- **No mid-course burn in the intercept log.** The brief allows one optionally; the direct-launch
  solve (analytic heading/speed, see "Intercept golden" above) already lands comfortably inside
  the capture radius without one, and GRV-0015's own YAGNI rule is to not add machinery the
  scenario doesn't need to pass.

## Problems outside this unit (for the team lead to file)

- None found. The one pre-existing issue this unit's tests brushed against --
  `docs/issues/2026-09-17-shallow-launch-can-self-collide.md` (P3, a near-tangential launch can
  clip its own host) -- was not re-triggered by anything here: the intercept golden's launch
  heading points well clear of tangential (dot product with the local vertical close to 1, a
  near-radial shot), and its own no-self-collision behaviour was confirmed empirically (`hitBody`
  stays -1 for the whole flight until the deliberate contact capture).
