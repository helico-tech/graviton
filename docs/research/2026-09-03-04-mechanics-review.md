# Graviton mechanics review: fun, clarity, implementability

Review date 2026-09-03. Reviewed against `docs/README.md`, ADR-0001 (clearance
framing), GAME-0001 (design), GAME-0002 (aesthetic),
`domain/signal-delay-and-uncertainty.md`, `domain/simulation-determinism.md`,
and the concurrent ADR-0005 (simulation numerics) and
`docs/research/2026-09-03-03-level-format-and-solvability.md`, both of which
landed while this review was in progress.

Every number in this document was computed here, not recalled. The working
scripts are `scratchpad/tune.py` and `scratchpad/tune2.py`.

---

## 0. Verdict

The design is unusually coherent for a pre-implementation spec. One
relationship carries the whole game, every mechanic is derived from it, and the
determinism contract is stronger than most shipped games manage. It is
buildable and it can be fun.

Three things are wrong in ways that matter, and one of them is load-bearing.

1. **The central win condition is false as written**, and fixing it requires
   promoting onboard terminal homing from a level-8 unlock to a baseline
   probe capability. This is section 1 and it changes the campaign's shape.
2. **Campaign beat 12 is off by seven orders of magnitude.** A kinetic
   impactor cannot crack a 40 km moonlet. Section 7 gives the fix.
3. **Two of the three scoring terms reward timidity**, which fights the
   design's own stated pressure toward expensive high-energy terminal
   geometry. Section 4.5.

Everything else is tuning, sequencing and interface, and the rest of this
document is that.

---

## 1. The structural finding: terminal homing must be baseline

### 1.1 What the spec claims

> An intercept is guaranteed when the reachable set contains the uncertainty
> box.

This appears in GAME-0001 §2 and in `signal-delay-and-uncertainty.md` §4, and
is described as the design's centre of gravity. As written it is not true, for
three separate reasons.

**Reason one, the existential quantifier.** Containment says that *for every*
position the contact might occupy, *there exists* a control that puts the probe
there. The probe occupies one position at impact and must pick. Containment
therefore describes a set of options, not a plan. Without something that
resolves which option is correct, the probe aims at the box centre and misses
by up to the box radius. Containment is necessary. It is nowhere near
sufficient.

**Reason two, the measurement term never shrinks below the capture radius.**
This is the decisive one and it is easy to miss. The box is
`r_box = r_stale + r_meas` with `r_meas = sigma_angular * d`. Even for a
contact with `a = 0`, so `r_stale = 0`, the measurement term at the campaign's
own range bands is:

| Range to contact | `r_meas` at 2 µrad |
|---|---|
| 20 light-seconds | 12 km |
| 1 light-minute | 36 km |
| 6 light-minutes | 216 km |
| 20 light-minutes | 719 km |

A capture radius is metres to hundreds of metres. **No contact at any range in
this game is ever hittable from the post's picture alone**, agile or not. The
"pure gravity and geometry" levels are not exempt: a fixed contact at one
light-minute still has a 36 km box.

**Reason three, the aiming precision the player would need.** The solvability
prototype measured trajectory sensitivity directly: roughly
**2.8e8 metres of miss per radian of launch heading** over a 10.9-day flight
(`docs/research/2026-09-03-03`, §B.3). Hitting a 250 m capture radius from the
launch drag needs `9e-7 rad`, or 0.00005 degrees, of heading precision. That is
not an interaction. It is not even a numeric-entry interaction at any sane
number of digits.

### 1.2 The fix, and why it improves the design

Give every probe an **always-on terminal homing behaviour**: on acquiring its
assigned contact with its own sensors, the probe steers to intercept using its
own near-live picture, spending up to a fixed **homing reserve** of delta-v.
The reserve is a probe stat. Player-authored clauses do not create homing; they
**raise its authority** to the probe's full remaining delta-v, and they handle
everything homing does not (aborts, exposure, lost track, retargeting, timing).

That single change makes all three problems disappear and makes the central
sentence true, with its precondition stated:

> **Given onboard terminal homing, an intercept is guaranteed when the blue
> reachable set at acquisition contains the amber uncertainty box at
> acquisition — provided the probe also out-accelerates the contact by three to
> one and can pay for its avoidance dodge.**

Three conditions, all of them readable numbers, all of them level-design dials:

| Condition | Test | What it is |
|---|---|---|
| **Coverage** | `r_reach(t_acq) >= r_box(t_acq)` | blue contains amber. The spec's condition. |
| **Agility** | `a_max(probe) >= 3 * a_contact` | see §5.3 |
| **Budget** | `dv >= r_box * v_close / R_acq + 3 * a_c * R_reflex / v_close` | see §5.5 |

### 1.3 Three things this buys

**It makes the blue circle the player's error budget, which solves the
precision problem.** The homing reach at acquisition *is* the aiming tolerance.
The player's drag must land inside blue, not inside the capture radius. With
the tuning in §7 that tolerance is 1,400 to 3,100 km on the fixed-contact
levels, which is 0.3 to 0.6 degrees of launch heading. That is a draggable
number, and it is draggable *because* the game already draws the exact circle
you must hit. The design's central visual turns out to be the answer to its
worst usability problem. Draw the blue circle from level 1, before there is any
amber to compare it to.

**It gives level 8 a real mechanic instead of a new noun.** "Authority" stops
meaning "clauses are now available" and starts meaning "the free reserve
cannot cover this box, so you must delegate your whole remaining budget to a
machine that will spend it while you are 40 minutes out of the loop." That is
the game's thesis, expressed as an arithmetic the player performs. The
numbers in §6 make it exact: baseline reserve covers 600 km of a 3,600 km box;
a clause granting full authority covers 4,195 km.

**It makes the amber collapse visible.** When the clause fires, the probe
swaps the post's box for its own, and the probe's own box is
`0.5 * a_c * (d(M,C)/c)^2`, which at 2e6 km acquisition and 1 m/s² is
**0.02 metres**. Draw both: a large amber ring for the post's knowledge, and a
second, dimmer amber ring for the probe's. At the clause firing the second
collapses to a point. GAME-0002 §7 calls the blue swallowing the amber "the
game's central visual moment"; this is what actually produces it, and it needs
a second amber ring in the aesthetic spec to work.

### 1.4 Consequences for the docs

- `signal-delay-and-uncertainty.md` §5 says clauses are "the only mechanism in
  the game that beats `tau_floor`". Amend: **onboard sensing** beats it, of
  which baseline homing is the free instance and clauses are the
  player-authored extension. The physics is unchanged; the game-design claim
  that follows from it is wrong.
- GAME-0001 §4.5 must gain the homing reserve as a probe stat, and §4.3's
  tracked-properties list must gain `homing_reserve` and make `sensor_range`
  explicitly the acquisition range for terminal homing. ADR-0005 already
  identified probe sensor range as a first-class difficulty dial; this is why.

---

## 2. Fun risks

Ordered by how likely they are to sink the game.

### 2.1 Empty cruise. Severity: highest

The arithmetic is unavoidable. Flight time is `d / v_cruise`, and at the
campaign's own ranges and speeds:

| Range | Flight at 100 km/s | at 200 km/s | at 300 km/s |
|---|---|---|---|
| 1 light-minute | 2.1 d | 1.0 d | 0.7 d |
| 6 light-minutes | 12.5 d | 6.2 d | 4.2 d |
| 20 light-minutes | 41.6 d | 20.8 d | 13.9 d |

Level 8 is a **21-day flight**. Warp-to-event is necessary and nowhere near
sufficient, because the failure mode is not that warping is slow. It is that
the player holds a key through three weeks of nothing and learns that the game
does not need them. Every reference game that got this wrong got it wrong the
same way.

**Warp-to-event is not enough. Six things are needed, and five are cheap.**

1. **Publish the whole event manifest at commit.** Everything schedulable is
   computable from the ephemeris the moment the plan is committed: node
   activations, occlusion window edges, predicted telemetry arrivals, the
   command-horizon crossing of each node's lock point, predicted closest
   approach, halo entry. Draw all of them on the timeline before launch. A
   21-day cruise with eight labelled marks on it reads as a plan. The same
   cruise with an empty bar reads as a wait. This is the single highest-value
   item in this section and it is nearly free, because the planner already
   computes all of it.
2. **Advance-to-event with lookahead, not a warp ladder held down.** Both
   Children of a Dead Earth and Aurora 4X converged on the same shape: the
   player names a target ("advance to next node", "advance 6 hours",
   "advance to impact"), the simulation runs at its fixed timestep, and
   control returns at the first tick that produces new information. Aurora
   additionally *shortens the skip silently* when it can already see an
   intercept coming, and says so in the log. Copy both. GAME-0001 §4.11's warp
   ladder should remain for texture but must not be the primary instrument.
