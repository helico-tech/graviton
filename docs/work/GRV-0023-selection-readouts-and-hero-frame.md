---
id: GRV-0023
epic: EPIC-05
status: todo
---
# GRV-0023 Selection, readouts and the level 01 hero frame

**Goal.** Click to select a body, rail, contact or probe; the selection panel shows its numbers
as `data-readout` text from the simulation (GAME-0002 §8, §11; determinism rule 11); level 01's
committed solution replays in the page and its hero frame is captured by both screenshot paths
(ADR-0004 §5).

**Files.** `src/app/{selection,app,debug-api}.ts`, `src/ui/{selection,plot}.ts`, `src/render/plot.ts`
(selection highlight only), `tests/e2e/selection.spec.ts`, `src/app/replay.ts`, docs.

**Acceptance.**
- Selection is explicit app state `{ kind, index } | null`; click picks the nearest marker within
  a screen-pixel radius, priority probe > contact > rail > body on ties; click on nothing clears;
  the selected marker gets a hairline ring on the plot. Debug API `select({ kind, index })`,
  `select(null)`, `selection()`.
- Selection panel fields, every one `data-readout="selection.<field>"` and computed from the
  simulation state and the ephemeris, never from the renderer: body: class, radius, orbital
  period, distance from the primary, rotation phase; rail: host, surface angle, muzzle band,
  cone, reload state (ready / ticks left); contact: host, capture radius, minimum energy, state
  (uncleared / cleared at T+…, closing speed, energy); probe: mass, propellant, delta-v
  remaining (rocket equation via the own `dlog`), speed, range to the nearest uncleared contact,
  state (flying / burning / expended at T+…). Units chosen to read well (km, km/s, h) with one
  formatter module, tested.
- `?solution=1` (and debug `loadSolution()`) applies the level's committed solution log so the
  page replays it; the timeline strip shows the launch tick and the recorded impact tick as
  marks with labels.
- Selection is instant, no animation; everything on the plot has its text twin (§11).
- Playwright `selection.spec.ts` under the strict console gate, both browsers: click the rail
  host at a zoomed view → panel fields present and equal to values computed in the test from
  the compiled level (period from `a` and `mu`); select the probe after `?solution=1` and
  `warpTo(impactTick)` → contact readout reads cleared and the probe reads expended; `readouts()`
  includes every selection field; clicking empty space clears.
- Evidence: before/after screenshots; the hero frame of level 01 at the impact tick, zoomed to
  the contact host with the probe selected, from `pnpm screenshot --debug` and from
  `pnpm render --solution`, both read and described; `docs/README.md` gains a line on
  `?solution=1`.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm screenshot --debug`, `pnpm render`.
