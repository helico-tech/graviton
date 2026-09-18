# GRV-0032 evidence — close the premise leak

## What was built

Three consumers read a dynamic object's or a contact's *true* live state ahead of its own
telemetry (`docs/issues/2026-09-18-true-state-leaks-into-selection-contact-glyph-and-timeline.md`):
`describeContact`/`describeProbe` (`src/app/selection.ts`), `captureFrame`'s contacts loop
(`src/render/frame.ts`) and `timelineData` (`src/app/app.ts`). All three now read one shared
source instead.

`src/app/confirmed.ts` (new): `confirmedContactState({ eventLog, contact })` returns `'uncleared'`
until a confirmed `impact` event lands for that contact, then `{ cleared, impactTick, arrivalTick,
closingSpeed, impactEnergy }` — `cleared` once a matching `cleared` event has also landed.
`confirmedProbeState({ eventLog, observed, probe })` returns `'unobserved'` before the post has any
observation of the probe at all, `'flying'` once observed with no confirmed `impact`/`bodyHit`
event, or `{ expendedTick, confirmedTick }` once one has. Neither touches `Sim` — both are pure over
the already-computed event log (and, for a probe, its `ObservedObject`), so `src/render/frame.ts`
can call `confirmedContactState`-derived data without becoming a reader of `sim.contactState`.