3. **Three interrupt strengths, not two.** Hard pause; clamp to 1× for a few
   seconds without seizing control; log line only. The middle rung is the one
   worth building: it denies the world the right to outrun the player during
   the seconds that matter without taking their hands off the controls.
   GAME-0001 §4.11's "automatic drop to one times" is the middle rung and it
   should be *only* the middle rung, with hard pause reserved for a short
   unsilenceable list (probe loss, order became impossible, impact).
4. **Always point the camera when you slow the clock.** If the game slows down
   for an event and does not show the player which object it happened to, the
   interrupt is a tax. This is a strong consensus finding across the
   reference set.
5. **A cruise digest on every arrival.** Three lines maximum, in the event log:
   what arrived, what changed, what it cost. `T+06:11:02 TELEMETRY PRB-01 ·
   box 3 610 km -> 3 180 km · solution unchanged`. A changing box radius is
   the drip-feed that makes a cruise feel like it is going somewhere. An event
   log of exactly this shape is the most-requested missing feature in the
   game closest to Graviton's genre.
6. **Start some levels mid-flight.** Nothing in the design requires every
   level to begin at launch. "A probe is nine days out, its plan is committed,
   and the survey just changed" is a legitimate and much tighter level opening,
   and it is free in a data-driven level format because the initial state is
   already arbitrary. Use it for at least beats 8 and 10, whose lessons live
   entirely in the last day of a three-week flight.

**One thing to avoid.** Do not fill the cruise with random events. The design's
credibility rests on the player being able to compute everything, and an
unscheduled surprise spends that credibility. GAME-0001 §4.9's "unsurveyed
hazards" is the one sanctioned exception and should stay rare and, crucially,
should always be *survivable by a player who left margin* — otherwise it reads
as the game cheating.

### 2.2 The scale problem is worse than the glyph-plus-ring concession admits

The concession in GAME-0002 §6 is right and honest. It is also aimed at the
wrong objects. Bodies are the *easy* case: they are large, and a glyph with a
true-size ring communicates the lie precisely.

The hard case is that **the geometry the game is about is invisible at the
zoom where the situation is legible.** At a zoom that fits a 20-light-minute
system, a 3,600 km box is 1e-5 of the frame width. At a zoom where amber and
blue are readable, the system is 100,000 screens wide. There is no single zoom
where the player can see both, and no amount of logarithmic zoom fixes it,
because the problem is not the range of zoom but that two things the player
must compare live nine orders of magnitude apart.

**Recommendations.**

- **Extend the minimum-screen-size rule from bodies to the two ellipses**, with
  the same hairline true-size ring. This is already the accepted doctrine in
  §6; it just has not been applied to the objects that need it most. The amber
  and blue circles get a floor of about 40 px radius and a hairline ring at
  their true size. Nothing new is invented and nothing is hidden.
- **Ship a permanent terminal inset, not an optional one.** A second, small
  plot locked to the probe-contact pair, auto-framed at the scale where amber,
  blue and the capture radius are all readable. During the terminal phase it
  becomes the primary view and the system plot becomes the inset. Without this
  the climax of every level happens inside one pixel.
- **Lean on the one-dimensional readouts.** The timeline and the exposure
  strip do not have a scale problem, and GAME-0002 already has both. Add a
  third: a **coverage strip** showing `r_box` and `r_reach` as two traces
  against time along the plotted path, with the crossing marked. That single
  chart answers "is my plan good" better than the plot does, at any zoom, and
  it is the readout the player will actually live in.
- Keep the scale bar and the numeric zoom readout exactly as specified. They
  are what makes the concession honest.

### 2.3 The planner is far too much for level 1

Launch drag, node handles with prograde and lateral components, conditional
clauses, horizon scrub, command horizon, information horizon, uplink band,
exposure strip and a nine-field solution readout is nine systems. Presented at
once it is the documented failure mode of this entire genre: the one
programming game that hands over its whole language up front has a 2.9%
completion rate, and the tuning is not subtle — the games that start at two
rules and add one per mission finish four to six times more players.

**Progressive disclosure must be declared per level in the level file**, as
`ui.enabled: [...]`, and validated. Recommended schedule:

| Beat | Unlocked |
|---|---|
| 1 | launch drag, solution readout (4 fields only), advance-to-event |
| 2 | horizon scrub |
| 3 | launch time selection |
| 4 | rail selection, rotation-phase readout |
| 5 | burn nodes, timeline |
| 6 | (nothing new — consolidation level) |
| 7 | uncertainty box, information horizon, coverage strip |
| 8 | conditional clauses, command horizon, homing-authority control |
| 9 | exposure strip |
| 10 | uplink availability band, relay routing |
| 11 | multi-probe selection, union-of-reach overlay |
| 12 | debris cone preview |

Level 1 must be solvable in under three minutes with one drag. The solution
readout at level 1 should show four numbers, not nine: closest approach,
capture radius, time of flight, delta-v remaining.

### 2.4 The two-ellipse readout is abstract, and the fix is a signed scalar

Comparing two ellipses by eye is not a decision procedure, and
"conf 0.98" in the GAME-0002 mockup is worse than nothing: it is an
unfalsifiable number in a game whose entire pitch is that everything is
computable. Players will not trust it, and they will be right not to, because
it is not a probability — must-have 12 forbids dice rolls, so nothing in this
game *has* a probability.

**Three changes.**

1. **Rename it.** ADR-0005 already fixed the formula as
   `area(box ∩ reach) / area(box)`. That is a **coverage fraction**, not a
   confidence. Label it `COVER 0.98` or `COVERED 98%`. Never "confidence",
   never "probability", never "P(hit)".
2. **Add the signed scalar the player drives to zero.** The most-praised
   feature of the most approachable game in this space is "burn prograde until
   the number disappears". Graviton's equivalent is
   **`COVER MARGIN  -420 km`**, defined as `r_reach - r_box`, displayed on the
   node being edited, updating live as the handle moves, and changing colour as
   it crosses zero. One signed number, monotone in the thing the player is
   dragging. This is the single most valuable interface item in this review
   after the event manifest.
3. **Show both radii as raw numbers too**, as the mockup already does. Keep
   `BOX 3 600 km` and `REACH 4 195 km`. The fraction is for glancing; the
   radii are for reasoning; the margin is for dragging.

### 2.5 Scoring rewards the wrong behaviour

ADR-0001 and GAME-0001 §4.12 both score: contacts cleared, then probes
unexpended, then delta-v remaining.

Delta-v remaining is a **resource, not a virtue**, and rewarding it directly
contradicts §4.9's stated design pressure "toward expensive high-energy
terminal geometry" and §5's framing of delta-v as the thing you spend to cover
the box. A player optimising the published score sheet will under-commit
authority, arrive slow, and lose probes to exposure. Two of the three terms
push the same way.

**Recommendation.**

| Rank | Term | Why |
|---|---|---|
| 1 | Contacts cleared inside the window | unchanged |
| 2 | Time-to-clear as a fraction of the window | rewards decisiveness and commitment, which is the behaviour the game is about |
| 3 | Probes unexpended | genuine efficiency, and it is the currency of the wave levels |
| tiebreak | Delta-v remaining | keep, but only as a tiebreak |

And score on **three mutually exclusive axes with a separate saved solution
slot for each**, rather than one composite rank. Histograms rather than
leaderboards. The failure this avoids is well documented: one save slot for two
competing optima confuses everybody, and players optimise the composite instead
of engaging with the trade.

### 2.6 Decision density is unmeasured and needs a budget

The design has no statement of how many decisions a level contains, and the
range across the twelve beats is enormous: beat 1 has one decision, beat 8 has
six or seven. That is fine as a curve and dangerous as an accident.

**Make it a validated level property.** Declare `decision_points` in the level
file, defined as *moments at which a different player input produces a
materially different outcome*. Target four minimum from beat 5 onward, six to
eight for beats 8, 10 and 11. The validator can partly check this: for each
declared decision point, the reference solution and a perturbed variant must
diverge in outcome. A level that passes with every decision point removed is
not a level.

### 2.7 Two risks specific to a delegated-command game

**Every failure needs a nameable cause.** In a game about acting on bad
information, an unexplained miss is indistinguishable from a bug, and the genre
spends credibility on every inexplicable event. The debrief in §3 step 7 must
not merely replay against ground truth; it must **name the cause** in one line:
`MISS 4 120 km · box exceeded homing authority by 3 000 km at acquisition`, or
`PROBE LOST · exposure 1.00 at T+18:04:11, 312 km from contact, closing
118 km/s (needed 175)`. This is cheap because the simulation knows all of it,
and it is what turns a frustrating loss into a lesson.

**The retry must begin at the interesting moment.** A 21-day flight that fails
in its last hour must not require re-flying 21 days. The command-log run model
in must-have 5 already makes this trivial: offer **rewind to any past decision
point**, replay deterministically to there, and resume. The player's objection
in every game that gets this wrong is never to difficulty; it is to
re-performing the easy part to reach the hard part.

