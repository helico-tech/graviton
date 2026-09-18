---
status: accepted
date: 2026-09-18
id: ADR-0007
supersedes: none
deciders: agent (autonomous mandate from the project owner)
---

# Signal delay: orders arrive late, telemetry is old, both quantised to ticks

## Context

The design's premise is that orders and telemetry travel at `c` while the
ephemeris does not (GAME-0001 §4.7, determinism rule 12,
`docs/domain/signal-delay-and-uncertainty.md`). ADR-0005 fixed the numerics:
three Newton iterations from the geometric starter, `ceil` for arrival and
`floor` for observation, cubic Hermite between substep endpoints, a probe
history ring buffer that is part of the state. What was still open is how the
delay enters the command log, what the player is shown, and what the planner
may edit.

## Decision

1. **The post is level data.** `post: { host, longitude }`, a surface point
   like a rail. Its position is analytic at any tick.
2. **A command's `tick` is its issue tick at the post.** The simulation solves
   the uplink to the command's target (the rail's host for a launch, the probe
   for a burn node) and applies the command at `arrivalTick = ceil(t_a / dt)`.
   A launch whose rail is on the post's own host arrives within the same tick.
   Level 01's committed solution therefore replays unchanged.
3. **What arrives late cannot be undone early.** A burn node's `atTick` must be
   at or after the command's arrival tick, otherwise the command is rejected
   with reason `locked`. This is the lock point of GAME-0001 §4.4.
4. **Occlusion blocks, it does not delay.** If the segment from the post to the
   target at issue time crosses a body (plus that body's grazing margin), the
   command is rejected with reason `occluded`. Relays are a later epic and
   never shorten a path.
5. **Telemetry is the downlink of the history.** For every dynamic object the
   simulation answers `observedState({ object, atTick })`: the state at
   `floor(t_e / dt)` for the emission that reaches the post at `atTick`, or
   `none` while occluded or before the object existed. The post's picture of an
   object is that observation plus the plan-based prediction beyond it.
6. **The player's events are telemetry events.** Impact, loss and node
   execution reach the post when their telemetry does; automatic drop to one
   times and the status line fire on the arrival tick, never on the simulation
   tick. Launch confirmation likewise.
7. **The history ring buffer is state.** Per object, position and velocity at
   every tick for at least `2 · maxRange / c / dt` ticks; serialised, hashed,
   sized per level by the compiler from the largest body separation.
8. **Every displayed number that involves delay is computed by the simulation**
   and read out as text: one-way delay to the selection, arrival tick of an
   order sent now, observation age.

## Consequences

- `SIM_VERSION` moves: command application depends on the post, and the hash
  domain gains the history and the post. Both goldens are re-recorded once;
  their logs gain no fields (issue tick already is the `tick`).
- The solver and the verifier issue a launch at `launchTick − uplink(post→rail)`
  and burn nodes early enough to arrive; the simulation exposes
  `issueTickFor({ target, atTick })` so no caller re-derives the light cone.
- The planner gains the command horizon (the arrival tick of an order sent now)
  and dims nodes before it; amendments to a flying probe's plan are new burn
  commands issued now.
- Fixed contacts keep no uncertainty box (`a = 0`); the box arrives with mobile
  contacts.
