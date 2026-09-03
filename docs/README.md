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

## Repo scripts

`scripts/new-work-item.ts`, `scripts/issues.ts` and `scripts/validate-docs.ts`
are the deterministic tools the working agreements require; run them with
plain `node` (Node 24 strips types). Work item IDs are `GRV-NNNN`; epics are
`EPIC-NN`.
