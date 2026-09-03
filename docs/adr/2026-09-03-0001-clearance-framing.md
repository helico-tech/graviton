---
status: accepted
date: 2026-09-03
id: ADR-0001
supersedes: none
---

# Graviton is set in unarmed lane clearance

## Context

Graviton's mechanics are about knowledge and latency, not about conflict. The
whole design reduces to one relationship: an amber ellipse for what you cannot
know, a blue one for what you can still reach.

Any setting for that has to answer four questions:

1. Why is an autonomous craft dispatched at an object light-minutes away?
2. Why must it act on rules written before launch rather than on live orders?
3. Why might the object move in a way you cannot predict?
4. Why can the flight end short of arrival?

Earlier drafts of GAME-0001 and GAME-0002 answered those four questions by
implying an opponent, which the design neither has nor wants: an active
adversary is already a stated non-goal for version one. Git history holds those
revisions.

## Decision

The setting is lane clearance. Traffic between habitats runs on fixed lanes.
Derelicts under uncommanded thrust, rogue bodies on crossing orbits and the
debris of older accidents get into those lanes. The player runs a clearance
post and dispatches autonomous probes to intercept, deflect or break up what is
in the way.

Fixed vocabulary across all documents:

| Term | Means |
|---|---|
| Clearance post | The player's fixed position. Origin of every order. |
| Probe | An autonomous craft, launched with a flight plan and clauses aboard. |
| Launch rail | A fixed launcher on a body or station. Inherits spin and orbital velocity. |
| Contact | Anything the player is sent to clear. Fixed or free-flying. |
| Exposure | Accumulated flux from a hazard. At one, the probe is lost. |
| Halo | The region around an object where exposure accumulates. |
| Wave | Several probes launched to cover one uncertainty box. |
| Cleared | A contact resolved: deflected, broken up, or out of the lane. |

## Consequences

- Nothing in the game opposes the player. Hazards are physical facts about
  objects — a breached reactor, a shed debris cloud, a venting sheath — not
  defences operated by anyone. The level still pushes back; the system stays
  indifferent.
- A contact's evasion needs a benign cause, and has one: on a derelict,
  collision avoidance is frequently the last system still working. This
  constrains contact behaviour to avoidance reflexes and rules out pursuit,
  ambush or anything that reads as intent.
- Impact energy, fragmentation and debris all survive unchanged, because
  deflecting or breaking up a derelict or a rogue body is the job rather than
  an act against anyone.
- Scoring counts contacts cleared, probes unexpended and delta-v remaining.
- No mechanic was cut or altered by this decision. It is a setting change, not
  a design change.

## Alternatives considered

**Rename the terms and leave the rest.** Rejected. The smallest possible diff,
but the documents would keep the shape the earlier drafts gave them, and the
setting would still not explain itself to a reader coming cold.

**Graviton as a competitive sport, with darts and drone runners.** Rejected.
The warmest reading of the three, but impact kinetic energy, consolidated hulks
and the debris campaign beat all lose their motivation and would need to be
redesigned rather than reframed. Not worth spending mechanics on framing.
