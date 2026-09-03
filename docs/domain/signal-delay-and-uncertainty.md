# Signal delay and contact uncertainty

Design notes for *Graviton*, a science-fiction strategy game about orbital
mechanics in invented star systems. The astrodynamics here is standard textbook
material. The tuning numbers exist to make a puzzle interesting.

The physical laws Graviton's intercept layer rests on. Every mechanic in the
game is a consequence of something on this page. Read this before changing any
tuning number.

## 1. You cannot beat light, and a relay does not help

Light travels straight. For any relay position `R`, the triangle inequality
gives `d(C,R) + d(R,P) >= d(C,P)`. **A relay can never deliver an observation
sooner than the direct path.** Relays exist in this game for two other reasons
only: to defeat occlusion, and to extend control reach past a transmitter's
power limit. Never present a relay as a latency improvement.

This is worth stating loudly because it is the single most common mistake in
science fiction, and Graviton's credibility depends on getting it right.

## 2. The staleness floor

Let `P` be the clearance post, `M` the probe, `C` the contact.

An order the probe executes was built from an observation of the contact that
was already `d(C,P)/c` old when it reached you, and the order then took
`d(M,P)/c` to reach the probe. So at the instant the probe acts, its picture
of the contact is stale by at least

```
tau_floor = d(C,P)/c + d(M,P)/c
```

For a probe near its contact this approaches the round trip `2*d(C,P)/c`.
Nothing you build, buy or place reduces `tau_floor`. It is geometry.

The staleness that actually matters at intercept is measured from the last
observation you acted on to the moment of impact:

```
tau = t_intercept - t_observation
```

and `tau >= tau_floor` always.

## 3. The uncertainty box

A contact accelerating at `a` for `tau` seconds can be anywhere within roughly

```
r_stale = 0.5 * a * tau^2
```

of its extrapolated position. Add measurement error, which grows with range
because angular resolution is finite:

```
r_meas = sigma_angular * d(C, observer)
r_box  = r_stale + r_meas
```

`r_box` is drawn on the plot as the amber uncertainty ellipse. It is the most
important number in the game.

### Reference magnitudes at one gravity, taken as 10 m/s^2

How large the amber ellipse grows at each range band the campaign uses, for a
fictional craft whose drive is stuck open at one gravity.

| Range to contact | Round trip | `r_stale` |
|---|---|---|
| 5 light-minutes | 10 min | 1 800 km |
| 10 light-minutes | 20 min | 7 200 km |
| 20 light-minutes | 40 min | 28 800 km |
| 40 light-minutes | 80 min | 115 200 km |

Five to forty light-minutes is 0.6 to 4.8 astronomical units. **Ordinary
solar-system distances are correct.** Do not compress the systems to make the
mechanic work; compressing them removes the mechanic.

### The two dials

`r_stale` depends on contact acceleration and on range, and on nothing else.
Those are the two primary difficulty dials for the whole campaign. A contact
settled on a body has `a = 0` and therefore no box at all, which makes it a
pure gravity and geometry problem. A free-flying torch ship running at 1 g at
20 light-minutes generates a box comparable to the radius of an exposure halo.

## 4. The reachable set, and the win condition

A probe with `dv` remaining and `t_go` seconds until intercept can displace
its impact point by roughly

```
r_reach = 0.5 * (dv / t_go) * t_go^2 = 0.5 * dv * t_go
```

subject to its thrust limit, so the true bound is
`r_reach = 0.5 * min(a_max, dv/t_go) * t_go^2`.

> **SUPERSEDED 2026-09-03 → docs/adr/2026-09-03-0005-simulation-numerics.md:**
> spreading the budget evenly is the worst use of it. Correcting once, as early
> as the information allows, gives `r_reach = dv * (t_go - dv / (2 a_max))`
> when `dv <= a_max t_go` and `0.5 a_max t_go^2` otherwise, which is 1.7 to 2.0
> times the value above in the delta-v-limited branch.

This is drawn as the ice-blue reachable ellipse.

