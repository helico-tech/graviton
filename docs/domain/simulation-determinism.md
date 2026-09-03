# Simulation determinism contract

Engineering contract for *Graviton*, a science-fiction strategy game about
orbital mechanics in invented star systems.

Graviton's planner promises the player that a plotted trajectory is what will
happen. That promise is only as good as the simulation's determinism, so
determinism is a correctness property here, not a nice-to-have.

Violating anything on this page is a bug of the same severity as a crash.

## The contract

> Given the same level definition, the same seed, and the same ordered command
> log, the simulation produces a bit-identical final state.

Scope for version one: bit-identical on the same binary and the same platform.
Cross-platform bit-identity is a stretch goal, not a requirement, because it
constrains the floating-point strategy heavily.

## Rules

1. **One clock.** An integer tick counter is the only notion of time inside the
   simulation. No wall-clock reads, no frame deltas, no system time.

2. **Fixed timestep.** `dt` is a constant for a level. It never varies with
   framerate, warp factor, load, or machine.

3. **Warp changes work per frame, never `dt`.** Time warp advances more ticks
   per rendered frame. It must never enlarge the timestep. This is the single
   easiest way to destroy the planner's promise and it must be guarded by a
   test.

4. **Deterministic substepping only.** Close flybys need finer integration.
   Derive the substep level from simulation state alone:
   `L = clamp(floor(log2(r_ref / r_nearest)), 0, L_max)`, then integrate
   `2^L` substeps of `dt / 2^L`. Because `L` depends only on state, it is
   deterministic. Never key substepping on wall time, framerate or profiling.

5. **Stable iteration order.** Objects are stored in dense arrays and iterated
   by index. No hash-map or set iteration anywhere in the simulation. No
   parallel reduction without a fixed combination order.

6. **Named random streams.** All randomness comes from explicitly seeded,
   named, per-purpose streams, for example `debris_ejection` and
   `sensor_noise`. Streams are advanced only from inside the simulation, never
   from render or UI code. Drawing from a stream is itself part of the state.

7. **Bounded iteration.** Every numerical solver runs a fixed number of
   iterations to a fixed tolerance. Nothing loops until convergence.

8. **Fully serializable state.** The entire simulation state round-trips
   through serialization with no loss. A level run is
   `(level_id, seed, ordered command log)` and everything else is derived.

9. **Headless.** The simulation runs with no renderer, no window and no audio.
   Tests use it directly, and the planner's forward integration uses the exact
   same code path as the live simulation. Not a copy, not a simplified model.
   The same code.

10. **Render never writes.** The renderer reads simulation state and
    interpolates between ticks for display. It never mutates state, never
    advances time, and never originates a number the player reads as telemetry.

11. **Every displayed number comes from the simulation.** If the player can read
    it, the simulation produced it. No renderer-side estimates.

12. **Signal delay applies to orders and telemetry, never to the ephemeris.**
    Celestial bodies are on published orbits and are always drawn at their true
    current position. Only observations of missiles, mobile targets, defenses
    and debris are delayed.

## The two-tier model

**Tier one, celestial bodies.** Analytic Keplerian ephemerides relative to a
parent. Position at any time `t` is an O(1) closed-form query, so the planner
can jump to an arbitrary future time instantly with no stepping. Bodies do not
perturb each other. That simplification is deliberate: it buys exact
reproducibility, instant future queries and stable levels, and no player will
ever notice its absence.

**Tier two, dynamic objects.** Missiles, debris and free-flying targets, moved
by fixed-step symplectic integration in the field of the tier-one bodies. They
gravitate under tier one, collide with tier-one surfaces and with each other,
and never perturb tier one.

## Required tests

**Golden replay.** A recorded command log replays to an identical final state
hash. One per shipped level, run in continuous integration.

**Ghost invariant.** Commit a plan, run to intercept with no amendments, and
assert the resulting trajectory is bit-identical to the trajectory the planner
drew. This is the test that protects the game's core promise.

**Warp invariance.** The same scenario run at every warp factor produces
identical final state. Catches any leak of warp into `dt`.

**Serialization round-trip.** Save mid-flight, reload, continue, and match the
uninterrupted run bit for bit.

**Substep determinism.** A trajectory that crosses substep-level boundaries
reproduces exactly across repeated runs and across save and reload at points
either side of the boundary.

## Performance shape

The base timestep is chosen per level, and it sets the warp ceiling, because
warp is ticks per wall-second. A one-second timestep would make a multi-week
flight a million ticks and put high warp out of reach. A sixty-second timestep
makes the same flight a few tens of thousands of ticks, which is nothing, and
the substep ladder in rule four still refines close approaches to well under a
second where it matters.

Worked example. At a sixty-second timestep a missile travelling 200 km/s covers
12 000 km per tick, far too coarse near a gas giant. Approaching within 100 000
km of a body with a reference radius of ten million kilometres gives a substep
level of six, so sixty-four substeps of under a second each, and roughly 190 km
of travel per substep. The ladder does its job without any variable timestep.

So: choose the coarsest base timestep the substep ladder can refine adequately
for the tightest flyby the level permits, and validate that choice per level.

With a few hundred dynamic objects the live simulation is cheap, because tier
one is closed-form and tier two is a small N-body problem against a handful of
attractors. Planner scrubbing is the demanding case, since it re-integrates
candidate trajectories interactively. Budget for that specifically: cache ghost
integrations and invalidate them per edited node rather than recomputing the
whole plan on every mouse move.
