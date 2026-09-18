# Graviton knowledge base

*Graviton* is a science-fiction strategy game about orbital mechanics and
signal delay, set in invented star systems. You run a clearance post,
dispatching autonomous probes to intercept derelicts and rogue bodies drifting
in inhabited traffic lanes, minutes of light away.

Declared layout for this repository. Amend deliberately; record why in an ADR.

| Directory | Holds | Naming |
|---|---|---|
| `docs/adr/` | Decisions and their rationale | `YYYY-MM-DD-NNNN-slug.md` |
| `docs/specs/` | Designs, written before implementation | `YYYY-MM-DD-<ID>-slug.md` |
| `docs/work/` | Units of work | `<COMPONENT>-<NNNN>-slug.md` |
| `docs/issues/` | Issue queue: open, resolved, and why | `YYYY-MM-DD-slug.md` |
| `docs/domain/` | Domain knowledge that outlives any one design | `slug.md` |
| `docs/context/` | Project context | `slug.md` |
| `docs/research/` | Dated research reports that fed the ADRs (ADR-0003) | `YYYY-MM-DD-NN-slug.md` |
| `docs/evidence/` | Committed proof per unit of work (ADR-0003, ADR-0004) | `<WORK-ID>/README.md` + images |

## Reading order for someone picking this up cold

1. `adr/2026-09-03-0001-clearance-framing.md` — the setting, and the vocabulary
   every other document uses.
2. `specs/2026-09-03-GAME-0001-graviton-design.md` — what the game is and how it plays.
3. `domain/signal-delay-and-uncertainty.md` — the physics the whole design rests on.
4. `domain/simulation-determinism.md` — the non-negotiable engineering contract.
5. `specs/2026-09-03-GAME-0002-graviton-aesthetic.md` — the visual and audio language.
6. `adr/2026-09-03-0002-typescript-canvas2d-stack.md` — the technology and its guard-rails.
7. `adr/2026-09-03-0004-headless-validation-and-evidence.md` — how the agent proves things.
8. `adr/2026-09-03-0005-simulation-numerics.md` — the numerical recipes and the corrected formulas.
9. `adr/2026-09-17-0006-level-format-and-solvability-evidence.md` — levels as data, and how each is proven solvable.

## Repo scripts

`scripts/new-work-item.ts`, `scripts/issues.ts` and `scripts/validate-docs.ts`
are the deterministic tools the working agreements require; run them with
plain `node` (Node 24 strips types). Work item IDs are `GRV-NNNN`; epics are
`EPIC-NN`.

`pnpm levels:build [--check]` compiles every `levels/*.level.yaml` to canonical JSON beside it
and regenerates `levels/schema/level.schema.json` (ADR-0006, docs/work/GRV-0016-level-compiler.md);
`--check` writes nothing and fails on stale output or a level with issues, and is part of `pnpm check`.

`pnpm levels:verify [--check]` replays every level with a committed `<id>.solution.json` and
writes `<id>.evidence.json` (ADR-0006 §5, docs/work/GRV-0017-level-verifier-and-evidence.md);
`--check` is part of `pnpm check`. `pnpm levels:solve <id> [--write] [--window <ticks>]
[--max-flight <ticks>] [--budget <evals>]` searches for a command log that clears a level's fixed
contacts (docs/work/GRV-0018-level-solver.md); `--write` commits `<id>.solution.json` and
regenerates its evidence through the same path `levels:verify` uses.

## Proving a change

`adr/2026-09-03-0004-headless-validation-and-evidence.md` is the decision;
this is the day-to-day recipe.

- `pnpm e2e` builds `dist/` and runs `tests/e2e/**/*.spec.ts` against it in
  real Chromium and Firefox (`playwright.config.ts`). Every spec is gated by
  `tests/e2e/console-gate.ts` (ADR-0004 §4) — console error/warning,
  `pageerror`, a failed request, an HTTP status ≥ 400, or a dialog fails the
  test.
- `pnpm screenshot [--url <u>] [--out <png>] [--expect-build <sha>] [--debug]`
  drives a real page with Playwright and the same gate (`scripts/lib/
  console-gate.ts`), writes a PNG, and exits non-zero on a gate violation or
  a build-SHA mismatch — the tool behind both per-unit evidence and the
  live-site deploy proof. `--url` points it at any origin, including the
  Pages site; without it, it serves the built `dist/` itself.
- A unit that changes anything user-visible ships `docs/evidence/<ID>/`:
  before/after screenshots of the same scenario (both read by whoever proves
  the change), the commands run, and the real output. `pnpm screenshot`
  writes the PNGs; `pnpm docs:validate` enforces the folder shape (README
  present, files ≤ 400 KB, folder name matches a work item).
