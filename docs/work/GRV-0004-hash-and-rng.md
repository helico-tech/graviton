---
id: GRV-0004
epic: EPIC-02
status: done
---
# GRV-0004 State hash and named random streams

**Goal.** The two primitives every determinism test needs: a state hash over
raw double bits and seeded named random streams (ADR-0005 "Hash", "Randomness").

**Files.** `src/sim/state/hash.ts`, `src/sim/state/rng.ts`, tests beside them.

**Acceptance.**
- Twin-lane FNV-1a-style 32-bit word hash over raw double bits; `-0` hashes as `+0`; NaN throws.
- sfc32 per named stream, seeded from splitmix32 of `seed ^ fnv(name)`; the four words per
  stream are plain data so they serialise with the state.
- Fixed golden values for hash and the first draws of two named streams; streams with
  different names are independent; a stream restored from its four words continues identically.

**Verification.** `pnpm check`.

**Delivered.** `src/sim/state/hash.ts` (incremental `createHash`/`updateFloat64`/
`updateFloat64Array`/`updateWord`/`digest`) and `src/sim/state/rng.ts`
(`createStream`/`drawU32`/`drawUnit`), tests beside them. Evidence and golden
derivation in `docs/evidence/GRV-0004/README.md`.
