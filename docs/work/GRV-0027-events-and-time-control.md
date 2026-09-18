---
id: GRV-0027
epic: EPIC-06
status: todo
---
# GRV-0027 Events and time control

**Goal.** Automatic drop to one times on launch, node execution, closest approach and impact,
announced by one inverted status-bar frame; warp to the next event (GAME-0001 §4.11, GAME-0002
§9). Picks up `docs/issues/2026-09-18-no-auto-drop-to-1x-on-impact.md`.

**Acceptance.**
- Refined when the unit is picked up.

**Verification.** `pnpm check`, `pnpm e2e` incl. the real loop.
