---
id: GRV-0021
epic: EPIC-05
status: done
---
# GRV-0021 App shell, level loading and time control

**Delivered.** The four-region shell (status bar, plot region, selection panel, timeline strip)
loads a bundled compiled level under a fixed-step warp-laddered loop, every status number is
`data-readout` text sourced from the simulation, the debug API drives level loading and warping to
an absolute tick, and `tests/e2e/shell.spec.ts` proves it under the console gate. See
`docs/evidence/GRV-0021/README.md` for command output, screenshots and deviations.

**Goal.** The page is the instrument's frame: the four-region layout, the palette and type of
GAME-0002 §2-3 and §8, a compiled level loaded and running under the warp ladder, and the status
bar's numbers as `data-readout` text from the simulation (GAME-0001 §4.11, ADR-0004 §1-2).

**Files.** `index.html`, `src/app/{main,loop,levels,warp}.ts`, `src/ui/{status,panels}.ts`,
`src/app/styles.css`, `src/app/debug-api.ts`, tests, `tests/e2e/shell.spec.ts`.

**Acceptance.**
- Layout: status bar, plot region (an empty canvas this unit), selection panel, timeline strip,
  exactly as GAME-0002 §8; palette as CSS custom properties from §2; JetBrains Mono and Barlow
  Condensed self-hosted, tabular numerals everywhere a number can change. Panels never animate.
- `?level=<id>` loads that compiled level (bundled at build time from `levels/*.level.json`;
  unknown id is a visible error state, not a blank page); default is `L01-intercept`. The brief
  is shown as body text.
- Fixed-step loop: the simulation advances only by whole ticks; warp is ticks per frame along
  the ladder `0 (paused), 1, 10, 100, 1000, 10000`; a frame never exceeds a tick budget derived
  from measured throughput; the warp change is the only eased transition (150 ms), disabled in
  debug mode. Keys: space pauses, `[` and `]` step the ladder.
- Status bar: simulated time `T+dd:hh:mm:ss`, warp, post name (the level's rail host for now),
  delay `—` (no signal model yet) — all `data-readout="status.<field>"`.
- Debug API completes `load(levelId)`, `warpTo(tick)`, `readouts()` (every `data-readout` as a
  map), `ready` only after fonts and the level; `state()` unchanged. No animation loop in debug
  mode; `step` is synchronous.
- Playwright `shell.spec.ts` under the console gate: loads level 01, reads the status readouts
  before and after `step`, asserts the time string matches the tick, checks the unknown-level
  error state, and pauses/steps via keys.
- Evidence: before/after screenshots at 1280x720 read by the agent, console clean.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm screenshot --debug`.
