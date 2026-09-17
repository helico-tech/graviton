---
id: EPIC-03
status: in-progress
---
# EPIC-03 Headless validation harness

The browser half of ADR-0004, built before anything user-visible exists so
every later unit can prove itself: Playwright, the `?debug=1` API over the
real simulation, cross-engine hash parity (ADR-0002 guard-rail 5), the console
gate and the screenshot script with deploy proof. Done when CI runs the golden
replay in Chromium and Firefox against the Node hash, and
`pnpm screenshot --url <live> --expect-build <sha>` proves a deployed build.

The plot renderer, `render`/`frameHash`/`readouts` and `pnpm render` arrive
with the renderer epic; this epic ships only the parts of the debug API the
simulation can already back.

Stories: GRV-0011, GRV-0012.
