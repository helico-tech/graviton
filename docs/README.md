# Graviton knowledge base

*Graviton* is a science-fiction strategy game about orbital mechanics and
signal delay, set in invented star systems.

Declared layout for this repository. Amend deliberately; record why in an ADR.

| Directory | Holds | Naming |
|---|---|---|
| `docs/adr/` | Decisions and their rationale | `YYYY-MM-DD-NNNN-slug.md` |
| `docs/specs/` | Designs, written before implementation | `YYYY-MM-DD-<ID>-slug.md` |
| `docs/work/` | Units of work | `<COMPONENT>-<NNNN>-slug.md` |
| `docs/issues/` | Issue queue: open, resolved, and why | `YYYY-MM-DD-slug.md` |
| `docs/domain/` | Domain knowledge that outlives any one design | `slug.md` |
| `docs/context/` | Project context | `slug.md` |

## Reading order for someone picking this up cold

1. `specs/2026-09-03-GAME-0001-graviton-design.md` — what the game is and how it plays.
2. `domain/signal-delay-and-uncertainty.md` — the physics the whole design rests on.
3. `domain/simulation-determinism.md` — the non-negotiable engineering contract.
4. `specs/2026-09-03-GAME-0002-graviton-aesthetic.md` — the visual and audio language.

## Not yet created

`scripts/new-work-item.*` and `scripts/issues.*` are required by the working
agreements but are deliberately absent. They must be written in the project's
own language and toolchain, and no technology has been chosen yet. Create them
as the first unit of work after the technology decision lands as an ADR.
