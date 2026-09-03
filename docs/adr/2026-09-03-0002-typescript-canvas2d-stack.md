---
status: accepted
date: 2026-09-03
id: ADR-0002
supersedes: none
deciders: agent (autonomous mandate from the project owner)
---

# TypeScript and Canvas 2D, no engine, one renderer for browser and Node

## Context

Graviton needs a deterministic headless simulation, a dense instrument-style
renderer (1 px dashed lines, ellipses, banded spheres, tabular monospace
text), an agent-drivable headless path that produces screenshots, GitHub
Pages deployment, and the lowest memory and CPU footprint that still delivers
those. Eight stacks were evaluated and measured on this machine
(`docs/research/2026-09-03-01-tech-stack.md`); the verification pipeline was
measured separately (`docs/research/2026-09-03-05-headless-verification-and-deploy.md`).

Two measured facts decided it:

- `Math.sin`, `cos`, `atan2`, `exp`, `log` and most other transcendentals
  differ bit-wise between Node 24 (V8 13.6), Chrome 151 (V8 15.1), Firefox
  153 and Bun. Pure `+ - * /` and `Math.sqrt` are bit-identical across all of
  them, across Rust native, and across WASM. Determinism in JavaScript is
  therefore a matter of keeping transcendentals out of the core, not of
  changing language.
- A Canvas 2D renderer written against a small `Ctx2D` interface ran
  unchanged under `@napi-rs/canvas` in Node (0.08 s, 88 MB, no browser) and in
  headless Chromium through Playwright (0.9 s, ~200 MB). Native Rust game
  libraries cannot open a display here; wgpu renders offscreen but costs 72
  crates and a breaking major every quarter.

## Decision

| Role | Choice | Version |
|---|---|---|
| Language | TypeScript, `strict`, ES2022 target | 6.0.3 |
| Runtime | Node 24 LTS (native type stripping runs `scripts/*.ts`) | 24.14 |
| Package manager | pnpm, `packageManager` pinned, `--frozen-lockfile` in CI | 11.25.0 |
| Dev server and bundler | Vite, `base: './'` | 8.2.2 |
| Unit and golden tests | Vitest, Node environment | 4.1.11 |
| Browser tests and screenshots | Playwright with its bundled Chromium | 1.62.1 |
| Headless raster | `@napi-rs/canvas`, same renderer through `Ctx2D` | 1.0.8 |
| Lint | ESLint 10 + typescript-eslint, `--max-warnings 0` | 10.9.1 / 8.69.0 |
| Format | Prettier | 3.9.6 |
| Renderer | Canvas 2D for the plot; HTML + CSS for panels | browser API |
| Fonts | JetBrains Mono, Barlow Condensed, self-hosted woff2 from `@fontsource` | 5.3.0 |
| Audio | Web Audio behind an interface with a null implementation | browser API |

Runtime dependencies of the shipped bundle: none beyond the two font files.

TypeScript 7.0 (native compiler) and oxlint were the researcher's first
choice and are faster, but TypeScript 7 has no stable programmatic API until
7.1, so typescript-eslint cannot run on it, and oxlint lacks
`no-restricted-syntax`, which is what bans the `**` operator. Vitest 5.0.0
was published today. The proven combination from the owner's canyon-run
project (same agreements, green on GitHub Pages) carries less risk and the
speed difference is irrelevant at this project size. Revisit when 7.1 lands.

Single package, no monorepo. The simulation boundary is enforced by tooling:

```
src/sim/        headless deterministic core; imports nothing outside itself
src/levels/     level data and loader
src/planner/    ghost integration through the sim's own step function
src/render/     Canvas 2D against Ctx2D; never mutates sim state
src/ui/         DOM panels, every readout tagged data-readout
src/app/        bootstrap, loop, input, warp, debug API
src/headless/   Node CLI: run, hash and render a level to a tick
scripts/        repo scripts (work items, issues, docs validation, screenshots)
tests/          golden logs, e2e specs
```

## Determinism guard-rails

1. `src/sim/` owns its transcendental math (`dsin`, `dcos`, `datan2`, and
   only what the Kepler solver needs) as plain-arithmetic implementations
   tested against fixed vectors.
2. ESLint restricts, inside `src/sim/`: every `Math.*` member except
   `sqrt abs floor ceil trunc min max sign fround imul clz32`; the globals
   `Date performance window document navigator setTimeout setInterval
   requestAnimationFrame crypto fetch localStorage Intl`; the `**` operator;
   and any import from outside `src/sim/`.
3. `tsconfig.sim.json` typechecks `src/sim/` without the DOM lib.
4. A Vitest test replays a golden log with every banned `Math` member stubbed
   to throw.
5. A Playwright test hashes the same golden log in Chromium and Firefox and
   asserts equality with the Vitest (Node) hash. This turns the contract's
   same-platform promise into cross-engine identity.
6. The renderer receives a read-only view of the state.

## Consequences

- `pnpm install && pnpm check && pnpm build` is the whole toolchain; about
  140 MB of `node_modules`, sub-second builds, ~135 MB peak RSS per tool.
- Screenshots come from Node in a tenth of a second for iteration and from
  Chromium in a second for proof of the shipped page (ADR-0004).
- If planner scrubbing ever proves too slow in V8, the sim can move to
  Rust/WASM behind the same command-in, state-out boundary; the research
  verified WASM `libm` is bit-identical across engines.
- Bun is not the toolchain (JavaScriptCore is not the shipping engine) but is
  a free third engine for the parity test.
