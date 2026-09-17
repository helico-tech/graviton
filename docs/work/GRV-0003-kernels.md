---
id: GRV-0003
epic: EPIC-02
status: todo
---
# GRV-0003 Deterministic transcendental kernels

**Goal.** `src/sim/` owns its transcendental math so results are bit-identical
across engines (ADR-0002 guard-rail 1, ADR-0005 "Transcendentals").

**Files.** `src/sim/math/kernels.ts` (`dsin dcos dsincos datan datan2 dacos
dexp dlog`, ported from `docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs`),
`src/sim/math/kernels.test.ts`.

**Acceptance.**
- Only `+ - * / Math.sqrt Math.floor Math.abs` and bit views; the `src/sim` lint rules pass untouched.
- At most 2 ulp from a high-precision reference on a fixed grid (research §2.3 measured 1.3).
- The 18 cross-check bit patterns of research §2.6 match exactly.
- `dsin`/`dcos` throw on `|x| > 2^18` (research §2.2).

**Verification.** `pnpm check`.
