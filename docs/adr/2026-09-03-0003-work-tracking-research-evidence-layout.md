---
status: accepted
date: 2026-09-03
id: ADR-0003
supersedes: none
deciders: agent (autonomous mandate from the project owner)
---

# Work tracking, research reports and evidence in the docs tree

## Context

The working agreements declare `docs/{adr,specs,work,issues,domain,context}`
and allow amendments when recorded. The owner asked for research by multiple
agents, then epics and stories, and for evidence of progress in the repo.
Three additions are needed, all taken from the owner's canyon-run project
where they proved out.

## Decision

- `docs/research/` holds the dated research reports that fed the ADRs,
  `YYYY-MM-DD-NN-slug.md`. They are evidence and are kept verbatim apart from
  path normalisation.
- `docs/evidence/` holds committed proof of progress, one folder per unit of
  work, `docs/evidence/<WORK-ID>/`: a `README.md` stating what was proven
  and the commands run, at most six PNGs at 960x540 or 1280x720, `*.meta.json`
  with state hash, readouts, renderer key and console records, and for level
  units `solvability.json`. Undated, because evidence is a property of a work
  item and work items sort by ID. `docs/evidence/README.md` is a generated
  index.
- `docs/work/` holds both epics and stories. Epics are `EPIC-NN-<slug>.md`
  and list their stories; stories are units of work `GRV-NNNN-<slug>.md`
  (component `GRV`, the single package). Stories carry `epic:` and `status:`
  (`todo | in-progress | done`) in their frontmatter. IDs come from
  `scripts/new-work-item.ts`. The existing `GAME-000N` IDs belong to the two
  design specs and are not reused.
- `scripts/issues.ts` creates, lists, triages and resolves issues so
  frontmatter is never hand-written; `scripts/validate-docs.ts` rejects
  files outside the declared layout, malformed frontmatter, unknown status or
  priority values, triaged issues without a `work:` link, evidence folders
  without a README or without a matching work item, and evidence files over
  400 KB.

## Consequences

- One directory to read for what is planned and what is done, one for why,
  one for proof.
- The pre-push hook runs `validate-docs`, so drift fails the push.
