---
status: accepted
date: 2026-09-03
id: ADR-0004
supersedes: none
deciders: agent (autonomous mandate from the project owner)
---

# Headless validation: debug API, Playwright screenshots, evidence per unit

## Context

The agent building Graviton cannot watch a screen. It must run the game
headless, drive it with known commands, capture frames it can read back, and
prove the shipped page works, not only the simulation. Measurements
(`docs/research/2026-09-03-05-headless-verification-and-deploy.md`):
Playwright's bundled Chromium loads the built page in ~170 ms, screenshots in
~30 ms, and its pixels are bit-identical across runs; `@napi-rs/canvas`
renders the same plot in 0.3 ms per frame but differs from Chromium by 7 % of
pixels (text anti-aliasing), so the two can never share pixel goldens.

## Decision

1. **Debug API.** With `?debug=1` the app installs `window.graviton`: `load`,
   `loadRun`, `command`, `step`, `warpTo`, `state`, `hash`, `readouts`,
   `select`, `view`, `render`, `frameHash`, `run`, `errors`, plus `version`
   with the build SHA and `ready`, set only after the level is loaded and
   `document.fonts.ready` resolved. In debug mode no animation loop runs and
   the warp ease is disabled, so `render()` is synchronous. Production pages
   never expose it. URL parameters (`level`, `seed`, `tick`, `zoom`, `w`, `h`)
   make any shot reproducible from a link.
2. **Readouts are DOM text.** Every displayed value carries
   `data-readout="<panel>.<field>"`; verifiers assert the displayed string, so
   a green simulation with a broken panel still fails.
3. **Two screenshot paths, one renderer.** `pnpm render` (Node,
   `@napi-rs/canvas`) for fast iteration and contact sheets;
   `pnpm screenshot` (Playwright, built `dist/` served over HTTP) for proof.
   Exact frame hashes are compared only under a matching renderer key
   (Playwright version, Chromium revision, OS). CI uses state hashes,
   readouts and the console gate as hard failures, and `pixelmatch` at 1 %
   for layout.
4. **Console gate.** Every driven page fails on any console error or warning,
   page error, failed request, HTTP status of 400 or above, or dialog. The
   allowlist starts empty; entries need a comment saying why.
5. **Evidence per unit.** Each unit of work ends with `docs/evidence/<ID>/`
   (ADR-0003). Anything user-visible ships before and after shots of the
   same scenario, both read by the agent. Level units ship
   `solvability.json` and a hero frame rendered from the reference solution.
6. **Deploy proof.** The Pages workflow builds from `main`; the live site is
   verified by `pnpm screenshot --url ... --expect-build <sha>` so the
   deployed build is proven to be the pushed commit.
7. **Remotes.** One `origin` (`/data/repos/graviton.git`) with two push URLs,
   the local bare repo and GitHub, so one push updates both.

## Consequences

- A screenshot the agent reads is of the real page, with real fonts and
  panels, not of a stand-in renderer.
- Playwright runs in CI (about three minutes, deterministic under software
  rasterisation); the pre-push hook runs only the fast gates.
- Perf numbers vary by 40 % on this VM; nothing is gated on timing.
