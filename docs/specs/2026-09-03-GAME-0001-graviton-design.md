---
status: accepted
date: 2026-09-03
id: GAME-0001
supersedes: none
---

# Graviton — game design

A two-dimensional science-fiction game of ballistic trajectories and orbital
mechanics, played on a traffic-control display in an invented star system,
where paths obey real gravity and orders travel at the speed of light.

Physics this design depends on: `docs/domain/signal-delay-and-uncertainty.md`.
Engineering contract: `docs/domain/simulation-determinism.md`.
Visual and audio language: `2026-09-03-GAME-0002-graviton-aesthetic.md`.
Why the setting is what it is: `docs/adr/2026-09-03-0001-clearance-framing.md`.

## 1. Pitch

Traffic between habitats runs on fixed lanes, and things get into those lanes:
derelicts still under uncommanded thrust, rogue bodies on crossing orbits, the
scattered debris of older accidents. You run a clearance post.

The objects are minutes of light away. By the time you see one it has already
moved, and by the time your order arrives it has moved again.

**You are not steering a probe. You are writing the rules it will follow when
it sees what you cannot.**

## 2. The central geometry

Every intercept resolves to two ellipses on the plot.

The **uncertainty box**, in amber, is where the contact could be, given how long
ago you saw it and how hard it can accelerate. Its size is set by range and by
contact agility, and nothing the player does lowers the floor.

The **reachable set**, in ice blue, is where the probe can still put its
impact point, given remaining delta-v and time to go.

> An intercept is guaranteed when the reachable set contains the uncertainty
> box.

The planner exists to let the player see and manipulate that relationship. Every
mechanic below is a way to grow the blue ellipse or shrink the amber one.

## 3. Core loop

1. **Brief.** One paragraph. The system, the contacts, the constraints.
2. **Survey.** Pan and zoom the plot. Inspect bodies, contacts, hazards.
3. **Plan.** Pick a rail, drag a launch vector, refine with burn nodes,
   write conditional clauses.
4. **Commit.** Launch at a chosen time. The clock runs.
5. **Amend.** Telemetry arrives stale. Corrections depart and arrive late.
6. **Resolve.** Impact, miss, or probe loss. Debris.
7. **Debrief.** Replay against ground truth and see what you did not know.

## 4. Systems

### 4.1 Celestial systems

Invented systems, not Sol. Each level ships its own: a primary, two to six
bodies, moons, stations, occasional rings or belts. Bodies ride analytic
Keplerian orbits and are rendered as three-dimensional spheres rotating on
their real periods within the two-dimensional orbital plane.

Separations run five to forty light-minutes, which is 0.6 to 4.8 astronomical
units. Ordinary solar-system scale. Masses, radii and rotation periods are
whatever the level needs, within physically sane ranges.

Simulation is always true scale. The rendering concession for legibility is
described in the aesthetic spec and is visibly signposted, never hidden.

### 4.2 Launch rails

Probes launch from fixed rails sited on bodies or stations. A rail inherits its
host's rotation and orbital velocity, so:

- Launch bearing sweeps with the host's spin, which makes the launch window a
  rotation phase the player must wait for or plan around.
- The host's orbital velocity is free delta-v, and its direction matters.
- Rail placement is the player's only positional lever on control latency,
  because a forward rail shortens the uplink leg.

Levels may offer several rails, which enables waves arriving on separated
bearings.

### 4.3 Probes

Tracked properties: dry mass, propellant mass, effective exhaust velocity,
maximum thrust, sensor range, transmitter range, impactor mass.

Delta-v follows from mass and exhaust velocity, and mass is tracked through
burns so impact kinetic energy is physically real. Impact energy drives both
fragmentation and debris generation.

Typical cruise speed is 100 to 300 km/s. Slow enough that gravity genuinely
shapes the trajectory, fast enough for intercepts measured in days rather than
months.

### 4.4 Flight plans and burn nodes

A probe carries a flight plan loaded at launch and executed autonomously.

A **burn node** is an activation time plus a prograde component and a lateral
component in metres per second, executed as a finite burn at maximum thrust.
Burns are finite, not impulsive, and the planner integrates them as such.

A node is amendable only if its activation time is later than the moment an
order sent now would reach the probe. Locked nodes are dimmed and refuse
edits, with the reason shown. As the probe travels further from the post, the
lock point slides further ahead of it, so control weakens exactly as precision
starts to matter.

### 4.5 Conditional clauses

A probe carries a small, level-limited number of onboard clauses of the form
*when condition, execute node*. Conditions available include closest approach
to the assigned contact dropping below a threshold, exposure rate crossing a
threshold, contact lost, and time elapsed.