---

## 3. Lessons from the reference set

Condensed to what is actionable. Full research is in the two agent digests
gathered for this review.

### 3.1 Children of a Dead Earth

Closest existing game to Graviton, and its failures are the most directly
transferable material in the survey.

- **Its manoeuvre gizmo is a documented usability autopsy.** Four
  keyboard-bound axes named Radial / Tangential / Out-of-plane / Temporal
  produced a player write-up saying "my brain can't figure this out" and, of
  the fourth axis, "can't find it. Hope I bump into it again." **Name Graviton's
  handles by effect, not by physics**: *arrive earlier / later*, *shift the
  crossing sideways*, *raise the far side*. Put the jargon in a tooltip.
- **It uses advance-until-event, not a warp multiplier**, for exactly the
  reason in §2.1. Independent confirmation of the recommendation there.
- **Its terminal phase is a fixed-rate real-time phase with no pause and no
  abort**, and players logged multi-hour hostage sessions. Graviton's terminal
  phase must have variable rate, pause-with-orders, an always-available abort,
  and slow-motion replay.
- **Its missiles are planned days ahead and intercepted like ships**, which is
  Graviton's core loop, and it works there. Encouraging.

### 3.2 Kerbal Space Program manoeuvre nodes

- **Ship numeric entry next to the handles in v1, not instead of them.** The
  entire KSP mod ecosystem converged on the same specification: per-axis
  steppers with a cycling increment of 0.01 / 0.1 / 1 / 10 / 100 m/s. A
  Graviton node is three scalars. Given the 2.8e8 m/rad sensitivity measured in
  the solvability research, **numeric entry is not a convenience here, it is
  the only way a node can be set accurately at all**, and the same applies to
  the launch drag: it needs a numeric heading and speed field beside it.
- **Placement must be semantic, not free-dragging.** Copy the anchor list:
  *at periapsis · at closest approach · at the target crossing · at the
  command-horizon crossing · at an uplink window edge · after a fixed time*.
  Free dragging cannot hit a specific instant at solar-system zoom, which is
  why every KSP node mod shipped `±orbit` buttons.
- **Re-reference the handle basis to the post-burn trajectory.** This is a
  long-standing KSP bug that two separate mods had to fix independently, and
  it is independently the top complaint about Children of a Dead Earth's
  gizmo. Get it right the first time.

### 3.3 Spaceflight Simulator

- **Its most-praised feature is a single signed scalar the player drives to
  zero.** Direct source of the `COVER MARGIN` recommendation in §2.4.
- **Magnetic snapping on the timeline scrub plus discrete previous/next event
  buttons.** Hitting an exact instant by dragging is not a real interaction;
  event marks must win over the literal cursor position.

### 3.4 Highfleet

- **Build the sensor stack as three anti-correlated axes: range, fidelity,
  exposure.** Highfleet inverts them deliberately — the sensor that reaches
  furthest tells you least. Graviton has the same structure available and
  currently uses only range: post optics give range with poor fidelity
  (`r_meas` grows with distance), a forward observer gives fidelity at the
  cost of a probe, and the probe's own seeker gives near-perfect fidelity but
  only in the last hours. **Make that a stated three-rung ladder** and put the
  detection-range stat on the *contact* as well as the sensor.
- **Publish every range divided by closing speed, so it reads as minutes of
  warning rather than kilometres.** This is the single best presentational
  idea in the survey for Graviton specifically, because every quantity in the
  game is really a time.
- **Ship an explicitly forgiven skip.** Highfleet's auto-intercept resolves the
  intel task instantly, returns a deliberately gap-riddled result, forfeits a
  derived bearing line, and the manual apologises for charging you at all
  ("your time is valuable"). Graviton's equivalent is a one-click "accept the
  post's solution and advance to resolution", which costs information and
  never costs outcome. Players will not use a skip the game makes them feel bad
  about.