> **An intercept is guaranteed when the reachable set contains the uncertainty
> box.**

That single sentence is the design's centre of gravity. Every mechanic in
Graviton is a way to grow the blue ellipse or shrink the amber one, and the
planner exists to let the player see and manipulate exactly that relationship.

## 5. The only escape from the staleness floor

The probe is near the contact. Its own sensors see the contact with staleness
`d(M,C)/c`, which in the terminal phase is seconds. The probe knows more than
the post does, and it cannot tell you in time to matter.

**Onboard conditional clauses are therefore the only mechanism in the game that
beats `tau_floor`.** They collapse `tau` to near zero for the final correction,
but only within the rules the player wrote before launch, and only while
delta-v remains.

This is the player fantasy stated as physics: you are not steering a probe,
you are writing the rules it will follow when it sees what you cannot. Clauses
are deliberately scarce because they are the scarce escape.

## 6. Why gravity and signal delay do not compete

They occupy different phases of the flight.

| | Cruise | Terminal |
|---|---|---|
| Probe speed | 100 to 300 km/s | 100 to 300 km/s |
| Dominant force | Gravity of the bodies | Guidance and exposure |
| Signal delay | Present but irrelevant | Decisive |
| Player activity | Shaping and slingshots | Committing blind |

Gravitational leverage falls off sharply with speed, which is itself a design
lever. A flyby of a Jupiter-class body at one planetary radius deflects a
probe by:

| Cruise speed | Deflection |
|---|---|
| 100 km/s | 17.3 deg |
| 200 km/s | 4.9 deg |
| 300 km/s | 2.2 deg |

So slower probes buy gravitational manoeuvre and faster ones buy a shorter
flight and a smaller box. That is a genuine trade for both the player and the
level designer, and it is the reason the cruise speed band is a tuning
parameter rather than a constant. At the relativistic speeds that would make
delay a large *fraction* of flight time, nothing short of a neutron star bends
anything, and gravity becomes pure decoration.

The ratio of round trip to total flight time is `2v/c` and is independent of
distance. That ratio is a red herring. It is not the mechanic and must not be
used to tune the game. What matters is the absolute delay measured against how
far the contact can move, which is what section 3 computes.

## 7. Occlusion

A signal path blocked by a body is blocked completely. Test the segment from
emitter to receiver against every body sphere plus a grazing margin for
atmosphere and plasma.

Occlusion turns planets into communications terrain and is the reason relays
exist. Uplink availability along a plotted trajectory is predictable from the
ephemeris, so the planner can and must draw the occlusion windows in advance.

## 8. Solving the light-cone intersection

Both solvers below run inside the simulation whenever the game needs to know
when an order lands or when an observation was taken.

**Uplink.** Given emission at `t_e` from post position `x_P(t_e)`, find arrival
time `t_a` satisfying `|x_M(t_a) - x_P(t_e)| = c * (t_a - t_e)`.

**Downlink.** Given reception at `t_r`, find emission time `t_e` satisfying
`|x_M(t_e) - x_P(t_r)| = c * (t_r - t_e)`.

Both converge in two or three Newton iterations because `v << c`. Use a fixed
iteration count and a fixed tolerance so the result is deterministic. Never
loop until convergence.

## 9. Consequences for level design

- Range to the contact sets the floor on difficulty. Nothing the player does
  lowers it.
- Contact agility is the difficulty multiplier. Zero agility means no box.
- Forward rails shorten the uplink leg `d(M,P)/c` and are the player's only
  positional lever on control latency.
- Relays and observers pay for themselves through occlusion and detection
  range, never through latency.
- Terminal delta-v is the brute-force answer and is deliberately expensive.
- A wave covers more of the box than one probe can, and is the answer when the
  box is simply too large.
- Probe sensor range bounds the correction window (`t_go <= sensor_range /
  v_closing`) and therefore the largest box one probe can cover; below a few
  hundred thousand km of range the thrust limit binds and extra delta-v buys
  nothing (ADR-0005).
