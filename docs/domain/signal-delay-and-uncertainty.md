# Signal delay and target uncertainty

Design notes for *Graviton*, a science-fiction strategy game about orbital
mechanics in invented star systems. The astrodynamics here is standard textbook
material. The tuning numbers exist to make a puzzle interesting.

The physical laws Graviton's tactical layer rests on. Every mechanic in the
game is a consequence of something on this page. Read this before changing any
tuning number.

## 1. You cannot beat light, and a relay does not help

Light travels straight. For any relay position `R`, the triangle inequality
gives `d(T,R) + d(R,P) >= d(T,P)`. **A relay can never deliver an observation
sooner than the direct path.** Relays exist in this game for two other reasons
only: to defeat occlusion, and to extend command reach past a transmitter's
power limit. Never present a relay as a latency improvement.

This is worth stating loudly because it is the single most common mistake in
science fiction, and Graviton's credibility depends on getting it right.

## 2. The staleness floor

Let `P` be the command post, `M` the missile, `T` the target.

An order the missile executes was built from an observation of the target that
was already `d(T,P)/c` old when it reached you, and the order then took
`d(M,P)/c` to reach the missile. So at the instant the missile acts, its picture
of the target is stale by at least

```
tau_floor = d(T,P)/c + d(M,P)/c
```

For a missile near its target this approaches the round trip `2*d(T,P)/c`.
Nothing you build, buy or place reduces `tau_floor`. It is geometry.

The staleness that actually matters at intercept is measured from the last
observation you acted on to the moment of impact:

```
tau = t_intercept - t_observation
```

and `tau >= tau_floor` always.

## 3. The uncertainty box

A target accelerating at `a` for `tau` seconds can be anywhere within roughly

```
r_stale = 0.5 * a * tau^2
```

of its extrapolated position. Add measurement error, which grows with range
because angular resolution is finite:

```
r_meas = sigma_angular * d(T, observer)
r_box  = r_stale + r_meas
```

`r_box` is drawn on the tactical plot as the amber uncertainty ellipse. It is
the most important number in the game.

### Reference magnitudes at one gravity, taken as 10 m/s^2

How large the amber ellipse grows at each range band the campaign uses, for a
fictional vessel sustaining one gravity.

| Range to target | Round trip | `r_stale` |
|---|---|---|
| 5 light-minutes | 10 min | 1 800 km |
| 10 light-minutes | 20 min | 7 200 km |
| 20 light-minutes | 40 min | 28 800 km |
| 40 light-minutes | 80 min | 115 200 km |

Five to forty light-minutes is 0.6 to 4.8 astronomical units. **Ordinary
solar-system distances are correct.** Do not compress the systems to make the
mechanic work; compressing them removes the mechanic.

### The two dials

`r_stale` depends on target acceleration and on range, and on nothing else.
Those are the two primary difficulty dials for the whole campaign. A target
bolted to a body has `a = 0` and therefore no box at all, which makes it a pure
gravity and geometry problem. A free-flying torch ship at 1 g at 20
light-minutes generates a box comparable to a point-defense radius.

## 4. The reachable set, and the win condition

A missile with `dv` remaining and `t_go` seconds until intercept can displace
its impact point by roughly

```
r_reach = 0.5 * (dv / t_go) * t_go^2 = 0.5 * dv * t_go
```

subject to its thrust limit, so the true bound is
`r_reach = 0.5 * min(a_max, dv/t_go) * t_go^2`.

This is drawn as the ice-blue reachable ellipse.

> **A hit is guaranteed when the reachable set contains the uncertainty box.**

That single sentence is the design's centre of gravity. Every mechanic in
Graviton is a way to grow the blue ellipse or shrink the amber one, and the
planner exists to let the player see and manipulate exactly that relationship.

## 5. The only escape from the staleness floor

The missile is near the target. Its own sensors see the target with staleness
`d(M,T)/c`, which in the terminal phase is seconds. The missile knows more than
the command post does, and it cannot tell you in time to matter.

**Onboard conditional clauses are therefore the only mechanism in the game that
beats `tau_floor`.** They collapse `tau` to near zero for the final correction,
but only within the doctrine the player wrote before launch, and only while
delta-v remains.

This is the player fantasy stated as physics: you are not steering a missile,
you are writing the doctrine it will follow when it sees what you cannot.
Clauses are deliberately scarce because they are the scarce escape.

## 6. Why gravity and signal delay do not compete

They occupy different phases of the flight.

| | Cruise | Terminal |
|---|---|---|
| Missile speed | 100 to 300 km/s | 100 to 300 km/s |
| Dominant force | Gravity of the bodies | Guidance and point defense |
| Signal delay | Present but irrelevant | Decisive |
| Player activity | Shaping and slingshots | Committing blind |

Gravitational leverage falls off sharply with speed, which is itself a design
lever. A flyby of a Jupiter-class body at one planetary radius deflects a
missile by:

| Cruise speed | Deflection |
|---|---|
| 100 km/s | 17.3 deg |
| 200 km/s | 4.9 deg |
| 300 km/s | 2.2 deg |

So slower missiles buy gravitational manoeuvre and faster ones buy a shorter
flight and a smaller box. That is a genuine trade for both the player and the
level designer, and it is the reason the cruise speed band is a tuning
parameter rather than a constant. At the relativistic speeds that would make
delay a large *fraction* of flight time, nothing short of a neutron star bends
anything, and gravity becomes pure decoration.

The ratio of round trip to total flight time is `2v/c` and is independent of
distance. That ratio is a red herring. It is not the mechanic and must not be
used to tune the game. What matters is the absolute delay measured against how
far the target can move, which is what section 3 computes.

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

- Range to target sets the floor on difficulty. Nothing the player does lowers it.
- Target agility is the difficulty multiplier. Zero agility means no box.
- Forward batteries shorten the uplink leg `d(M,P)/c` and are the player's only
  positional lever on control latency.
- Relays and observers pay for themselves through occlusion and detection
  range, never through latency.
- Terminal delta-v is the brute-force answer and is deliberately expensive.
- Salvos cover more of the box than one missile can and are the answer when the
  box is simply too large.