Clauses are the only mechanism in the game that beats the staleness floor,
because they let the probe act on its own near-live sensor picture. They are
scarce for exactly that reason, and they are the answer to a box too large to
cover with delta-v alone.

### 4.6 Planner mode

An overlay on the live plot, never a separate screen. Time may be paused or
warped while planning.

- **Launch drag.** Drag heading and speed off a rail and watch the predicted
  path integrate live against the moving system.
- **Node handles.** Place nodes on the path and drag prograde and lateral
  handles. Locked nodes are visibly inert.
- **Horizon scrub.** Drag a horizon time and the whole plot jumps there. Bodies
  are exact from the ephemeris; dynamic objects are predicted.
- **Command horizon.** A permanent overlay showing where an order sent now can
  first arrive.
- **Information horizon.** The edge of what you currently know. Objects beyond
  it draw as extrapolations inside their uncertainty ellipse.
- **Uplink availability band.** Occlusion windows along the plan, predicted from
  the ephemeris, drawn on the timeline.
- **Exposure strip.** Cumulative exposure along the plotted path, so the player
  can see exactly where the probe would be lost.
- **Solution readout.** Closest approach, miss distance, arrival speed, time of
  flight, delta-v remaining, impact energy, intercept confidence.

The planner's forward integration is the live simulation's code path. A
committed plan with no amendments produces the ghost exactly, and that is
enforced by test.

### 4.7 Signal delay

The clearance post sits at a fixed location. Orders take `d/c` to reach a probe
and telemetry is `d/c` old on arrival. Both are solved as light-cone
intersections with a fixed iteration count.

Bodies block signals completely, which makes planets into communications
terrain. Relays and forward observers defeat occlusion and extend detection
range. **They never reduce latency**, because light travels straight and a
relay path is never shorter than the direct one. The game must never imply
otherwise.

Observers do shrink the measurement-error term of the uncertainty box, because
angular resolution degrades with range. A close observer collapses that term
while leaving the staleness term untouched.

### 4.8 Contacts

**Fixed contacts** sit on bodies or stations: a wreck settled on a moon, a mass
parked where it should not be. They ride a known ephemeris, so they have no
uncertainty box at all. These levels are pure gravity and geometry.

**Mobile contacts** are free-flying craft under thrust — most often a derelict
whose drive is stuck open. Their agility, from gentle to about one gravity
sustained, is the campaign's main difficulty multiplier.

A mobile contact may run avoidance of its own. On a derelict, collision
avoidance is frequently the last system still working, and it shies away from
anything closing on it. That is reflex, not intent: nothing in Graviton opposes
the player, and there is no opponent in version one.

### 4.9 Hazards

Passive. The system is indifferent, not adversarial. Nothing in Graviton shoots
at anything.

**Exposure halos.** A radius around a contact within which a probe accumulates
exposure. The accumulation rate rises with flux, which falls with the square of
range, and is modulated by presented cross-section and by dwell time. The probe
is lost when exposure reaches one. This is deterministic accumulation, not a
dice roll, so the player can compute survivability in the planner and the
outcome is reproducible. Fast and oblique survives. Slow and head-on does not.
The pressure is therefore toward expensive high-energy terminal geometry.

A halo is a physical fact about the object, not a defence: a breached reactor,
the debris cloud shed by a tumbling hulk, the plasma sheath of a body still
venting.

**Consolidated hulks.** Require a minimum impact kinetic energy before they
break up or leave the lane, which forces high closing speed or multiple
impacts.

**Debris streams.** Raise the exposure rate across a region. Route around them
or accept the cost.

**Unsurveyed hazards.** A halo the player has not observed forming is a
surprise, and news of its onset arrives late. By the time you know, the probe
is committed.

### 4.10 Debris

An impact above a fragmentation energy threshold ejects a bounded number of
chunks, at most twenty-four, with count and ejection pattern derived
deterministically from impact geometry and a named random stream.

Chunks are dynamic objects. They gravitate under the bodies, collide with
surfaces where they are absorbed, and collide with probes and contacts. Total
live chunks are capped per level, with deterministic culling of the oldest and
of anything leaving the play volume.

Debris is both hazard and opportunity. Some levels are built around cracking a
moonlet to sweep a cluster of derelicts out of a lane.

### 4.11 Time control

The simulation always has a present moment. The player may pause, run at one
times, or warp along a fixed ladder of powers of ten. Warp advances more ticks
per frame and never changes the timestep.