`src/app/events.ts`: the `impact` `SimEvent` now carries `closingSpeed`/`impactEnergy`, read at
observation time inside `src/app/observed.ts` (an `impact`'s own facts, from `contactState.
impactSpeed`/`impactEnergy` at the *observation's* replayed tick, never the live sim) and diffed
onto the event the same way `contactImpactTick` already was.

`src/app/observed.ts`: `ObservedObject` gained `contactImpactSpeed`/`contactImpactEnergy` (feeding
the event above) and `presentMass`/`dryMass`/`exhaustVelocity` — a probe's MASS/PROPELLANT/DELTA-V
were still reading `sim.objects` directly before this unit; they now come from the observed view's
own predicted-present replay, `presentMass` read *after* the tail replay (so a predicted burn's own
fuel use is reflected) rather than before.

`src/app/selection.ts`: `describeContact` reads `confirmedContactState` for STATE/CLOSING/ENERGY,
`sim.contacts` only for the static HOST/CAPTURE/MIN ENERGY fields (never delayed, rule 12).
`describeProbe` reads the observed view for MASS/PROPELLANT/DELTA-V/SPEED and `confirmedContactState`
per contact for RANGE's own cleared-contact exclusion; STATE from `confirmedProbeState`, with
BURNING layered on top from `observed.burning` (itself already gated by the observation). Every
field reads `—` while the probe has never been observed. `describeSelection` gained `eventLog`/
`observed` params; `debug-api.ts`'s `describeSelection` threads them through, `app.ts`'s
`selectionReadouts()` supplies its own `eventLog`/`currentObserved`.

`src/render/frame.ts`: `captureFrame` gained an optional `confirmedCleared?: readonly boolean[]`
param (one entry per contact, default `[]` → uncleared) — the contacts loop reads it instead of
`sim.contactState.cleared`. `app.ts`'s `frame()` computes it once per call from `confirmedContact
State` over `eventLog`. The selection ring colour (`src/render/plot.ts`) reads the same
`Frame.contacts[i].cleared`, so it follows automatically.

`src/app/app.ts`: `timelineData`'s impact mark now comes from `confirmedContactState` per contact
(iterating `currentLevel.scenario.contacts.length`), placed at the *confirmed* event's own
simulation tick, only once `confirmedContactState` says there has been one — never `session.
state().contacts[i].impactTick` (the true state a moment after impact, well before telemetry).

## The static guard

`src/app/premise.test.ts` (new): walks `src/app/**`, `src/ui/**`, `src/render/**` (source files,
not tests) for four patterns — `sim.objects`, `sim.contactState`, an aliased `.contactState[`
index, and an aliased object-table access `.objects.<field>[`/`.objects.count` — skipping comment
lines (several already mention these identifiers in prose, describing the very boundary this test
enforces). Three files are fully exempt (their whole job is reading the live `Sim`):
`src/app/observed.ts`, `src/app/predict.ts`, `src/app/debug-api.ts`. Two carry exactly one
*narrowly* excused line each (a structural `.objects.count` loop/existence bound, not a state
field) rather than a whole-file exemption, so any *other* offending line in either still fails the
test: `src/render/frame.ts` (`captureFrame`'s own object loop bound) and `src/app/planner.ts`
(`commandHorizon`'s ephemeral planning-sim object count, GRV-0031, pre-existing and out of this
unit's own file list). A self-check confirms every exempt entry still exists and still has a
matching read (a stale entry would silently stop guarding anything), and a sanity test confirms the
four patterns actually match the shapes this unit removed and don't false-positive on a plain array
(`Frame.objects`, `StateSnapshot.objects`).

Verified directly (not just by construction): re-introduced `src/render/frame.ts`'s old
`cleared: sim.contactState.cleared[i] !== 0` line with the Edit tool, re-ran `premise.test.ts` —
failed, naming the exact line; reverted, re-ran — passed again.

## `selection.test.ts`, `frame.test.ts`, `debug-api.test.ts`: rewritten as delayed-behaviour tests

Every direct-mutation test that used to set `sim.contactState`/`sim.objects` and immediately assert
the panel/frame showed it is now a *delayed-behaviour* test: the true state is set (or a confirmed
event log is built) and the assertion is about what the panel shows *given what telemetry has
actually confirmed*, independent of the true state — several explicitly set the true state one way
and assert the read stays the *other* way until a matching event lands, which is the leak this unit
closes, asserted directly rather than only by omission. `frame.test.ts` gained a matching pair:
true state cleared but `confirmedCleared` unset still reads `false`; `confirmedCleared: [true]` with
the true state untouched still reads `true` (proving the source is the param, not `sim`).
`debug-api.test.ts`'s one `describeSelection` behavioural test now drives `stepSampled` to build a
real `ObservedObject` rather than asserting off a live `Sim` read straight after `step()`.

## Event/state shape changes and the tests updated for them

Adding `closingSpeed`/`impactEnergy` to the `impact` `SimEvent` required updating every exact-
equality (`toEqual`) assertion on one: `src/app/events.test.ts` (both impact cases, plus the
occlusion-blackout case), `src/app/app.test.ts` (the two `toContainEqual` assertions, now
`expect.any(Number)` for both new fields). `src/app/predict.ts`'s own predicted `impact` events
don't set them (a prediction, not a confirmed telemetry fact) — the fields are optional, and Jest's
`toEqual` already ignores an absent optional key, so `predict.test.ts` needed no changes.

## Two behavioural surprises found while driving the real page (not bugs — the honest consequence
## of routing through the observed view instead of `sim` directly)

1. **`timelineData`'s own existing test** (`app.test.ts`, "after loadSolution...") warped to
   `solution.ticks` (3303 for L01) and expected an `impact.0` mark — true impact is 3298, comfortably
   inside 3303, but the post's own telemetry doesn't confirm it until ~3796 (a post-impact occlusion
   blackout, the same one `events.spec.ts` already documents at a `warpTo(3900)` margin). Updated to
   assert *no* mark at `solution.ticks`, then a mark once warped to 3900.
2. **`tests/e2e/selection.spec.ts`'s own existing test** warped one tick past the true impact
   (`AFTER_IMPACT_TICK`) and expected `EXPENDED`/`CLEARED` immediately — driving the real page (not
   assumed) showed the post's own `observed(0)` already goes dark well *before* impact (empirically:
   observed at tick 2820, dark by 2840, true impact at 3298, confirmation at 3796) — a single long
   occlusion window spanning the whole pre/post-impact geometry, not merely "one tick late" as
   originally guessed. Rewritten as three checkpoints: mid-flight (2600, fully observed, FLYING/
   UNCLEARED), just past impact (`AFTER_IMPACT_TICK`, inside the blackout — the probe panel reads a
   plain `—`, no observation to read SPEED/RANGE/STATE from at all; the contact panel, driven by the
   event log rather than the observed view, still honestly reads UNCLEARED), and 3900 (confirmed,
   `EXPENDED .../CLEARED ...` with a confirmation time). This is a real, stronger assertion than the
   one-tick guess the brief anticipated, and matches the design (ADR-0007 §5: "the post's picture...
   `null` while occluded").

## `tests/e2e/telemetry.spec.ts`: the new end-to-end test

One new test drives T01 (true impact 5806, telemetry arrival 5831, no occlusion complication for
this launch phase — see `docs/evidence/GRV-0030/README.md`): at `T01_IMPACT_TICK + 4` (5810) the
contact panel reads `UNCLEARED`, the probe panel reads `FLYING`, and the contact glyph samples
amber-dim (`UNVERIFIED_DIM #8a6224`, R > G in the sampled region); at `T01_IMPACT_ARRIVAL_TICK`
(5831) the contact panel reads `CLEARED AT T+... (confirmed T+...)`, the probe panel reads
`EXPENDED AT T+... (confirmed T+...)`, and the glyph samples confirmed-good (`CONFIRMED_GOOD
#7fe8a8`, G > R). The glyph's own world position is recomputed per tick sampled (`contactPointAt
Tick`) — the fixed contact rides its host's own ~25 km/s orbital motion, so its screen position
moves by more than the sample radius between the two ticks if reused from a single frozen point
(confirmed directly: an earlier draft of this test, reusing one frozen position, sampled zero
non-ground pixels).

## Screenshots — read directly

**`T01-5810-unconfirmed.png`** (`node scripts/screenshot.ts --debug --solution --url
".../?level=T01-far-post" --tick 5810 --select contact:0 --zoom 5000 --cx <contact x at 5810> --cy
<contact y at 5810>`, zero console violations): T+4 past the true impact. Selection panel (Relay
Hulk): `STATE UNCLEARED`, `CLOSING —`, `ENERGY —`. Status bar `EVENT LAUNCH PRB-01` (the impact
hasn't landed in the event log yet). The contact glyph (small square, left of centre) is amber-dim.

**`T01-5831-confirmed.png`** (same command, `--tick 5831`, recentred on the contact's own position
at that tick, zero console violations): the arrival tick. Selection panel: `STATE CLEARED AT
T+02:00:23:00 (confirmed T+02:00:35:30)`, `CLOSING 214.22 km/s`, `ENERGY 25.2 TJ`. Status bar
`EVENT IMPACT PRB-01 → RELAY-HULK`. The glyph has turned confirmed-good (green).

## Verification output

### `pnpm check`

```
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 Test Files  63 passed (63)
      Tests  884 passed (884)

$ node scripts/levels-build.ts --check
levels: ok
$ node scripts/levels-verify.ts --check
levels: L01-intercept ok
levels: T00-compiler-fixture ok
levels: T01-far-post ok
```

### `pnpm docs:validate`

```
docs: ok
```

### `pnpm build`

Succeeds (`vite build`).

### `pnpm headless` on both goldens

```
$ node src/headless/run.ts tests/golden/intercept.json
tick 200
hash 6108d325bf738ae3
contact 0 cleared=1 impactTick=154 impactSpeed=63125.352 impactEnergy=1.594e+12
MATCH

$ node src/headless/run.ts tests/golden/flyby-burn.json
tick 6000
hash 47448f64f618030a
MATCH
```

### `pnpm e2e` (both browsers)

```
  ✓ tests/e2e/selection.spec.ts › the probe panel reads FLYING, then blacks out through the true
    impact, then EXPENDED once telemetry confirms it; the contact panel stays UNCLEARED until the
    same confirmation (chromium, firefox)
  ✓ tests/e2e/telemetry.spec.ts › the selection panel and the contact glyph read UNCLEARED/FLYING/
    amber-dim until telemetry confirms, then CLEARED/EXPENDED/confirmed-good -- never the true
    state early (chromium, firefox)

  2 skipped
  110 passed (26.1s)
```

The 2 skips are the pre-existing, unrelated `screenshot.spec.ts` skips on firefox (documented since
GRV-0029). Nothing failed anywhere.

### `pnpm screenshot --debug` (gate check)

```
{"url":"http://127.0.0.1:.../?debug=1","build":"5e6ddd4","expected":null,"violations":[],"out":"runs/gate-screenshot.png"}
```

Exit 0, zero console violations.

## Deviations from the brief, and why

- **`src/app/planner.ts`'s single `sim.objects.count` read (`commandHorizon`) is excused in the
  static guard, not fixed.** It checks an ephemeral, freshly-replayed planning `Sim`'s object count
  (GRV-0031 light-cone/command-horizon arithmetic) — not a state readout shown to the player about a
  live object, the same category `predict.ts`'s own replays already are. Out of this unit's own file
  list (`src/app/{selection,app,observed}.ts`, `src/render/frame.ts`); changing it risked an
  unrelated behaviour change in the just-shipped GRV-0031 amendment feature for no premise-leak
  benefit.
- **The team lead's own guess that `selection.spec.ts` would need "adjusting by one tick" undersold
  the real gap.** Driving the real page showed a much longer, real occlusion window (observed dark
  from ~2820 through confirmation at ~3796) — documented above and in the spec's own updated
  comment, not silently patched over.
- **`describeProbe`'s STATE gains BURNING**, sourced from `observed.burning` (already gated the same
  delayed way) layered onto `confirmedProbeState`'s `'flying'` case — not explicitly named in the
  unit's own three-state acceptance text, but present in the pre-existing UI/tests and dropping it
  would have been a real feature regression, not a simplification.
- **A body hit now carries an event tick it never had before** (`bodyHit` was already a telemetry
  event, `src/app/events.ts`, just never read for STATE before this unit) — `describeProbe`'s own
  prior doc comment called the bare "EXPENDED" (no tick) case "an honest gap... out of scope (YAGNI)";
  routing STATE through `confirmedProbeState` closes it as a side effect, not a deliberately
  expanded scope.
