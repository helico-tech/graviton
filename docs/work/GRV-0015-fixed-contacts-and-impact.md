---
id: GRV-0015
epic: EPIC-04
status: done
---
# GRV-0015 Fixed contacts and impact

**Goal.** A probe can clear a fixed contact: the contact rides its host's surface, impact is
decided on the swept segment, and impact energy decides whether it clears (GAME-0001 §4.8,
§4.9 "consolidated hulks", research 03 §B.4, ADR-0005 ladder contact term).

**Files.** `src/sim/contacts.ts`, `src/sim/dynamics/{ladder,step,pefrl}.ts`, `src/sim/sim.ts`,
`src/app/debug-api.ts`, `src/headless/run.ts`, `tests/golden/intercept.json`, tests.

**Acceptance.**
- `Scenario.contacts`: host, longitude, capture radius, minimum impact energy. Position and
  velocity follow the host's orbit and spin exactly, O(1) at any time.
- Impact is the closest approach of the probe to the contact on each substep's swept segment
  (relative motion, not endpoint sampling) falling inside the capture radius; it is tested before
  the body-surface collision of the same substep. A probe crossing the capture sphere between
  two endpoints at 300 km/s is caught; a pass just outside is not.
- On impact the probe is expended (frozen, explicit state) and the contact records impact tick,
  closing speed and kinetic energy; it is cleared when the energy reaches its minimum, otherwise
  it stays and says so. Contact state is hashed and serialised.
- Ladder contact term: the crossing criterion against every fixed contact, independent of
  cleared state so a ghost integrated alone takes the same substeps as in a crowd.
- A second golden, `intercept.json`, launches from a rail and clears a contact on another body;
  golden replay, banned-Math replay, headless and the Chromium/Firefox parity run cover every
  golden in `tests/golden/`. `SIM_VERSION` moves only if `flyby-burn` results move.

**Verification.** `pnpm check`, `pnpm e2e`, `pnpm headless` on both goldens.

**Delivered.** `src/sim/contacts.ts` (new): `FixedContactDef`/`createContactTable`, `ContactState`/
`createContactState`, `contactPoint` (single query) and `evaluateContacts` (no-allocation batch
form, step.ts's hot path). `rails.ts`'s launch-point geometry extracted into a shared
`surfacePoint`, reused by both a rail's muzzle and a contact. `step.ts`'s `stepTick` tests every
fixed contact's swept segment before the body-surface test each substep, expends the probe
(`hitContact`, frozen alongside `hitBody`) and records/clears the contact; `ladder.ts`'s
`substepLevel` gained the contact crossing term (floored at capture radius, independent of
cleared). `SIM_VERSION` 2 -> 3 (hash domain grew even though `flyby-burn`'s own trajectory did
not -- verified bit-for-bit, see evidence). `tests/golden/intercept.json` added; both goldens now
covered generically by `golden-replay.test.ts` and `tests/e2e/parity.spec.ts`. See
`docs/evidence/GRV-0015/README.md`.