The warp ceiling is bounded by how many ticks per wall-second the simulation can
afford, so the base timestep is chosen per level to make the ceiling generous.
Cruise levels use a coarse base timestep in the range of ten to sixty seconds,
and the deterministic substep ladder refines automatically during close
approaches. A multi-week flight at a sixty-second timestep is a few tens of
thousands of ticks in total, which makes very high warp cheap. Picking the base
timestep is a per-level design act and must be validated against the tightest
flyby that level permits.

**Automatic drop to one times** on events of interest: telemetry arrival, node
execution, exposure onset, closest approach, impact. Without this the player
will warp straight past the decisions the game is about.

**Warp to event** jumps to the next telemetry arrival, node, uplink window or
closest approach. This is the primary way players move through a multi-day
cruise.

### 4.12 Constraints and scoring

Each level grants a number of probes, a delta-v budget per probe, a number
of conditional clauses, and a time window during which a contact can still be
cleared usefully.

Score on contacts cleared within the window first, then on probes unexpended
and delta-v remaining. Rank thresholds per level.

## 5. Difficulty dials

In rough order of impact.

| Dial | Effect |
|---|---|
| Range to contact | Sets the floor on the uncertainty box. Irreducible. |
| Contact agility | Multiplies the box. Zero agility means no box at all. |
| Delta-v budget | How much of the box the probe can cover directly. |
| Conditional clauses | How much authority may be delegated past the light floor. |
| Hazard density | Constrains terminal geometry and raises the delta-v cost. |
| Occlusion geometry | When the player is allowed to talk at all. |
| Probe count | Whether a wave can cover a box one probe cannot. |
| Time window | Removes the option of waiting for better geometry. |
| Body layout and masses | How much of the trajectory gravity does for free. |

## 6. Campaign

Twelve teaching beats, one idea each, in an order that builds. Thin framing:
each is a clearance job with a one-paragraph brief and a debrief. No characters,
no dialogue. The interface is the voice.

1. **Intercept.** Fixed contact, one rail, gravity negligible.
2. **Gravity.** The path must bend around a body to reach the contact.
3. **Lead.** A contact riding a moving body. Still perfectly known.
4. **Rotation.** Rail on a spinning host. The launch window is a phase.
5. **Budget.** A mid-course correction is required to close the intercept.
6. **Slingshot.** Not enough delta-v to go direct. A flyby is mandatory.
7. **Staleness.** First free-flying contact under thrust. The box appears.
8. **Authority.** The box exceeds the reachable set. First conditional clauses.
9. **Exposure.** A wreck with a halo. Terminal geometry starts costing.
10. **Occlusion.** The uplink is blocked at the critical moment. Relay needed.
11. **Wave.** Several probes on separated bearings covering one box.
12. **Debris.** Crack a moonlet to sweep a cluster of derelicts.

## 7. Must-haves

Non-negotiable. All are testable, and the details live in the determinism
contract.

1. Deterministic fixed-timestep simulation. Same seed and command log gives a
   bit-identical result.
2. Warp changes ticks per frame and never the timestep.
3. The planner integrates using the live simulation's code path, and the ghost
   invariant is enforced by test.
4. Celestial bodies are analytic and O(1) queryable at arbitrary time.
5. A level run is an initial state plus an ordered command log. Replay, undo,
   save and debrief all derive from that.
6. No wall-clock, no unordered iteration, no unnamed randomness in the
   simulation.
7. The simulation runs headless.
8. The renderer never writes simulation state.
9. Every number the player reads originates in the simulation.
10. Signal delay applies to orders and telemetry, never to the ephemeris.
11. Debris count is bounded and deterministic.
12. Probe loss is deterministic exposure accumulation, never a dice roll.
13. Physical simulation is always true scale. Legibility concessions live in
    the renderer and are visibly signposted.

## 8. Non-goals for version one

Out-of-plane motion. Relativity beyond signal delay. N-body perturbation among
the celestial bodies. An active adversary of any kind. Procedural level
generation. Multiplayer. Base building, research trees or an economy. Narrative
characters.

## 9. Open questions

These need answers before or during implementation planning, and none of them
block the technology decision.

- The substep reference radius and the maximum substep level, which together
  decide whether a coarse base timestep is safe. These must be validated
  numerically against the tightest flyby any level intends to allow, and that
  validation should itself be a test.
- Whether intercept confidence is shown as a number, a shaded overlap area, or
  both.
- How many conditional clauses feel right at the point of introduction, and
  whether the cap should rise across the campaign.
- Whether debris should ever be scored against inhabited bodies as collateral,
  which was considered and deferred as a likely source of frustration.
- Whether the campaign needs a free-play or scenario editor mode, and if so
  whether level definitions should therefore be data rather than code from the
  start. Leaning strongly toward data regardless.
