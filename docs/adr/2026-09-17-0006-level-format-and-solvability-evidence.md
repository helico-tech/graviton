---
status: accepted
date: 2026-09-17
id: ADR-0006
supersedes: none
deciders: agent (autonomous mandate from the project owner)
---

# Levels: YAML source, canonical JSON artefact, integer command log, solver-made evidence

## Context

GAME-0001 §9 leans towards levels as data. The measurements are in
`docs/research/2026-09-03-03-level-format-and-solvability.md`: a YAML parser
costs 13 to 30 kB gzipped and 0.2 to 1.9 ms per parse, `JSON.parse` costs
nothing; unit suffixes prevent order-of-magnitude typos but their conversion
rounds (`24.1 d` is not the double an author expects); a launch heading moves
the miss by 2.8e8 m per radian over an eleven-day flight, so nobody
hand-authors a solution.

That last number also breaks a row of ADR-0005. A heading quantum of 1/65536
turn is 9.6e-5 rad, which is 27 000 km of miss at that sensitivity, against
capture radii of tens of kilometres. The research's own answer, full-precision
doubles in the log, would give up the property ADR-0005 wanted: a log that is
independent of the UI's floating-point path.

## Decision

1. **Source and artefact.** One `levels/<id>.level.yaml` per level, compiled at
   build time to canonical JSON (sorted keys, SI doubles). The game, the
   headless runner and every hash read only the JSON. No YAML parser ships.
2. **Validation.** `valibot`, with the JSON Schema for editors generated from
   the same schema. Units are dimension-scoped suffix strings (`71492 km`,
   `9h 55m`); a unit from the wrong dimension is an error; a bare number is SI.
3. **The schema grows with the simulation.** A level may only state what the
   simulation already implements: bodies, rails, probes and fixed contacts
   first; mobile contacts, hazards, relays, debris and scoring join in the
   epics that implement them. No field without behaviour behind it.
4. **Command log stays integer, with a finer heading.** Heading is
   `1/2^32` turn (1.5e-9 rad, about 0.4 km of miss at the measured
   sensitivity); speed and delta-v stay in mm/s (about 1 km over eleven days);
   times stay in ticks. All fit exactly in a double and in JSON. Mid-course
   burns close what the quantum leaves.
5. **Solvability is proven, not claimed.** Each level ships a
   `<id>.solution.json` (a command log) and a generated `<id>.evidence.json`
   (outcome, miss distances, final hash, the per-level `dt` convergence sweep).
   `pnpm levels:verify` replays every solution in CI. Solutions come from a
   solver (`pnpm levels:solve`), built before the first level is authored.
6. **Validator warnings that save a wasted search:** muzzle band unable to
   cover the longest transfer inside the window, and a fixed contact whose
   approach hemisphere is never open.
7. **Palette and glyphs** live in a renderer-side body-class table, never in
   the level file.

## Consequences

- ADR-0005's "heading in 1/65536 turn" and the research report's "the command
  log must store full-precision doubles" (B.3) are superseded and marked
  inline. Rescaling by a power of two is exact, so the existing golden replays
  to the same hash with its heading multiplied by 65536.
- Two simulation changes the research found are prerequisites for fixed
  contacts: closest approach on the swept segment (not endpoint sampling), and
  the ladder's contact term (ADR-0005 already reserves it).
- Rail muzzle speeds and delta-v budgets live in the 1e5 m/s band
  (GAME-0001 §4.3); chemical-rocket numbers make unsolvable levels.
