---
id: GRV-0017
epic: EPIC-04
status: done
---
# GRV-0017 Level verifier and evidence report

**Goal.** A level's solvability is a replayed fact in CI, with a committed, diffable evidence file
(ADR-0006 §5, research 03 §B.5 units 2-3, §B.7).

**Files.** `src/levels/verify.ts`, `scripts/levels-verify.ts`, `levels/T00-compiler-fixture.solution.json`,
`levels/T00-compiler-fixture.evidence.json`, `package.json`, `.github/workflows/ci.yml` if needed, tests.

**Acceptance.**
- Solution file `levels/<id>.solution.json`: `{ level, simVersion, ticks, log }`, the log in the
  simulation's integer command format.
- `verifyLevel({ level, solution })` replays headless and returns the evidence: level id, hash of
  the compiled level file, `simVersion`, hash of the solution, final state hash, outcome
  (contacts cleared / total, probes launched / granted, propellant left per probe), per contact
  impact tick, time of flight, closing speed and energy against its minimum, and a `dt`
  convergence check: the same solution replayed at `dt/2` (ticks doubled) must clear the same
  contacts, with both impact times reported. No timestamps: the file is deterministic.
- `pnpm levels:verify` verifies every level that has a solution, writes `<id>.evidence.json` in
  canonical JSON, and fails when a level is not fully cleared, a solution's `simVersion` is
  stale, or the `dt/2` replay disagrees. `--check` writes nothing and also fails on a stale
  evidence file. `pnpm check` runs `levels:verify --check`. A level without a solution is
  reported, not failed (campaign levels are gated in GRV-0019).
- The compiler fixture gets a contact its rail can reach, a solution and evidence, so the whole
  path is exercised before the first campaign level exists.

**Verification.** `pnpm check`, `pnpm levels:verify`.

**Delivered.** `src/levels/verify.ts` (pure `verifyLevel`, plus the dt/2 derivation and
comparison as separately tested functions), `scripts/levels-verify.ts` (`pnpm levels:verify`,
wired into `pnpm check`), the fixture reworked so its rail can reach its contact (rail on the
moon `tesh`, contact on the planet `sadal` -- the reverse pairing turned out unsolvable, see
below), `levels/T00-compiler-fixture.solution.json` and its generated `.evidence.json`. See
`docs/evidence/GRV-0017/README.md` for output, the solved launch, and a sample FAILED run.