- **Let the player annotate the plot.** Highfleet's ruler, compass and
  pencil-with-note are the *pleasure* of its intel layer; leaving all dead
  reckoning manual is separately a documented tooling failure ("Excel is
  basically an essential tool", 257 votes). Render reported position,
  extrapolation and uncertainty as three distinct objects with an explicit
  age-of-information label, **and still let the player draw on top**.

### 3.5 Objects in Space

- **Never let the game seize the clock, and always name the trigger.** Time
  compression was force-held with no stated reason and was the loudest
  complaint about a game whose subject was acting on stale information. The
  community's own fix is correct and cheap: `compression dropped: unidentified
  contact, 40 Gm`, then hand control straight back.
- **Degrade and flag stale contacts; never silently delete them.** Age-of-last-
  contact and a best-ever-trace overlay are both worth copying outright. A
  contact vanishing without a trace teaches nothing. GAME-0001 §4.5's
  `contact lost` clause condition needs this to be legible at all.
- **Ship the "how long until anything can change" estimate on day one.**

### 3.6 Duskers

- **Composing the order should cost time, and the clock should not stop while
  it does** — but note the ceiling: Duskers sits at 89% positive and its
  complaints are entirely about content variety. **A small command vocabulary
  in a real-time frame is not what loses players.** Strong support for keeping
  Graviton's clause language tiny.
- **Build the friction reducers before growing the vocabulary**: autocomplete,
  chaining, whitespace tolerance, and named reusable parameterised orders. The
  player writing their own doctrine and then invoking it under pressure is the
  whole pleasure. Two limits worth keeping deliberately: **no nesting, strictly
  sequential execution.**
- **Price each rung of certainty in a different currency, and never in time
  alone.** This is the trap a signal-delay game is most exposed to: if waiting
  buys certainty, the player waits. In Graviton, waiting genuinely does not
  help — `r_stale` depends on range and agility, not on when you look — but the
  *time window* in §4.12 is what enforces that, so **every level needs a real
  window**, not just the hard ones.
- **Let broken things become instruments.** A probe that has lost its
  transmitter but keeps its seeker, or one out of propellant but still on a
  useful trajectory, should remain usable as an observer. Free depth, and
  on-theme for a clearance post.

### 3.7 Rule-authoring games: Carnage Heart, Gladiabots, Zachtronics, FFXII

This is the most quantitatively useful part of the survey.

- **Ship about six verbs and put all growth in the predicates.** Gladiabots
  reached millions of combinations on roughly seven verbs and sixty-plus
  conditions. Adding a predicate costs the player almost nothing; adding a verb
  costs them a re-plan. Gladiabots players asked for distance comparison,
  memory and sequencing — never for more actions.
- **Start at two rules and add roughly one per mission; cap around twelve.**
  The verified onboarding numbers across the genre are 2, 2, 1 and 2. **The
  cage is what breaks people, not the vocabulary**: the game with a 15-line
  limit finishes 2.9% of players and the one with no limit finishes 14.1%.
- **Evaluate top-down every tick, first true condition fires, exactly one rule
  executes, restart from the top — so ordering is the program.** No event
  handlers, no concurrent firing, and above all no overlapping iterations.
- **Signal delay is Graviton's one expensive concept. Spend the whole
  complexity budget on it and eliminate every other temporal idea.** This was
  the survey's strongest single transferable finding and it should be quoted in
  the spec.
- **Ship the time-scrubbing debugger before the second clause type, and render
  the probe's stale known-world beside the true world.** Gladiabots' most
  praised tool shows what the bot actually sensed; its top negative review
  (387 votes) is that debugging is monotonous, and its second is that players
  "don't know *why* they are losing". **Without an explicit stale-versus-true
  split in the debrief, every delay outcome will read as a bug.**
- **Keep the reference in the game, never in a document.** The game that
  externalised its manual to a 40-page PDF finished 2.4% of players and its
  own reviewers named the PDF as the cause.

### 3.8 Outer Wilds, and dead time generally

- **A transit is only empty if nothing else is scheduled during it.** Outer
  Wilds' clock *produces content*: sand draining, a crust shattering, a probe
  cannon firing. Graviton's equivalent is orbital geometry opening and closing
  windows on its own, which the event manifest in §2.1 makes visible.
- **Steal the campfire's four skip properties verbatim**: roughly 10× rather
  than instant; an on-screen elapsed timer so the player skips *to* a time
  rather than *by* an interval; cancellable at any frame; hard-disabled in the
  terminal seconds where the decisions live.
- **Pause time while reading, with a carve-out for the climax.** A game full of
  reports and rule editing needs exactly this setting and exactly this
  exception.
- **A shortcut that is a scheduled resource keeps its tension; a shortcut that
  is a button loses it.** Outer Wilds' warp towers do not delete the wait, they
  convert it into a timing puzzle on the same clock. Graviton's equivalent
  already exists and is not currently framed this way: **the launch window is
  the shortcut**, and waiting for a better rotation phase or a better relay
  geometry is a scheduled resource.
- **Always acknowledge the order.** There is nothing more paranoia-inducing
  than making a decision and having the game simply carry on. Graviton has a
  beautiful diegetic version of this available for free: the transmit chirp,
  then the two-part countdown `+8m14s SIGNAL / +02:41:10 EXECUTE`, then the
  receipt. GAME-0002 §10 has the sounds; the spec needs the countdown.

### 3.9 The one place the reference set disagrees with the design, and why the design wins

The delayed-command games converge on a comfortable latency band of a few
seconds, and on the finding that above roughly twenty seconds the mechanic
becomes dead air. Graviton's latencies are **40 to 4,800 seconds**, two to
three orders of magnitude outside that band.

The design is right and the reference set does not apply, but only for a
specific reason that must be protected. Those games are **real-time**: the
player sits and waits out the delay. Graviton is a plan-and-scrub game in which
the player spends nearly all wall-clock time paused in the planner, and
simulated minutes cost no wall-clock seconds.

**This converts into a hard constraint, and it is worth stating as a
non-negotiable.** Graviton must never contain a phase in which the player waits
in real time on a light-minute round trip. Concretely: the terminal phase is
resolved by the clause the player already wrote, or under pause-and-scrub, and
never by a real-time hold. The moment any part of the game makes the player sit
through `tau`, the delay stops being the mechanic and becomes the dead air the
reference set warns about.

---

## 4. The five open questions in GAME-0001 §9

### 4.1 Substep parameters — answered, with one addition

**Already resolved by ADR-0005 and the solvability research, and the answer is
measured**: PEFRL, a per-object two-term ladder, `L_max = 10`,
`dt = 60 s` as the ceiling for cruise levels, per-level flyby-convergence
validation. The prototype independently measured that `maxLevel 8` with a 10 Gm
reference radius is adequate at `dt = 30 s` for a 300 km/s flyby and that
`maxLevel 6` is wrong by a factor of twenty. Nothing to add on the numbers.

**One addition, because it is a design-side requirement and the question was
framed as one.** State the acceptance criterion as an **error bound, not a
substep count**, so that it survives changes to the ladder:

> For the tightest flyby a level permits, integrating at the level's `dt` and
> `L_max` must agree with a reference run at `dt/64` to within 1 km of
> downstream position ten days after the flyby, and the level's `dt` is the
> coarsest value that passes.

The 1 km figure is ADR-0005's own acceptance bar and is an order of magnitude
inside the smallest uncertainty box in the campaign, which is the right way to
justify it. The convergence sweep becomes the per-level test the design asks
for. And the ladder must include a **range-to-assigned-contact term**, which
the solvability research found the original rule 4 lacked — ADR-0005 has
already added it.

**One thing neither document states and both need.** Collision must be
**continuous, not sampled**: closest approach on the swept segment solved
analytically from relative velocity, never by testing substep endpoints. At
200 km/s and `dt/2^10` the probe moves 11.7 km per substep, so a 250 m capture
radius is invisible to endpoint sampling and every intercept tunnels straight
through its target. The prototype does this and says so; it belongs in the
determinism contract as a rule, not in a research file as an observation.

### 4.2 Intercept confidence display — show three things, and do not call it confidence

**Recommendation: all three, with a rename.**

- `COVER 0.98` — the area fraction ADR-0005 specifies. For glancing.
- `BOX 3 600 km` / `REACH 4 195 km` — the two radii. For reasoning.
- `COVER MARGIN +595 km` — signed, on the handle being dragged, live,
  colour-changing at zero. For dragging.
- The shaded overlap fill on the plot, as GAME-0002 §7 already specifies. For
  the emotional beat.

**Reasoning.** The three readouts answer three different questions and none
substitutes for another. The rename is not cosmetic: must-have 12 removes all
randomness from probe loss and the determinism contract removes it from
everything else, so **nothing in this game has a probability**, and a number
labelled "confidence" invites the player to read a dice roll into a system that
has none. That is exactly the credibility leak §2.7 warns about. It is a
coverage fraction. Call it coverage.

One caveat on the fraction: `area(box ∩ reach) / area(box)` is a *geometric*
overlap, not a hit likelihood, because the contact is not uniformly distributed
in the box. Do not let the UI imply otherwise, and do not ever multiply it by
anything.

### 4.3 Number of clauses at introduction — three, from a fixed menu of four types, rising to five

**Recommendation.**

| | Value |
|---|---|
| Clause slots at introduction (beat 8) | **3** |
| Cap at end of campaign (beat 12) | **5** |
| Clause *types* available, fixed menu, all unlocked at once | **4** |
| Growth mechanism | more slots, never more syntax |

**Reasoning.** One clause is not a program and teaches nothing about
composition. Two leaves no room for a fallback. Three is the smallest number
that lets the player express the actual authoring idea — *primary correction,
abort condition, fallback* — which is the shape of every real autonomous
flight rule set. The genre's verified onboarding numbers are 2, 2, 1 and 2, but
those are games where a rule is the *only* mechanic; Graviton's clause slots
arrive at beat 8 alongside eight already-learned systems, so starting at three
and rising to five keeps the total cognitive load flat. Above five, evaluation
order starts to matter more than the clauses do and Graviton becomes a
programming game, which it should not be. The strongest single finding in the
rule-authoring survey applies directly: signal delay is the one expensive
concept, and every other temporal idea should be eliminated to pay for it.

**The fixed menu of four.** Exactly the conditions GAME-0001 §4.5 already
lists, which is the right set:

1. `when closest_approach < X` → execute node N. Terminal authority. The one
   that matters.
2. `when exposure_rate > X` → execute node N. Abort or veer.
3. `when contact_lost for > T` → execute node N. Search or coast.
4. `when t_elapsed > T` → execute node N. Deadman timer.

**Evaluation semantics, which the spec does not yet state and must.** Checked
once per tick before integration, top to bottom in declaration order, **first
true condition fires and exactly one clause executes per tick**, each clause
latching after it fires. Ordering is therefore the program, which is one
sentence of explanation and is how the most widely played rule system in
existence works. Forbidden in v1: boolean composition, arithmetic, cross-probe
state, loops, and any clause that fires another clause.

**Two supporting items that are not optional.**

- **Rule sets must be named, saved and assignable to a whole wave** from the
  moment clauses exist. The game that made players reprogram every unit by hand
  lost 35 points of review score immediately after its tutorial, and its
  sequel's headline fix was moving reuse tools to the start.
- **The debrief must show what the probe actually sensed**, beside the truth.
  Without the stale-versus-true split, every clause outcome reads as a bug.

### 4.4 Debris collateral — a visible ledger, never a failure state

**Recommendation: count it, show it, predict it, and score it only in beats 11
and 12.**

- Debris chunks that intersect an inhabited body are counted and named in the
  debrief: `LANE RESIDUE · 3 chunks -> KERWEN STN`.
- No level fails because of residue.
- Residue costs score **only in the two beats that are about debris**, where it
  is the lesson rather than a tax.
- **The planner draws the predicted debris cone before commit**, as a shaded
  arc with the bodies it intersects highlighted.

**Reasoning.** The spec deferred this as "a likely source of frustration" and
that instinct was right, but the frustration comes entirely from the third
bullet's absence, not from the mechanic. Punishing a player for an ejection
pattern they could not see is unfair; punishing them for one the planner drew
for them is a puzzle. Since the pattern is deterministic and derived from
impact geometry, drawing it is cheap. Recording residue costs nothing and gives
beat 12 its meaning. Making it fatal converts a good mechanic into the failure
mode the spec already identified.

### 4.5 Free play and data-driven levels — data from day one, no editor in v1

**Already decided and correctly**: `docs/research/2026-09-03-03` settles the
format as YAML authoring compiled to canonical JSON, validated with valibot,
with per-level recorded command logs replayed in CI as solvability evidence,
and an automated solver that finds a level's launch solution in 41 seconds.
Nothing to revisit.

**The design half of the question, which that research does not answer:
does the campaign need a free-play mode?**

**Recommendation: yes, and it costs almost nothing. Ship a sandbox level, not
an editor.**

- A **sandbox** is a level file with generous budgets, several rails, no time
  window and every UI system enabled. Zero new code. It gets most of free
  play's value immediately and it is the place players will go to understand
  the coverage relationship without a clock.
- An **in-game editor** is a v2 feature. It needs a schema-driven form, live
  validation, and a solver run to prove the result is winnable, and none of
  that should compete with the campaign for v1 effort.
- **Levels shipping as data makes the twelve campaign beats authorable and
  provable without a rebuild**, which is the deciding argument, and it is the
  same argument as the solvability proof. Those are one artifact.

**One addition to the level format for the reasons in this review.** The
schema should carry `ui.enabled` (§2.3), `decision_points` (§2.6), the
reference solution's `par` for medal thresholds (§2.5), and a **negative
solution log** that must *fail*. A bug that makes every intercept succeed
would otherwise pass all twelve golden replays.

---

## 5. Terminal guidance, defined precisely

This section answers the spec's implicit question: what does "reached" mean.

### 5.1 Capture

```
r_capture = r_contact + r_effect(probe)
```

`r_effect` is a probe stat with a default of **250 m**, justified in fiction as
a shroud that opens shortly before impact and releases a bundle of penetrators
— standard equipment for lane clearance, and the reason a clearance probe is
not simply a bullet. A pass with minimum separation at or below `r_capture` is
a hit and delivers the probe's full kinetic energy. Above it, a clean miss.
No partial credit, no grazing, no probability. Deterministic and readable.

**Display it.** `CAPTURE 250 m` sits beside the closest-approach readout, so
the player always knows what miss distance counts. The GAME-0002 mockup
currently shows `PCA 1 204 km` in a panel implying a solved intercept; at any
sane capture radius that is a miss by four orders of magnitude. Either the
mockup's numbers change or a reader will conclude that kilometre-scale closest
approaches are hits.

**Two implementation requirements.**

- Minimum separation is solved **analytically on the swept segment** from
  relative position and velocity, once per substep, never by sampling
  endpoints. See §4.1.
- `r_capture` is **not** the player's aiming tolerance. The blue reach circle
  is. See §1.3. This distinction is what makes a 250 m capture radius fair.

### 5.2 The avoidance reflex, as a deterministic rule

ADR-0001 constrains this correctly: a derelict's collision avoidance is
frequently the last system still working, so the behaviour must read as reflex
and never as intent. That rules out pursuit, prediction and feints, and it
happens to make the rule simple.

```
Collision-avoidance reflex, per tick, per contact:

  trigger    any tracked object whose projected minimum separation is
             below r_avoid within the next t_avoid seconds, using
             straight-line relative motion from the contact's own
             near-live picture

  response   thrust at the contact's full available acceleration a_c,
             along the in-plane direction perpendicular to the line of
             sight, on the side away from the approaching object's
             offset; ties broken toward the plane's positive normal

  duration   continuous while triggered; no memory, no refractory period

  detection  the reflex sees nothing beyond R_reflex, a per-contact stat
```

**Why this is the right rule.** It is one sentence, it is deterministic, the
planner can integrate it, and it is **exploitable in three distinct ways**,
which is what turns it from a difficulty tax into a mechanic:

1. **Herding.** Because the dodge direction is a known function of the
   approach offset, a first probe can trigger the reflex deliberately and a
   second can aim where the dodge will put the contact. This gives beat 11 a
   mastery ceiling above simply tiling the box.
2. **Terrain.** The player can choose an approach whose dodge direction pushes
   the contact into an exposure halo, into a body, or usefully out of the lane
   — which in a clearance game may itself be a win.
3. **Speed.** The dodge costs the probe delta-v proportional to `1/v_close`,
   so closing fast buys it off. See §5.5.

**Level-design constraint on `R_reflex`.** This is the parameter that decides
whether the reflex is affordable, and it must be small:

```
R_reflex <= dv_dodge_reserve * v_close / (3 * a_c)
```

At beat 8's numbers — 60 m/s of reserve, 200 km/s closing, 1 m/s² of contact
agility — the ceiling is **4,000 km**. Setting `R_reflex` to tens of thousands
of kilometres makes the dodge cost hundreds of metres per second and the level
unwinnable, and it will not be obvious why. **The level validator should check
this inequality**, because it is the kind of tuning error that produces an
unsolvable level that looks fine.

### 5.3 The agility margin, and where three-to-one comes from

Proportional navigation with navigation constant `N'` against a target holding
a constant lateral acceleration `a_T` settles at a commanded acceleration of

```
n_c = N' / (N' - 2) * a_T
```

which gives the required accelerations directly:

| `N'` | Required `a_probe / a_contact` |
|---|---|
| 3 | 3.00 |
| 4 | 2.00 |
| 5 | 1.67 |
| 6 | 1.50 |

Fixing `N' = 3`, the standard choice, gives the design rule:

> **A probe needs three times the contact's acceleration to guarantee terminal
> capture.**

This is a real result rather than a game balance number, it is a single
readable ratio, and it gives the level designer a clean dial. Display it:
`AGILITY 18.0 / 1.0 = 18x` beside the contact's stats, with the 3× threshold
marked. Higher `N'` reduces the required margin but increases sensitivity to
measurement noise, which is a v2 conversation, not a v1 stat.

*Provenance note.* The `N'/(N'-2)` relation is standard guidance-analysis
algebra and the derivation stands on its own. The commonly quoted "three to
five times the target's acceleration" engineering heuristic could not be
re-verified in this session because the team's shared web-search budget was
exhausted. The algebra above is what the recommendation rests on.

### 5.4 How a clause plus a terminal burn actually closes the intercept

The sequence, with the quantity that governs each step:

| Step | What happens | Governed by |
|---|---|---|
| 1 | Post commits a plan aimed at the box centre. | `r_box` at commit |
| 2 | Cruise. Nodes trim. Last amendable node passes its lock point. | command horizon |
| 3 | Probe acquires the contact with its own sensor at range `R_acq`. Its own staleness is `R_acq/c`, seconds. | `R_acq` |
| 4 | Clause 1, `closest_approach < R_acq`, fires. Node T executes with full remaining authority. | clause slot |
| 5 | Probe corrects onto the true position. Cost `r_box * v_close / R_acq`. | coverage term |
| 6 | Contact's reflex triggers at `R_reflex`. Probe re-corrects under PN. Cost `3 * a_c * R_reflex / v_close`. | dodge term |
| 7 | Minimum separation compared to `r_capture`. | §5.1 |

Step 3 is why probe sensor range is a first-class difficulty dial, as ADR-0005
independently concluded: the coverage cost in step 5 scales as `1/R_acq`, so
doubling acquisition range halves the delta-v needed to cover the same box.
That is the counter-intuitive lesson beat 8 should teach.

### 5.5 The terminal budget identity

Steps 5 and 6 combine into one formula, which is the most useful single
equation for tuning any level with a mobile contact:

```
dv_terminal = r_box * v_close / R_acq  +  3 * a_c * R_reflex / v_close
                  coverage term              dodge term
```

**The two terms pull closing speed in opposite directions**, which is what
makes it a real trade rather than a slider:

| Beat 8 closing speed | Coverage | Dodge | Total |
|---|---|---|---|
| 100 km/s | 180.0 | 90.0 | 270.0 m/s |
| 150 km/s | 270.0 | 60.0 | 330.0 m/s |
| 200 km/s | 359.9 | 45.0 | 404.9 m/s |
| 250 km/s | 449.9 | 36.0 | 485.9 m/s |
| 300 km/s | 539.9 | 30.0 | 569.9 m/s |

Across the campaign's 100–300 km/s band the coverage term dominates, so
**slower closing is always cheaper in terminal delta-v**. Four things oppose
it: flight time, exposure survival (which imposes a hard speed *floor*, §7.9),
disruption energy, and the uncertainty box's insensitivity to speed. Gravity
assist leverage is the only other thing that favours slow.

That two-sided squeeze — a delta-v ceiling above and a speed floor below — is
the best tuning structure in the design, and it should be stated explicitly in
GAME-0001 §5 as a difficulty dial in its own right. A level is tuned by
choosing how narrow the window between them is.

### 5.6 Worked example: beat 8, "Authority"

**Setup.**

| Parameter | Value |
|---|---|
| Range to contact | 20 light-minutes = 3.598e8 km |
| Round trip | 40 min = 2,400 s |
| Contact agility `a_c` | 1.0 m/s² |
| Contact reflex range `R_reflex` | 3,000 km |
| Angular resolution `sigma` | 2 µrad |
| Cruise and closing speed | 200 km/s |
| Flight time | 20.8 days |

**The box at acquisition.**

```
r_stale = 0.5 * 1.0 * 2400^2       = 2 880 km
r_meas  = 2e-6 * 3.598e8 km        =   719 km
r_box                              = 3 600 km
```

**Two probes are offered and the interesting one is not the obvious one.**

| | Sensor probe | Heavy probe |
|---|---|---|
| Acquisition range `R_acq` | 2.0e6 km | 0.5e6 km |
| Delta-v at arrival | 420 m/s | 700 m/s |
| `a_max` | 18 m/s² | 30 m/s² |
| `t_go` at acquisition | 10,000 s | 2,500 s |
| Reach with full authority | **4,195 km** | 1,742 km |
| Coverage cost | **360 m/s** | 1,440 m/s |
| Covers the box? | **yes, +595 km margin** | no, short by 740 m/s |

The heavy probe has 67% more delta-v and fails, because coverage cost scales as
`1/R_acq` and it acquires four times later. **Acquisition range beats delta-v.**
That is a genuine, counter-intuitive, physically true lesson and it is exactly
the right thing for the campaign's hardest teaching level to be about.

**The clause is what makes it work.**

| Homing authority | Reach at `t_go` = 10,000 s | Covers 3,600 km box? |
|---|---|---|
| Baseline reserve, 60 m/s | 600 km | **no, short by 6×** |
| Full authority via clause, 420 m/s | 4,195 km | **yes** |

The level is unwinnable with the free reserve and winnable with one clause that
delegates the whole budget. The clause is not flavour; it is the difference
between 600 km and 4,195 km.

**The complete budget.**

```
coverage        3 600 km * 200 km/s / 2.0e6 km  = 360.0 m/s
dodge           3 * 1.0 * 3 000 km / 200 km/s   =  45.0 m/s
                                        total   = 405.0 m/s
available at acquisition                        = 420.0 m/s
margin                                          =  15.0 m/s
```

**Fifteen metres per second of margin.** A player who wastes twenty in cruise
misses. That is the level.

**Agility check.** `a_max / a_c = 18 / 1.0 = 18`, comfortably above the 3×
threshold, so terminal capture is guaranteed once the budget is paid.

**The clause set the player should end up writing** — three slots, and each one
earns its place:

```
1  when closest_approach < 2 000 000 km  ->  node T: full authority, home
2  when exposure_rate > 0.002 /s         ->  node A: abort, veer 40 m/s lateral
3  when contact_lost for > 600 s          ->  node C: coast on last solution
```

**Recommended level grants.** Budget 450 m/s rather than 420, which widens the
viable closing-speed window to roughly 190–225 km/s. Fifteen metres per second
of margin is a good final-boss number and a punishing first-teaching number.

---

## 6. Minimal v1: what to simplify, what not to cut

Costs stated, and forward-compatibility stated, since the deciding question is
whether a simplification can be added later without invalidating level files.

### 6.1 Simplify

| Simplification | Cost | Add later without breaking level files? |
|---|---|---|
| **Reach is a circle.** One radius. | None. Reach genuinely is isotropic in v1. | Yes — a second radius is an added optional field. |
| **Box is an ellipse with exactly two radii, aligned to the observer's line of sight.** No rotation state, no covariance matrix. | Small: one extra field over a circle. **Recommended over the circle ADR-0005 chose**, see §6.3. | Yes either way. |
| **Clauses are a fixed menu of four types** with no composition. | Loses expressive authoring. Genuinely a gain, per §4.3. | Yes — a fifth type is an added enum value. |
| **Rings and belts are drawn, and act as an exposure field, not as simulated objects.** | Loses individually dodgeable rocks. Nobody will notice. | Yes — a belt becomes a spawner. |
| **Relays and observers are fixed level furniture, not player-placed.** | Loses a placement decision. Beat 10 still works: routing through a given relay is the decision. | Yes — placement is a new command type. |
| **No chunk-to-chunk collision.** Chunks hit bodies, probes and contacts only. | Nothing visible. Removes an O(n²) pass. | Yes — but it changes debris outcomes, so **it would invalidate beat 12's recorded solution**. Decide now and do not revisit. |
| **Drop presented cross-section from exposure**; keep flux and dwell only. | See §6.3 — this needs resolving against ADR-0005. | Yes. |

### 6.2 Do not cut

- **Signal delay on orders and telemetry.** The game.
- **The amber-and-blue pair, and the coverage relationship.** The game.
- **Onboard terminal homing.** Now load-bearing, per §1. Without it nothing is
  ever hittable.
- **Player-authored clauses.** Without them beat 8 has no mechanic and the
  pitch — "you are writing the rules it will follow" — is not true of anything.
- **Finite burns at maximum thrust.** Tempting to make impulsive, and it should
  not be. They cost almost nothing, because the integrator is stepping anyway
  and ADR-0005 has already specified the analytic final partial stage. They are
  load-bearing for `a_max`, which is load-bearing for the 3× agility rule and
  for the `r_reach` formula's thrust-limited branch. **Keep.**
- **True-scale simulation.** Compressing distance removes the mechanic, exactly
  as the domain doc says.
- **Deterministic exposure and the command-log run model.** These are what make
  the solvability proof and the debrief possible.

### 6.3 Two v1 questions that ADR-0005 answered differently, and are worth a second look

Both were decided while this review was in progress. Neither is wrong; both
have a design-side consideration the numerics work would not have surfaced.

**Circles versus a two-radius box.** ADR-0005 chose circles in v1 with
"per-axis measurement error reserved". The physics is asymmetric: `r_stale` is
isotropic, but `r_meas` is transverse only — angular resolution gives bearing
error, not range error, and a range estimate from optical tracking alone is far
worse than the bearing. So the honest box is an ellipse **elongated along the
line of sight**, and it needs no rotation state because its axis is always the
observer-to-contact direction. The cost is one extra field and a
point-in-ellipse test instead of a radius comparison.

What this buys as a mechanic is worth more than it costs: **"you know its
bearing, not its range"** is an immediately intuitive form of ignorance, it
makes a forward observer's contribution geometrically obvious rather than
arithmetic, and it makes the choice of approach bearing matter — cross the box
along its short axis. Recommend revisiting for v1. If it stays a circle, use
the transverse radius, not the mean, or the levels will be tuned optimistically.

**The obliquity factor in the exposure law.** ADR-0005 specifies
`rate = k * chi(psi) / max(r, r_core)^2`. The `chi(psi)` term needs a
definition, and the two available readings pull opposite ways. If `psi` is
**path** obliquity, it double-counts: the chord integral of `1/r^2` along a
straight pass already gives `pi * k / (b * v)`, which is exactly "fast and far
survives" with no extra term. If `psi` is **probe attitude** relative to the
flux, it needs an attitude model that v1 does not have and GAME-0001 §4.3 does
not list.

Recommend either dropping `chi` for v1, or defining it explicitly as the angle
between velocity and the range vector to the halo centre under a
velocity-aligned attitude assumption, and stating that assumption in
GAME-0001 §4.3. The closed forms in §7.9 are what the planner should display
either way, and they are exact without `chi`.

---

## 7. The twelve campaign beats

Ranges are deliberately short in the early beats. Nothing in the design ties
range-to-contact to system size, and the spec's "five to forty light-minutes"
describes **separations between bodies**, not the distance to every contact.
Beats 1 to 6 should sit at 0.3 to 5 light-minutes so their flights are hours
to days rather than weeks. This should be stated in GAME-0001 §4.1, because a
reader will otherwise place beat 1 at five light-minutes and hand a tutorial a
seven-day flight.

Shared conventions: `sigma = 2 µrad`; box radius is `r_stale + r_meas`; reach
is at acquisition with the authority stated; baseline homing reserve is 60 m/s.

### 7.1 Intercept

**Key decision.** One launch heading. Nothing else.

**Failure it teaches.** That the plot is a prediction, and that the blue circle
is the tolerance you must land inside. Nothing more.

**Numbers.** Contact: a mass parked at a co-orbital station, `a_c = 0`, range
20 light-seconds (5.94e6 km), so the box is `r_meas` only at **11.9 km**.
Probe: 200 m/s, `a_max` 12 m/s², `R_acq` 1e6 km, cruise 100 km/s. Flight
**0.7 d**. Reach at acquisition **1,998 km**, so the aiming tolerance is
**0.4 degrees of heading**. Decision points: 1. Par: cleared, one probe.

**Note.** The contact must be genuinely static relative to the rail — a
co-orbital station at the same orbital radius, not a body on a different orbit
— or the level accidentally teaches beat 3's lesson. Choose the geometry
deliberately.

### 7.2 Gravity

**Key decision.** Heading, plus which side of the giant to pass.

**Failure it teaches.** A straight aim misses, because the path bends.

**Numbers.** Range 45 light-seconds (1.349e7 km). Gas giant: 1.9e27 kg,
70,000 km radius. Cruise **80 km/s** — deliberately slow, because ADR-0005
established that only gas giants bend a 100 km/s probe usefully and an
Earth-class body gives 0.7 degrees. At a periapsis of 140,000 km and 80 km/s
the deflection is **16.1 degrees**, which is unmissable on the plot. Box
**27 km**, reach 3,122 km, flight **2.0 d**. Decisions: 2.

### 7.3 Lead

**Key decision.** Lead angle, and launch time.

**Failure it teaches.** Aim where it will be. The moon travels roughly 3e6 km
during the flight.

**Numbers.** Contact settled on a moon of the giant, moon orbital speed
~13 km/s, period ~1.8 d. Range 1.2 light-minutes. Cruise 120 km/s, flight
**2.1 d**. Box **43 km**, reach 2,081 km. Decisions: 3.

**Level-validator note.** The solvability research found a contact on a body
surface can be geometrically unreachable, with an optimiser stalling at a hard
419 km floor because the host moon occluded its own surface point. **A fixed
contact sited on a body needs its approach hemisphere open during the window,
and the validator must check it** rather than leaving an author to discover it
as a failing search. This beat is where that check first matters.

### 7.4 Rotation

**Key decision.** Which of the next launch windows to take.

**Failure it teaches.** The rail points where the host's spin points it.

**Numbers.** Host: 5,000 km radius, 8 h rotation. Surface speed 1,091 m/s.
Bearing sweeps at **45 degrees per hour**. Range 1.5 light-minutes, cruise
120 km/s, flight 2.6 d. Box 54 km. Decisions: 3.

**This beat has a design hole and needs one addition.** The inherited surface
velocity is 1,091 m/s against a 120 km/s departure — a **0.5 degree** bend.
Rotation as specified is therefore nearly cosmetic. **Rails need a launch cone
fixed to the rail's local frame**, recommended ±30 degrees about the local
vertical, which turns the host's rotation into an **80-minute window every
8 hours** and makes the beat real. Add `launch_cone` to the rail definition in
GAME-0001 §4.2.

**And it is the campaign's weakest beat even then**, because its content is
waiting and waiting is this design's largest fun risk. Fix it by making the
windows non-equivalent: one early window whose bearing is right but whose
inherited orbital velocity points the wrong way, one later window with the
opposite problem, and a time limit that admits only two of the four. Then it is
a choice rather than a wait.

### 7.5 Budget

**Key decision.** When to place the mid-course node.

**Failure it teaches.** The most important quantitative fact in the game:
**a correction costs `offset / t_go`, so burns are cheaper the earlier they
happen.**

**Numbers.** Range 3 light-minutes (5.396e7 km), cruise 140 km/s, flight
**4.5 d**. Budget 400 m/s. Tune so the direct solution needs about 520 m/s and
launch-plus-node needs about 380. Box 108 km, reach 2,853 km. Decisions: 4.
Unlocks burn nodes and the timeline.

**Best-placed beat in the campaign.** Everything from beat 7 onward is an
application of the identity this beat teaches.

### 7.6 Slingshot

**Key decision.** Periapsis distance at the flyby, and therefore the whole
downstream trajectory.

**Failure it teaches.** Gravity is free delta-v that costs time and demands
precision at periapsis.

**Numbers.** Range 5 light-minutes (8.994e7 km), cruise **90 km/s**, delta-v
only **150 m/s** and a rail cone that makes the direct departure vector
unreachable. Flight **11.6 d**. Box 180 km, reach 1,666 km. Decisions: 4.

**Make this the timestep-validation level.** It is the tightest flyby the
campaign permits and therefore the level whose `dt` most needs the convergence
sweep from §4.1. The solvability research measured a solution found at
`dt = 1800 s` carrying 3,300 km of error when replayed at `dt = 30 s`, and one
ladder rung *regressing* from 0.001 km to 63,642 km, so **the solver must keep
the best result across all rungs rather than trusting the last**. This beat is
where that bites.

**Fun risk.** 11.6 days with four decisions is the campaign's thinnest
decision density. Either raise cruise speed and weaken the assist, or add a
scheduled event in the outbound leg — an occlusion window, a survey update —
so advance-to-event has somewhere to land.

### 7.7 Staleness

**Key decision.** Closing speed, which sets `t_go` at acquisition and therefore
whether the free homing reserve can cover the box.

**Failure it teaches.** The box exists, and it is *nearly* too big.

**Numbers.** First mobile contact. `a_c = 0.3 m/s²`, range 6 light-minutes
(1.079e8 km), round trip 12 min.

```
r_stale = 0.5 * 0.3 * 720^2   =  77.8 km
r_meas  = 2e-6 * 1.079e8 km   = 215.9 km
r_box                         = 293.6 km
```

Baseline reserve 60 m/s, `R_acq` 1e6 km, closing 150 km/s, `t_go` 6,667 s,
reach **399.9 km** against a **293.6 km** box. Covered with 27% margin, at a
cost of 44 of the 60 free metres per second. Flight 8.3 d. Decisions: 5.

**This beat exists to make the box visible without demanding a new mechanic,
and the tuning must be deliberate about that.** It is tuned so the free reserve
just covers the box. Slow down and it does not. That is the whole lesson, and
it sets beat 8 up perfectly.

### 7.8 Authority

Fully worked in §5.6. Range 20 light-minutes, `a_c = 1.0 m/s²`, box 3,600 km,
baseline reach 600 km, full-authority reach 4,195 km, budget 450 m/s against a
405 m/s requirement. Flight 20.8 d. Decisions: 6 to 7.

**This is the vertical-slice target.** It exercises every system in the game,
its lesson is counter-intuitive and true, and if it is fun the game is fun.
Build it second, immediately after beat 1.

**Its fun risk is the 21-day flight.** Apply §2.1's mid-flight start: open the
level with a probe nine days out and a survey that just changed.

### 7.9 Exposure

**Key decision.** Arrival speed. There is a hard floor and the player must
find it.

**Failure it teaches.** Slow and close does not survive.

**Numbers.** Fixed wreck, `a_c = 0`, so no box beyond `r_meas` at 144 km.
Range 4 light-minutes, cruise 250 km/s, flight 3.3 d, budget 350 m/s.

Halo: `r_core` 50 km, `R_halo` 20,000 km, `k = 2.19e9` SI. Two closed forms
follow, and both should be displayed in the planner:

```
clean flyby, miss distance b:   E = pi * k / (b * v)
pass through the centre:        E ≈ 4 * k / (r_core * v)
```

| Impact closing speed | Exposure at impact | Outcome |
|---|---|---|
| 80 km/s | 2.19 | lost |
| 120 km/s | 1.46 | lost |
| 150 km/s | 1.17 | lost |
| 175 km/s | 1.00 | **threshold** |
| 200 km/s | 0.88 | survives |
| 250 km/s | 0.70 | survives |
| 300 km/s | 0.58 | survives |

**`v_min = 4k / r_core = 175 km/s`.** One threshold, computable, displayed on
the exposure strip as a speed floor rather than only as an accumulating bar.
And the halo is properly terminal: a flyby at 5,000 km accumulates 0.0055, so
it only matters in the last few hundred kilometres. Decisions: 4.

**Keep this beat to one idea.** Do not also give the wreck a minimum
disruption energy. That is beat 12's material.

### 7.10 Occlusion

**Key decision.** Three real options, which makes this the best-shaped level in
the campaign: place the mid-course node before the blackout and accept a worse
aim point; route through the relay and accept a *longer* round trip; or spend a
clause slot on a deadman timer and commit blind.

**Failure it teaches.** The relay defeats occlusion and costs you latency. It
never saves you time. This is the beat where the design's loudest physical
commitment becomes a mechanic the player feels.

**Numbers.** Range 10 light-minutes, `a_c = 0.5 m/s²`, box **720 km**, cruise
180 km/s, flight 11.6 d, budget 300 m/s. Decisions: 5.

**Structural note.** The terminal geometry here is easy — reach is 2,000 km
against a 720 km box — so occlusion must bite in the **cruise**, not the
terminal phase. Build this beat as beat 5 plus a blackout: a mandatory
mid-course node whose only viable window is occluded for four hours by the
giant. The relay route adds genuine path length and therefore genuine extra
delay, which the planner must display as such.

### 7.11 Wave

**Key decision.** How to tile the box with four reach discs, and whether to
spend one probe on herding instead.

**Failure it teaches.** Some boxes are simply too large for one probe, and
covering a disc with discs is a packing problem.

**Numbers.** Retuned from a first pass that required six probes. `a_c = 1.6
m/s²`, range 15 light-minutes:

```
r_stale = 0.5 * 1.6 * 1800^2  = 2 592 km
r_meas                        =   540 km
r_box                         = 3 132 km
per-probe reach at 300 m/s    = 2 248 km
ratio                         = 1.39
```

Minimum covering of a disc by equal discs gives the thresholds `R/r <= 1.155`
for three, `1.414` for four, `1.641` for five. **1.39 needs four probes**, with
five granted so one can be spent on herding or held in reserve. Cruise
200 km/s, flight 15.6 d. Decisions: 6.

**Build the union-of-reach overlay.** Four blue discs against one amber
ellipse, with uncovered area shaded, is a novel and immediately legible
interface moment and it is the whole level. Without it the player is doing
circle packing by eye.

**Mastery ceiling.** The herding play from §5.2: send one probe to trigger the
reflex on a known side, aim the others at the dodge. Do not require it. Reward
it in the score.

### 7.12 Debris

**This beat is physically impossible as written, by seven orders of
magnitude.**

A 40 km moonlet at 2,000 kg/m³ has a mass of 5.36e17 kg and a gravitational
binding energy of **2.88e20 J**. A 600 kg impactor at 250 km/s delivers
**1.88e13 J**, which is 4.5 kilotonnes and is **15 million times too little**.
The imparted velocity change is 2.8e-10 m/s. Nothing happens. A kinetic
impactor cannot crack a 40 km moonlet, and no plausible number of probes
changes the order of magnitude.

**The fix keeps the beat intact and only changes one noun.** What a probe can
actually disrupt, at a catastrophic-disruption specific energy of 100 J/kg for
a weak rubble body:

| Impactor | Energy | Disruptable mass | Radius at 2,000 kg/m³ |
|---|---|---|---|
| 600 kg at 250 km/s | 1.88e13 J | 1.88e11 kg | **282 m** |
| 250 kg at 200 km/s | 5.0e12 J | 1.0e10 kg at 500 J/kg | 88 m at 3,500 kg/m³ |

**Replace the moonlet with a 250 m rogue body.** Everything else survives:

- One heavy probe at 250 km/s disrupts a 250 m body of 1.31e11 kg. There is
  even a genuine energy threshold to clear, which gives the beat its
  minimum-closing-speed constraint, exactly as beat 9 has one.
- Sixteen chunks of roughly 15 m, ejected in a fixed cone of 25 degrees
  half-angle about the impact normal at 5 to 20 m/s, spread **3,450 to
  13,800 km over eight days** — a usable sweep width against a cluster of
  derelicts spread over a few thousand kilometres.
- Each chunk is about 3.5e6 kg, so against a 500-tonne derelict at 10 m/s
  relative it is decisive. The sweep works.

**Numbers.** Range 8 light-minutes, cruise 250 km/s, flight 6.7 d, five
derelicts spread over ~6,000 km. Decisions: 5.

**Hard requirement, or replace the beat.** The planner must draw the predicted
debris cone before commit, with intersected bodies highlighted, per §4.4. The
cone is a deterministic function of impact geometry, so this is cheap — but
without it the beat is a guess, and a guess is not a finale.

**Fallback if the cone preview slips.** Replace with **Consolidated hulk**: a
target requiring three impacts above a disruption threshold, taught as a wave
with an energy budget rather than a delta-v budget. At 500 J/kg and 250 kg
impactors at 200 km/s, three impacts disrupt 3e10 kg, which is a 260 m metal
object — and "decades of collisions welding a debris pile together" is exactly
what *consolidated* should mean, so the fiction supports the number. Lower
implementation risk, keeps the finale about compounding, and it needs no new
system at all.

### 7.13 Summary table

| Beat | Range | `a_c` | Cruise | Flight | Box | Reach | Decisions | Unlocks |
|---|---|---|---|---|---|---|---|---|
| 1 Intercept | 20 ls | 0 | 100 | 0.7 d | 12 km | 1,998 km | 1 | launch drag |
| 2 Gravity | 45 ls | 0 | 80 | 2.0 d | 27 km | 3,122 km | 2 | scrub |
| 3 Lead | 1.2 lm | 0 | 120 | 2.1 d | 43 km | 2,081 km | 3 | launch time |
| 4 Rotation | 1.5 lm | 0 | 120 | 2.6 d | 54 km | 2,496 km | 3 | rails, cone |
| 5 Budget | 3 lm | 0 | 140 | 4.5 d | 108 km | 2,853 km | 4 | nodes |
| 6 Slingshot | 5 lm | 0 | 90 | 11.6 d | 180 km | 1,666 km | 4 | — |
| 7 Staleness | 6 lm | 0.3 | 150 | 8.3 d | 294 km | 400 km | 5 | box, coverage strip |
| 8 Authority | 20 lm | 1.0 | 200 | 20.8 d | 3,600 km | 4,195 km | 6–7 | clauses |
| 9 Exposure | 4 lm | 0 | 250 | 3.3 d | 144 km | 1,397 km | 4 | exposure strip |
| 10 Occlusion | 10 lm | 0.5 | 180 | 11.6 d | 720 km | 1,998 km | 5 | uplink band, relay |
| 11 Wave | 15 lm | 1.6 | 200 | 15.6 d | 3,132 km | 2,248 km ×4 | 6 | union overlay |
| 12 Debris | 8 lm | 0 | 250 | 6.7 d | 288 km | 1,198 km | 5 | cone preview |

Beats flagged as needing work: **4** (rotation is cosmetic without a launch
cone, and the beat is a wait), **6** (11.6 days, four decisions), **12**
(physically impossible as written).

---

## 8. Recommended amendments, in priority order

**P0 — the design is wrong without these.**

1. **GAME-0001 §2 and `signal-delay-and-uncertainty.md` §4 and §5.** State the
   win condition's precondition and add the agility and budget conditions.
   Promote onboard terminal homing to a baseline probe capability with a
   `homing_reserve` stat; reframe clauses as raising its authority. §1.
2. **GAME-0001 §6 beat 12.** Replace the 40 km moonlet with a 250 m rogue
   body, or adopt the consolidated-hulk fallback. §7.12.
3. **`simulation-determinism.md`.** Add a rule requiring continuous collision
   detection: minimum separation solved analytically on the swept segment, not
   sampled at substep endpoints. §4.1 and §5.1.

**P1 — the game is not fun without these.**

4. **GAME-0001 §4.11.** Make advance-to-event with lookahead the primary time
   instrument, add the three interrupt strengths, and require the full event
   manifest to be published on the timeline at commit. §2.1.
5. **GAME-0001 §4.6 and the level schema.** Add per-level UI progressive
   disclosure as `ui.enabled`. §2.3.
6. **GAME-0002 §7, §8 and GAME-0001 §4.6.** Rename intercept confidence to
   coverage, add the signed `COVER MARGIN`, add the coverage strip, and fix the
   mockup's `PCA 1 204 km`. §2.4, §4.2, §5.1.
7. **GAME-0001 §4.12 and ADR-0001.** Demote delta-v remaining to a tiebreak and
   promote time-to-clear. Score on three separately saved axes. §2.5.
8. **GAME-0002 §6.** Extend the minimum-screen-size and true-size-ring rule to
   the two ellipses, and make the terminal inset mandatory. §2.2.
9. **GAME-0001 §4.2.** Add `launch_cone` to rails, or beat 4 has no mechanic.
   §7.4.

**P2 — needed before the levels are authored.**

10. **GAME-0001 §4.8.** Specify the avoidance reflex as the deterministic rule
    in §5.2, with `R_reflex` as a contact stat, and add the validator check on
    the `R_reflex` ceiling.
11. **GAME-0001 §4.5.** Fix the clause count at three rising to five, the menu
    at four types, and state the evaluation semantics. §4.3.
12. **GAME-0001 §5.** Add the terminal budget identity and the closing-speed
    squeeze as a named difficulty dial. §5.5.
13. **GAME-0001 §4.1.** State that range-to-contact is independent of system
    size and that beats 1 to 6 sit at 0.3 to 5 light-minutes. §7.
14. **Level schema.** Add `decision_points`, `par`, and a negative solution log
    that must fail. §2.6, §4.5.
15. **GAME-0001 §3 step 7.** Require the debrief to name the cause of each
    failure in one line, and to show the probe's own stale picture beside the
    truth. §2.7, §3.7.
16. **Resolve the two ADR-0005 v1 choices** in §6.3: the two-radius box, and
    the definition or removal of the exposure obliquity factor.

**P3 — worth filing, not worth blocking on.**

17. Numeric entry beside every drag handle, with the 0.01/0.1/1/10/100 stepper
    ladder, and semantic node placement anchors. §3.2.
18. Rewind-to-decision-point retry. §2.7.
19. Named, saved, wave-assignable clause sets. §4.3.
20. Player plot annotation: ruler, bearing, note. §3.4.
21. Range readouts expressed as minutes of warning alongside kilometres. §3.4.
22. Sandbox level. §4.5.

---

## 9. Issues worth filing

Following the working agreement that observations outside the current unit get
filed rather than fixed inline. Suggested priorities.

| Priority | Issue |
|---|---|
| P0 | Win condition stated without its terminal-homing precondition; no contact is hittable from the post's picture at any campaign range |
| P0 | Campaign beat 12 is physically impossible; kinetic impactor versus 40 km moonlet is short by 7 orders of magnitude |
| P1 | Collision detection is unspecified and will tunnel through every target at substep resolution |
| P1 | Scoring rewards delta-v conservation, contradicting the design's own stated terminal-geometry pressure |
| P1 | Rotation beat has no mechanic without a rail launch cone |
| P1 | No progressive disclosure; nine planner systems available at beat 1 |
| P1 | 21-day cruise at beat 8 with no scheduled events |
| P2 | "Intercept confidence" implies a probability in a game with no randomness |
| P2 | Avoidance reflex is undefined; `R_reflex` can silently make a level unsolvable |
| P2 | Clause evaluation semantics unspecified |
| P2 | Aesthetic mockup shows a 1,204 km closest approach as a solution |
| P2 | Fixed contacts on body surfaces can be geometrically unreachable; validator check missing |
| P3 | Exposure obliquity factor `chi(psi)` undefined and possibly double-counting path geometry |
| P3 | Ellipses have no minimum screen size, so the game's central comparison is sub-pixel at system zoom |
