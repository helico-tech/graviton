---
id: GRV-0022
epic: EPIC-05
status: todo
---
# GRV-0022 Plot renderer

**Goal.** The system plot to GAME-0002 §4-7: bodies, orbits, rails, contacts, probes and their
flown trails, at true scale with signposted glyphs, plus the renderer half of the debug API and
`pnpm render` (ADR-0004 §1, §3; ADR-0002 guard-rail 6).

**Files.** `src/render/{ctx2d,camera,palette,plot,bodies,trails}.ts`, `src/ui/plot.ts`,
`src/app/{app,debug-api}.ts`, `src/headless/render.ts`, `tests/render/*.test.ts`,
`tests/e2e/plot.spec.ts`, `package.json`.

**Acceptance.**
- `renderPlot({ ctx, view, frame })` is a pure function over a `Ctx2D` subset of
  `CanvasRenderingContext2D` and a read-only frame snapshot taken from the simulation; it never
  touches `document`, the clock or the simulation. The same function runs in the page and under
  `@napi-rs/canvas` in Node.
- Camera: logarithmic zoom over nine orders of magnitude, pan; wheel zooms about the cursor,
  drag pans; `view` is explicit state `{ centreX, centreY, metresPerPixel }`; a persistent scale
  bar (round metric length) and a numeric zoom readout on the plot, both `data-readout`.
- Bodies: below the minimum screen size a class glyph inside a hairline ring at true size; above
  it the banded sphere (four to six steps per class, hard terminator lit from the primary,
  rotation phase read off the ephemeris with a limb tick). Orbits dashed. Rails as a tick on the
  limb at their current surface angle. Contacts as the amber-dim marker on their host until
  cleared, then confirmed-good. Probes as ice-blue markers with a solid flown trail sampled
  per tick (ring buffer in the app, not the sim); expended probes dimmed.
- Meaning never by hue alone: every line class has its dash pattern, every marker its shape.
- Debug API: `render()` synchronous, `frameHash()` over the canvas pixels, `view()` get/set,
  `select` reserved for GRV-0023. URL `zoom`, `cx`, `cy`, `w`, `h` reproduce a shot.
- `pnpm render --level <id> [--tick n] [--zoom m] [--out png]` renders headless through the
  same function; `tests/render/` asserts sampled pixels and statistics (a body's terminator
  side is darker, a dashed orbit has gaps, the glyph ring exists) — no pixel goldens.
- `plot.spec.ts` under the console gate: level 01 at the default view and zoomed to the
  contact's host; `frameHash` stable across two renders in one page; a frame differs after
  `step`. Before/after screenshots and a `pnpm render` contact sheet in the evidence, read by
  the agent.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm render`, `pnpm screenshot --debug`.
