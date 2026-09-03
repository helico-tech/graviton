# Graviton simulation core: numerics

Research note for `docs/specs/2026-09-03-GAME-0001-graviton-design.md` and
`docs/domain/simulation-determinism.md`. Language-agnostic, but every number
here was measured in IEEE-754 binary64 and cross-checked in both CPython 3.12
and Node 24 (V8), which is the arithmetic TypeScript will have.

Date: 2026-09-03. All probe scripts and their raw output live under
`scratchpad/research/sim-probe/`.

---

## 0. Recommendations, and where the design documents are wrong

### Recommendations

| Component | Recommendation |
|---|---|
| Kepler solver | Danby starter `E0 = M + 0.85 e sign(sin M)` plus **exactly 3 Danby–Burkardt quartic corrections**. 3 `dsincos` calls. Max error 1.8e-15 rad for e <= 0.6, 4.4e-15 for e <= 0.9. |
| Transcendentals | Own `dsin`, `dcos`, `dsincos`, `datan`, `datan2`, `dacos`, `dexp`, `dlog` from fdlibm kernels. Measured <= 1.3 ulp. Bit-identical between CPython and V8 on 18/18 test values. |
| Integrator | **PEFRL** (Omelyan–Mryglod–Folk 4th-order symplectic, 4 force evaluations per step). Beats velocity Verlet by 2-3 orders of magnitude and RK4 by ~8x at equal cost. Verlet **cannot** meet the accuracy bar at any affordable substep level. |
| Substep ladder | Replace the single distance ladder with the **max of a dynamical-time ladder and a crossing-time ladder**, both per body, both computed with a comparison loop and no logarithm. `eta = 0.05`, `zeta = 1/32`, `L_max = 10`. |
| Base timestep | `dt = 60 s` is safe for every flyby tested, including a grazing Earth-class pass at 300 km/s. `dt = 120 s` is not. |
| Light cone | 3 Newton iterations, no tolerance test. 2 already reach the double-precision fixed point. |
| Exposure | Add a **core radius** and accumulate with the **per-substep closed form**, not a point sample. |
| State hash | FNV-1a-style twin-lane 32-bit hash over raw doubles, with `-0` collapsed to `+0`. 0.16 ms for 60 000 doubles. |
| RNG | sfc32 seeded from splitmix32 per named stream. 803 Mdraws/s. |
| Warp ceiling | 84 000 ticks/s for 50 objects at `dt = 60`, which is 60 simulated days per wall second. Warp x1 000 000 costs 3.3 ms per frame. Generous, as the design hoped. |

### Confirmed correct in the design documents

- **Deflection table** (`signal-delay-and-uncertainty.md` section 6). A grazing
  Jupiter-class flyby deflects **17.315 / 4.863 / 2.213 degrees** at 100 / 200 /
  300 km/s. The document says 17.3 / 4.9 / 2.2. Exact match, and the quoted
  cruise speed is correctly the speed at infinity, not at periapsis.
- **`r_stale` table** (section 3). 1 800 / 7 200 / 28 800 / 115 200 km at 5 / 10 /
  20 / 40 light-minutes and 10 m/s^2. All four exact.
- **Light-minutes to AU.** 5 lm = 0.601 AU, 40 lm = 4.81 AU. Correct.
- **"Two or three Newton iterations"** for the light cone (section 8). Correct,
  and generous: two suffice.

### Corrections needed

1. **`r_reach` is a factor of ~2 too small.** The document gives
   `r_reach = 0.5 * min(a_max, dv/t_go) * t_go^2`, which assumes the thrust is
   spread evenly over the whole interval. That is the *worst* way to spend the
   budget. Correcting once, as early as the information allows, displaces the
   impact point twice as far:

   ```
   r_reach = dv * (t_go - dv / (2 * a_max))      if dv <= a_max * t_go
   r_reach = 0.5 * a_max * t_go^2                otherwise
   ```

   The two agree exactly in the thrust-limited branch and differ by 1.7x to
   2.0x in the delta-v-limited branch, which is the branch a mid-course
   correction actually lives in. Details and a table in section 6.

2. **The substep ladder as specified under-refines by a factor of 1.5 in the
   exponent, and its reference radius is not a property of the level.**
   `L = floor(log2(r_ref / r_nearest))` is linear in `log r`, but the
   requirement is `h <= eta sqrt(r^3/mu)`, which is 1.5x steeper. The
   worked example compensates by choosing `r_ref = 1e7 km`, twenty-five times
   larger than needed near Jupiter and still 24x more expensive than necessary
   near an Earth-class body. It also ignores mass, so a moon and a gas giant at
   the same range get the same refinement. Section 4 gives a drop-in
   replacement that is still integer-valued, still state-only, still
   logarithm-free, and 6x to 13x cheaper while still clearing the accuracy bar
   by two orders of magnitude.

3. **The ladder must be per object, and dynamic objects must not attract each
   other.** Neither document says so. If the level were the maximum over all
   objects, a ghost integrated alone would take different substeps from the
   same probe integrated in a crowd, and the ghost invariant would fail. This
   is a one-line requirement with a load-bearing consequence.

4. **Exposure as specified diverges at the contact**, so with a pure `1/r^2`
   flux any probe that actually strikes a haloed contact accumulates unbounded
   exposure and is always lost first, roughly 330 km and 1.6 seconds short of
   impact. Section 7 proposes a core radius that makes the law finite and turns
   the head-on case into the intended speed trade.

5. **`Math.sqrt` is assumed correctly rounded but the ECMAScript specification
   does not require it.** Every production engine emits the hardware
   instruction, which IEEE-754 does require to be correctly rounded, so the
   assumption is safe in practice. Make it explicit with a startup self-check
   (section 8).

---

## 1. Kepler solver

Version one is 2D and in-plane, elliptical orbits only, so the whole ephemeris
is `M -> E -> (r, v)`.

### 1.1 Fixed-iteration solution of `M = E - e sin E`

The contract forbids looping until convergence, so the solver must be a fixed
straight-line computation. Two families were measured against a 60-digit
`decimal` reference over 512 mean anomalies per eccentricity
(`p2_kepler.py`, `p3b_reduction_and_kepler.py`).

**Starters**

| Name | Formula | Trig cost |
|---|---|---|
| `S_M` | `E0 = M` | none |
| `S_lin` | `E0 = M + e sin M` | one pair |
| `S_danby` | `E0 = M + 0.85 e sign(sin M)` | **none** |
| `S_ng` | `E0 = M + e sin M / (1 - sin(M+e) + sin M)` | two pairs |
| `S_mik` | Mikkola's cubic | one pair plus a cube root |

`S_danby` is free because for `M` reduced to `[0, 2pi)` the sign of `sin M` is
just `M < pi`. That is the whole reason to prefer it.

**Correctors** (each costs one `sin`/`cos` pair)

- Newton, order 2.
- Halley, order 3.
- **Danby–Burkardt, order 4**: three nested corrections sharing one trig pair.

```
sE, cE = dsincos(E)
f0 = E - e*sE - M
f1 = 1 - e*cE
f2 = e*sE
f3 = e*cE
d1 = -f0 / f1
d2 = -f0 / (f1 + 0.5*d1*f2)
d3 = -f0 / (f1 + 0.5*d2*f2 + d2*d2*f3/6)
E  = E + d3
```

**Measured maximum absolute error in E, radians** (`p2_kepler.py`, section P2a):

| Recipe | trig pairs | e=0.2 | e=0.4 | e=0.6 | e=0.8 | e=0.9 |
|---|---|---|---|---|---|---|
| `S_danby` + 1 Danby4 | 1 | 1.6e-6 | 1.5e-4 | 2.8e-3 | 1.1e-2 | 4.4e-2 |
| `S_danby` + 2 Danby4 | 2 | 8.9e-16 | 1.8e-15 | 4.3e-13 | 6.1e-10 | 1.6e-6 |
| **`S_danby` + 3 Danby4** | **3** | **8.9e-16** | **8.9e-16** | **1.8e-15** | **2.7e-15** | **4.4e-15** |
| `S_M` + 3 Halley | 3 | 8.9e-16 | 8.9e-16 | 1.8e-15 | 5.0e-13 | 9.1e-9 |
| `S_lin` + 2 Danby4 | 3 | 8.9e-16 | 1.8e-15 | 1.8e-15 | 2.6e-12 | 1.8e-7 |
| `S_danby` + 4 Newton | 4 | 8.9e-16 | 1.8e-15 | 1.8e-15 | 3.9e-10 | 2.9e-6 |

`8.9e-16` is the double-precision floor for `E ~ 1`, roughly 4 ulp.

**Recommendation: `S_danby` + 3 Danby–Burkardt corrections.** It is the cheapest
recipe that reaches the floor for all `e <= 0.9`, and it is the only 3-pair
recipe that does. On a 1 AU semi-major axis, 1.8e-15 rad is **0.27 mm** of
position error. Rejected alternatives:

- **Markley's non-iterative solver** (Celest. Mech. Dyn. Astr. 63, 101) reaches
  machine precision with a cubic starter and a single Householder step, and
  would be tempting. It needs a real cube root, which is not in the permitted
  operation set and would have to be built from a Newton loop plus exponent-field
  bit tricks. Danby is already at the floor and needs no such machinery.
- **Caching `E` from the previous tick as the starter.** Forbidden: it makes the
  ephemeris stateful and destroys the O(1)-at-arbitrary-time property the
  planner's horizon scrub depends on.

### 1.2 Saving the fourth trig pair

Only `sin E` and `cos E` at the *final* `E` are needed. After the third
correction `|d3| <= 5e-13` for `e <= 0.8`, so a first-order rotation is exact to
`d3^2/2 ~ 1e-25`, far below one ulp:

```
kepSin = sE + cE * d3
kepCos = cE - sE * d3
```

This makes the whole solve **3 `dsincos` calls**. Measured in Node
(`q2_selftest.mjs`, section Q2b), the Kepler residual `|E - e sinE - M|` and the
identity `|sin^2 + cos^2 - 1|`:

| e | max residual (rad) | max identity error |
|---|---|---|
| 0.0 | 0 | 2.2e-16 |
| 0.3 | 8.9e-16 | 2.2e-16 |
| 0.6 | 8.9e-16 | 3.3e-16 |
| 0.8 | 8.9e-16 | 4.4e-16 |
| 0.9 | 9.5e-14 | 2.7e-12 |

**e = 0.9 is where the first-order rotation runs out**, because `d3` is then
~1.6e-6 and `d3^2/2 ~ 1.3e-12`. Either cap level eccentricity at 0.8, or use a
second-order rotation, or spend the fourth pair. Recommendation: **cap body
eccentricity at 0.8 and assert it at level load.** No plausible level needs
more, and it removes a subtle accuracy cliff.

### 1.3 State vectors in the parent frame

With `a`, `e`, argument of periapsis `w`, and `mu_parent`, precompute at level
load `b = a sqrt(1-e^2)`, `n = sqrt(mu_parent/a^3)`, `g = sqrt(mu_parent a)`,
`cos w`, `sin w`. Then per query:

```
M  = M0 + n * (t - t0)
M  = M - 2pi * floor(M / 2pi)                 # reduce to [0, 2pi)
solveKepler(M, e)  ->  sE, cE
r  = a * (1 - e * cE)
p  = ( a * (cE - e),  b * sE )                # perifocal position
f  = g / r
pv = ( -f * sE,  (b/a) * f * cE )             # perifocal velocity
x  = ( p.x*cos w - p.y*sin w,  p.x*sin w + p.y*cos w )
v  = ( pv.x*cos w - pv.y*sin w, pv.x*sin w + pv.y*cos w )
```

The `cos w` / `sin w` rotation is a per-body constant. Computing it inside the
tick loop would be both a determinism violation and, as measured, a 25 %
throughput loss.

### 1.4 Parent chains in one pass

Store bodies in an array with **every parent at a lower index than its
children** (a topological order, validated at level load). Then one forward
sweep composes every chain of any depth:

```
for i in 1 .. NB-1:
    (p_local, v_local) = keplerian_state(i, t)
    x[i] = x[parent[i]] + rotate(p_local, w[i])
    v[i] = v[parent[i]] + rotate(v_local, w[i])
```

That is O(NB) for the whole system, not O(depth) per body, and it makes "moon
around planet around star" free. `x[0] = v[0] = 0` for the primary. Bodies do
not perturb each other, which the determinism contract already fixes, so this is
exact rather than an approximation.

**Measured:** 806 ns for a 6-body system with 5 Kepler solves, i.e. 161 ns per
body (`q5_perf2.mjs`, Q5a).

---

## 2. Deterministic transcendentals

### 2.1 What is safe and what is not

Following canyon-run's finding that `Math.cos(0.1)` differs by 1 ulp between
Node 24 and Chromium 151, and `Math.hypot` between V8 and SpiderMonkey:

**Safe, and the only operations the kernels use.** `+ - * /`, `sqrt`,
`floor`/`ceil`/`trunc`/`round`, `abs`, `min`/`max`, `sign`, comparisons, `Math.imul`,
all int32 and uint32 operations, and reinterpretation of a double's bits through
a `Float64Array` / `Uint32Array` view. `+ - * / sqrt` are correctly rounded by
IEEE-754 mandate. JavaScript has no fused multiply-add and the specification
forbids introducing one, so expression contraction cannot silently change a
result.

**Banned by lint.** `sin cos tan asin acos atan atan2 sinh cosh tanh asinh
acosh atanh exp expm1 log log2 log10 log1p pow cbrt hypot`, the `**` operator,
`Math.random`, and `Math.fround`. `hypot` deserves special mention: it is
banned not only for cross-engine variance but because it is *slower* than
`sqrt(x*x + y*y)` and the sim never needs its overflow protection at these
magnitudes.

**Assumed but not specified.** ECMAScript classifies `Math.sqrt` as
implementation-approximated. Every production engine emits the hardware `sqrtsd`
/ `fsqrt` instruction, which IEEE-754 requires to be correctly rounded. Cover
the gap with a startup self-check (section 8.4) rather than a comment.

### 2.2 Range reduction, and why it is exact here

`dsin` and `dcos` use fdlibm's `__ieee754_rem_pio2` medium path: Cody–Waite
subtraction of `n * pi/2` using a three-part split of `pi/2` carrying about 151
bits.

The exactness argument has two halves.

**The product must not round.** `PIO2_1 = 0x1.921fb54400000p+0` carries 33
significant bits, so `n * PIO2_1` is exact whenever `n` fits in 20 bits.
Measured directly with exact rational arithmetic
(`p3b_reduction_and_kepler.py`, P3e corrected, 3000 random odd `n` per
bit-width): exact for every `n` up to 2^22, first rounding at 2^23. fdlibm's own
guard is `|x| < 2^19 * pi/2 = 8.2355e5`, which caps `|n|` at 2^19. Comfortable.

**The argument must stay inside that bound.** This is where the sim's structure
helps. Mean anomaly is reduced before it ever reaches `dsin`:

```
M = M0 + n * (t - t0)
M = M - 2pi * floor(M * (1/2pi))
```

so the argument handed to `dsincos` is always in `[0, 2pi)`. The reduction
itself is where precision could be lost, and the magnitude of `M` before
reduction is bounded by the level's duration. The fastest plausible body is a
moon with a one-day period, `n = 7.3e-5 rad/s`; a 30-day level gives
`|M| <= 190 rad`. Even a thousand-fold margin leaves `|M| < 2e5`, four times
inside the bound. **Declare `|argument| <= 2^18 = 2.6e5` as a contract and
assert it in development builds.** At that magnitude `floor` loses at most
`ulp(2.6e5)/2 = 1.5e-11` rad of the fractional part, which is 2 mm on a 1 AU
orbit; if that ever mattered, store the mean anomaly as a
`(revolutions: int, phase: double)` pair instead.

### 2.3 Measured accuracy

Against a 60-digit `decimal` reference, converting floats exactly rather than
through `repr` (`p3_dtrig.py`; the first run of this probe was wrong for exactly
that reason and reported spurious 1e-8 errors):

| Function | argument range | max relative error | max ulp | libm's own ulp |
|---|---|---|---|---|
| `dsin`, `dcos` | `[-pi/4, pi/4]` | 1.46e-16 | 1.06 | 0.51 |
| `dsin`, `dcos` | `[-2pi, 2pi]` | 1.83e-16 | 1.17 | 0.51 |
| `dsin`, `dcos` | `[0, 200]` | 2.02e-16 | 1.29 | 0.51 |
| `dsin`, `dcos` | `[0, 1e4]` | 1.46e-16 | 1.10 | 0.51 |
| `dsin`, `dcos` | `[0, 1e5]` | 1.55e-16 | 1.07 | 0.51 |
| `dsin`, `dcos` | `[0, 8.2e5]` | 1.49e-16 | 1.06 | 0.51 |
| `dsincos` fused | `[0, 2pi)` | 1.69e-16 | - | - |
| `datan2` | exponents -30..30 | 2.51e-16 | 1.55 | - |
| `dexp` | `[-8, 8]` | 1.35e-16 | 0.86 | - |
| `dlog` | `[2e-9, 5e8]` | 1.28e-16 | 0.71 | - |

`max |sin^2 + cos^2 - 1| = 2.22e-16` over 20 000 samples, which is the invariant
the state-vector composition actually leans on. `datan2` agrees with
`Math.atan2` to 4.4e-16 on CPython and **bit-for-bit** on V8 over 200 000
samples; `dexp` agrees with `Math.exp` bit-for-bit on V8.

Accuracy is roughly 1.3 ulp against libm's 0.5. That is the price of
reproducibility and it is 6 orders of magnitude below anything the game can see.

### 2.4 Coefficients

All from fdlibm 5.3 (Sun Microsystems, public domain, 1993), as also shipped in
musl libm, Go's `math` package and Java's `StrictMath`. Using a published,
widely-tested minimax set is strictly better than deriving new coefficients:
the same constants are already validated at the 1-ulp level by three
independent implementations.

`sin` kernel on `|x| <= pi/4`, degree 13:

```
S1 = -1.66666666666666324348e-01   S2 =  8.33333333332248946124e-03
S3 = -1.98412698298579493134e-04   S4 =  2.75573137070700676789e-06
S5 = -2.50507602534068634195e-08   S6 =  1.58969099521155010221e-10
```

`cos` kernel, degree 14:

```
C1 =  4.16666666666666019037e-02   C2 = -1.38888888888741095749e-03
C3 =  2.48015872894767294178e-05   C4 = -2.75573143513906633035e-07
C5 =  2.08757232129817482790e-09   C6 = -1.13596475577881948265e-11
```

Reduction constants:

```
INVPIO2 = 6.36619772367581382433e-01
PIO2_1  = 1.57079632673412561417e+00   PIO2_1T = 6.07710050650619224932e-11
PIO2_2  = 6.07710050630396597660e-11   PIO2_2T = 2.02226624879595063154e-21
PIO2_3  = 2.02226624871116645580e-21   PIO2_3T = 8.47842766036889956997e-32
```

`atan` uses fdlibm's eleven `aT` coefficients with four-region reduction on
`7/16, 11/16, 19/16, 39/16`; `exp` uses `P1..P5` with `k*ln2` splitting; `log`
uses `Lg1..Lg7` on `s = f/(2+f)`. Full working implementations, both languages:
`q1_core.mjs` and `p3_dtrig.py`.

`2^k` is built from the exponent field, never `Math.pow`:

```
function pow2i(k) { return fromWords((k + 1023) << 20, 0); }   // -1022 <= k <= 1023
```

`dacos` is not a separate kernel: `dacos(x) = datan2(sqrt((1-x)*(1+x)), x)`.
Writing `(1-x)*(1+x)` rather than `1-x*x` preserves precision near `|x| = 1`,
which matters because that is exactly where the intercept-confidence lens
formula evaluates it.

### 2.5 Where trig is genuinely needed, and where it is not

**Needed.**

- **Kepler state vectors.** 3 `dsincos` per body per ephemeris query. This is
  the only high-frequency trig in the simulation and it dominates the ephemeris
  cost.
- **Rail bearing from rotation phase.** `phase = phase0 + 2pi (t-t0)/T_rot`,
  then one `dsincos` gives the outward unit vector. Forward direction only.
- **`dexp`** for burn duration from the rocket equation, and **`dlog`** for the
  delta-v-remaining readout. Both are low frequency: once per burn node, once
  per solution readout. Both are player-visible numbers, so rule 11 makes them
  the simulation's responsibility and therefore deterministic.
- **`datan2`** for the intercept-confidence lens area when the aim point is
  offset from the predicted contact position, and for any bearing the interface
  displays as a number.

**Avoidable, and should be avoided.**

- **Burn direction.** A burn node's prograde and lateral components map to a
  direction with pure vector algebra. Never store a heading angle:
  `u = v / |v|`, `l = (-u.y, u.x)`, `n = (dvp*u + dvl*l) / sqrt(dvp^2 + dvl^2)`.
- **Player drag input.** The launch-drag gesture produces a heading, but the
  **command log must store the unit vector or a quantised integer angle, never a
  float angle**. Quantising to 1/65536 of a turn makes the log exactly
  reproducible regardless of UI float noise, and turns the angle into an index
  into a precomputed table, so the sim never calls trig on player input at all.
- **Occlusion tests.** Segment-versus-sphere is `sqrt` and dot products only.
- **Closest approach, miss distance, arrival speed, impact energy.** All
  algebraic.

Directions inside the simulation should be unit vectors throughout. `datan2`
belongs at the boundary where a number is formatted for a human.

### 2.6 Cross-runtime verification

The strongest available evidence that this approach works: the **same
algorithm** implemented independently in CPython 3.12 and Node 24, compared on
raw bit patterns (`q3_crosscheck.py`).

| quantity | CPython 3.12 | Node 24 / V8 | |
|---|---|---|---|
| `dsin(0.1)` | `3fb98eaecb8bcb2c` | `3fb98eaecb8bcb2c` | match |
| `dcos(0.1)` | `3fefd712f9a817c0` | `3fefd712f9a817c0` | match |
| `dsin(1)` | `3feaed548f090cee` | `3feaed548f090cee` | match |
| `dcos(3)` | `bfefae04be85e5d2` | `bfefae04be85e5d2` | match |
| `dsin(100)` | `bfe03425b78c4db8` | `bfe03425b78c4db8` | match |
| `dcos(10000)` | `bfee780e88ec4409` | `bfee780e88ec4409` | match |
| `dsin(123456.789)` | `bfeff50e60ab53f9` | `bfeff50e60ab53f9` | match |
| `dexp(2.5)` | `40285d6fd931e0bb` | `40285d6fd931e0bb` | match |
| `dlog(7.5)` | `40001e85798eb9a3` | `40001e85798eb9a3` | match |
| `datan2(3,-4)` | `4003fc176b7a8560` | `4003fc176b7a8560` | match |
| Kepler `E(M=1, e=0.6)` | `3ff99891ef075f19` | `3ff99891ef075f19` | match |
| Kepler `sin E` | `3feffc911cc33d00` | `3feffc911cc33d00` | match |
| Kepler `cos E` | `bf9da49742ff2801` | `bf9da49742ff2801` | match |

18 of 18 identical. **Two unrelated language runtimes on two unrelated libm
implementations produce identical bits from the same source constants.** That is
the property the determinism contract wants, and it upgrades cross-platform
bit-identity from "stretch goal" to "probably already true", at least for the
numeric core.

---

## 3. Integrator

### 3.1 The problem shape

A dynamic object moves in the field of `K <= 6` point masses whose positions are
prescribed analytically. The Hamiltonian is separable in the usual way but
explicitly time-dependent, so energy is not conserved even exactly and the
classic symplectic argument about bounded energy error does not transfer
directly. What does transfer is that a splitting method built from exact drifts
and exact kicks has no secular drift of its own; only the field's time
dependence drives error.

The metric that matters is **not** local truncation error or energy drift. It is
**downstream miss**: how far the impact point moves, days later, because of the
error a flyby introduced. A 1 mm/s velocity error at a flyby is 864 m of miss
ten days later. Every number below is quoted that way.

**Acceptance bar: downstream miss over a further 10 days below 1 km.** The
smallest uncertainty box in the campaign is 1 800 km, and the smallest thing a
probe has to hit is a hulk a few km across, so 1 km is a comfortable order of
magnitude inside anything the player can perceive.

### 3.2 Reference solution

For a single fixed attractor the exact answer is available in closed form: the
hyperbolic Kepler solution. `p4_integrator.py` propagates from 300 body radii
inbound to 300 radii outbound using hyperbolic anomaly, so the measured error is
purely the integrator's, with no reference-integrator error mixed in. The
time-dependent case in `p6_ladder_robust.py` uses a PEFRL run at `dt = 1 s` as
reference, which section 3.3 shows is at the double-precision floor.

### 3.3 Candidates, at equal cost

Cost is counted as **ephemeris evaluations**, not `accel()` calls, because one
ephemeris evaluation (6 Kepler solves) serves every dynamic object at that
instant and is the dominant term:

| method | ephemeris evaluations per step | order |
|---|---|---|
| velocity Verlet, kick-drift-kick | 1 (end-of-step force reused) | 2 |
| Yoshida 4 (triple jump of Verlet) | 3 | 4 |
| **PEFRL** | 4 | 4 |
| RK4 | 4 | 4 |

Jupiter-class grazing flyby, `v_inf = 200 km/s`, no ladder
(`p5_ladder.py`, P5a), sorted by cost:

| method | dt (s) | ephemeris evals | \|dv\| (m/s) | miss @ 10 d |
|---|---|---|---|---|
| verlet | 240 | 893 | 5.01e+1 | 43 290 km |
| verlet | 120 | 1 786 | 8.54e+0 | 7 381 km |
| yoshida4 | 240 | 2 679 | 4.47e+0 | 3 860 km |
| pefrl | 240 | 3 572 | 4.79e+0 | 4 134 km |
| rk4 | 240 | 3 572 | 6.66e+0 | 5 750 km |
| verlet | 60 | 3 572 | 2.12e+0 | 1 831 km |
| yoshida4 | 120 | 5 358 | 2.48e+0 | 2 141 km |
| **pefrl** | **120** | **7 144** | **1.79e-2** | **15.4 km** |
| rk4 | 120 | 7 144 | 1.37e-1 | 118 km |
| verlet | 30 | 7 144 | 5.29e-1 | 457 km |
| yoshida4 | 60 | 10 716 | 1.82e-1 | 157 km |
| **pefrl** | **60** | **14 288** | **1.14e-3** | **0.99 km** |
| rk4 | 60 | 14 288 | 8.89e-3 | 7.7 km |
| verlet | 15 | 14 288 | 1.32e-1 | 114 km |
| pefrl | 30 | 28 576 | 7.11e-5 | 0.061 km |
| rk4 | 30 | 28 576 | 5.59e-4 | 0.48 km |
| verlet | 7.5 | 28 575 | 3.30e-2 | 28.5 km |

At every matched cost PEFRL wins: **8x better than RK4** and **30x to 460x
better than Verlet**. PEFRL reaches the double-precision floor (`|dv| ~ 1.2e-8
m/s`) at `dt = 3.75 s`.

Yoshida 4 is the surprise loser. It is genuinely 4th order but its triple-jump
construction has a large error constant (`w0 = -1.702...` means one substep runs
backwards by 1.7 h), so at 3 evaluations per step it is beaten by PEFRL at 4.

### 3.4 Recommendation: PEFRL

Position-Extended Forest-Ruth-Like, Omelyan, Mryglod and Folk, *Computer
Physics Communications* **146** (2002) 188. Four force evaluations, 4th order,
symplectic, coefficients optimised to minimise the position error constant.

```
XI  =  0.1786178958448091
LAM = -0.2123418310626054
CHI = -0.06626458266981849
K1  = (1 - 2*LAM) / 2          # = 0.7123418310626054
D3  = 1 - 2*(CHI + XI)         # = 0.7753065776500187

drift XI*h;   kick K1*h;   drift CHI*h;  kick LAM*h;
drift D3*h;   kick LAM*h;   drift CHI*h;  kick K1*h;   drift XI*h
```

Hardcode the coefficients as literals. They come from a cube root and a
numerical optimisation; neither belongs at runtime.

Three consequences worth writing down.

- **Two drift coefficients are negative** (`CHI < 0`), so the integrator briefly
  steps backwards in time and evaluates the ephemeris slightly outside
  `[t, t+h]`. Harmless, because tier one is analytic and valid at any `t`. But
  **collision and surface tests must be evaluated on substep endpoints only,
  never on internal stages**, or a negative drift can produce a phantom
  intersection.
- **Verlet cannot be rescued by the ladder.** `p5_ladder.py` P5d: with the same
  ladder and `zeta` tightened to 1/1024, Verlet still misses by 1.95 km at
  20 648 evaluations, while PEFRL manages 0.005 km at 29 872. In the
  time-dependent field (P6b) Verlet is 670 km off at `zeta = 1/32` against
  PEFRL's 0.085 km. The reason is structural: Verlet's error is not concentrated
  at periapsis, so refining near the body does not remove it.
- **The planner pays 4x per step but re-integrates a single object**, so the
  absolute cost is trivial: 87 ms for a 14-day plan at `dt = 60` (section 9).

### 3.5 A tick, with finite burns

```
function tick(tickNo):
    t = tickNo * dt                              # integer tick is the only clock
    ephemeris(t)                                 # tier one, analytic, O(NB)

    # per-object substep level, from state alone (section 4)
    for i in 0 .. N-1:
        level[i] = substepLevel(i)
        groups[level[i]].push(i)

    # objects at the same level share every ephemeris evaluation
    for L in 0 .. L_MAX:
        n = groups[L].length
        if n == 0: continue
        ns = 1 << L
        h  = dt / ns
        for s in 0 .. ns-1:
            pefrlSubstep(groups[L], t + s*h, h)

    resolveEvents(tickNo)      # collisions, exposure crossings, node activations,
                               # telemetry arrivals; all on substep endpoints
```

`pefrlSubstep` interleaves the five drifts and four kicks across the whole
group, so the ephemeris is evaluated once per stage rather than once per object:

```
function pefrlSubstep(idx, t, h):
    drift(idx, XI*h)
    ephemeris(t + XI*h);                   kick(idx, K1*h,  t + XI*h)
    drift(idx, CHI*h)
    ephemeris(t + (XI+CHI)*h);             kick(idx, LAM*h, t + (XI+CHI)*h)
    drift(idx, D3*h)
    ephemeris(t + (XI+CHI+D3)*h);          kick(idx, LAM*h, t + (XI+CHI+D3)*h)
    drift(idx, CHI*h)
    ephemeris(t + (XI+2*CHI+D3)*h);        kick(idx, K1*h,  t + (XI+2*CHI+D3)*h)
    drift(idx, XI*h)

function kick(idx, hk, t_stage):
    for i in idx:
        (ax, ay) = gravity(x[i], y[i])                 # 6 attractors
        if burning[i]:
            f = burnOverlap(i, t_stage, hk)            # see below
            if f > 0:
                m_mid  = mass[i] - 0.5 * mdot[i] * f * abs(hk)
                a_th   = thrust[i] / m_mid
                ax += f * a_th * nx[i]
                ay += f * a_th * ny[i]
                mass[i]  -= mdot[i] * f * abs(hk)
                dvAcc[i] += f * a_th * abs(hk)
        vx[i] += hk * ax
        vy[i] += hk * ay
```

### 3.6 A burn node's "prograde + lateral m/s"

A burn node is `(t_act, dv_prograde, dv_lateral)`. Mapping it to the integrator:

```
dv_target = sqrt(dvp^2 + dvl^2)
u = v(t_act) / |v(t_act)|                # inertial velocity direction, FROZEN
l = (-u.y, u.x)                          # +90 degrees, no trig
n = (dvp*u + dvl*l) / dv_target          # thrust direction, unit
mdot   = T / v_e                         # constant at maximum thrust
t_burn = (m0 / mdot) * (1 - dexp(-dv_target / v_e))       # rocket equation
t_end  = t_act + t_burn
```

**Freeze `u` at `t_act`.** Recomputing "prograde" continuously as the velocity
rotates makes the delivered impulse a feedback loop on its own effect,
unpredictable for the player and awkward for the planner. Freezing makes the
whole burn a pure function of the state at one instant. `u` is defined in the
simulation's global inertial frame, and the planner must label it that way.

The overlap weight for a stage of length `h` starting at `t0`:

```
f = clamp((min(t_end, t0+h) - max(t_act, t0)) / h, 0, 1)
```

**Measured delivered delta-v** (`p11_burn.py`, P11b; `v_e = 30 km/s`,
`T = 4 kN`, `m0 = 1500 kg`, `dt = 60 s`, activation offset 0.37 of a tick):

| dv target (m/s) | burn time (s) | L=0 rel err | L=2 | L=4 | L=6 |
|---|---|---|---|---|---|
| 0.5 | 0.187 | 2.4e-11 | 2.4e-11 | 2.4e-11 | 2.4e-11 |
| 5 | 1.875 | 2.3e-9 | 2.3e-9 | 1.4e-9 | 3.9e-10 |
| 50 | 18.7 | 2.3e-7 | 6.3e-8 | 8.9e-9 | 5.6e-10 |
| 200 | 74.8 | 9.3e-7 | 1.3e-7 | 9.2e-9 | 5.8e-10 |
| 1000 | 368.8 | 2.1e-6 | 1.5e-7 | 9.5e-9 | 6.0e-10 |
| 5000 | 1727.1 | 2.8e-6 | 1.7e-7 | 1.1e-8 | 6.9e-10 |

The **magnitude** is already accurate to 3e-6 at `L = 0`, and smooth in the
activation offset (P11c: 9.3e-7 to 1.9e-6 across the tick, no jumps). Better
still, cutting the thrust on **accumulated delta-v** rather than a precomputed
`t_end` delivers the target *exactly*, with the final partial stage solved
analytically (P11e: relative error 0.000e+00 at every level):

```
rem = dv_target - dvAcc[i]
g   = (m / (mdot * f * abs(hk))) * (1 - dexp(-rem / v_e))
```

**Recommendation: accumulate and cut on the accumulator.** It makes the
player-facing promise ("this node spends 200 m/s") exactly true, and it removes
`dexp` from the burn-scheduling path, leaving it only in the final-stage solve
and the readout.

What is *not* accurate at `L = 0` is the **timing** of a short burn. A 10 m/s
burn lasts 3.75 s; smeared across a 60 s substep, the impulse lands up to 30 s
from where it should, a position offset of `dv * h / 2 = 300 m`. So:

> **Burn ladder term.** During any tick overlapping a burn, force
> `L >= smallest L with dt / 2^L <= t_burn`, clamped to `L_MAX`.

That guarantees at least one substep entirely inside the burn and reduces the
timing offset to `dv * t_burn / 2`. For the 10 m/s example that is `L = 4` and
19 m. It is a pure function of state, so determinism is unaffected.

Sanity numbers for a representative probe (P11a): `m_wet = 1500 kg`,
`m_dry = 600 kg`, `v_e = 30 km/s`, `T = 4 kN` gives a total budget of
**27.5 km/s**, `a` from 2.67 to 6.67 m/s^2, `mdot = 0.133 kg/s`, and 1.88 h to
burn the tank dry. A 1 km/s correction is 6.1 ticks at `dt = 60` and 49 kg of
propellant.

---

## 4. The substep ladder

### 4.1 What the contract says, and why it needs amending

`simulation-determinism.md` rule 4:

```
L = clamp(floor(log2(r_ref / r_nearest)), 0, L_max)
```

Three problems, all fixable without giving up anything the rule was protecting.

**The exponent is wrong by a factor of 1.5.** The physical requirement is that
the substep resolve the local dynamical time,
`h <= eta * sqrt(r^3 / mu)`. Rearranged, the required level grows as
`1.5 * log2(1/r)`, not `log2(1/r)`. A ladder that grows too slowly has to be
compensated by starting far too early, which is exactly what the worked
example's `r_ref = 1e7 km` does.

**`r_ref` is a level constant but should be a body property.** As written, a
moonlet and a gas giant at the same range get the same refinement. Physically
the refinement depends on `mu`.

**Distance is the wrong variable for a 100-300 km/s probe.** At those speeds the
binding constraint is not the dynamical time but the *crossing* time: how much
of the current radius the object traverses in one step. For a grazing Jupiter
pass at 200 km/s the crossing criterion is about 7x tighter than the dynamical
one, and the measurements below show the dynamical criterion alone selects
`L = 0` and fails.

### 4.2 The replacement

Two ladders, both per body, both integer, both from state alone, both without a
logarithm, take the maximum:

**Dynamical ladder.** Smallest `L` with `4^L * r^3 >= k_dyn[b]`, where
`k_dyn[b] = mu[b] * (dt / eta)^2` is precomputed at level load.

```
L1 = 0; s = r*r*r
while L1 < L_MAX and s < k_dyn[b]:  s *= 4;  L1 += 1
```

This is `h <= eta * sqrt(r^3 / mu)` rearranged to avoid both the logarithm and
the cube root. Multiplication by 4 is exact, so the loop is exactly
boundary-correct and reproducible.

**Crossing ladder.** Smallest `L` with `(dt / 2^L) * v_rel <= zeta * r`.

```
L2 = 0; d = dt * v_rel; lim = zeta * r
while L2 < L_MAX and d > lim:  d *= 0.5;  L2 += 1
```

Halving is exact for the same reason. `v_rel` is the object's velocity relative
to the body, which matters for a probe near a fast-moving moon.

```
L = clamp(max over bodies of max(L1, L2), 0, L_MAX)
```

**Why a comparison loop rather than the exponent field.** Extracting
`floor(log2(q))` from the high word of `q = r_ref / r` is faster, but the
division rounds, so a ratio just under a power of two can round up to exactly a
power of two and shift the level by one. The comparison loops never divide.
`L_MAX <= 10` bounds each at 10 iterations and the whole `levelFor` call
measures **28.5 ns** for 6 bodies and both ladders (`q5_perf2.mjs`, Q5a), which
is comparable to a single `accel()` call. Not worth optimising.

### 4.3 Two requirements the documents do not state

**The level must be per object.** If it were the maximum over all live objects,
a probe integrated alone by the planner would take different substeps from the
same probe integrated among fifty others, and **the ghost invariant would fail
for reasons entirely unrelated to the plan**. Group objects by level and step
each group at its own level, as in section 3.5.

**Dynamic objects must not gravitate each other.** Both documents imply this
("moved by fixed-step symplectic integration in the field of the tier-one
bodies") but neither says it outright. It is what makes the per-object ladder
exact rather than an approximation, and it is what lets the ghost be integrated
in isolation. Debris and probes still *collide*; they just do not attract.

### 4.4 Recommended constants

| Constant | Value | Rationale |
|---|---|---|
| `eta` | 0.05 | dynamical-time coefficient; measured to be non-binding at cruise speeds but necessary for slow objects |
| `zeta` | **1/32** | crossing-time coefficient; see the sweep below |
| `L_MAX` | **10** | `dt/1024 = 59 ms` at `dt = 60`; the ladder never exceeded 7 in any test |
| `dt` | **60 s** for cruise levels | the coarsest value that passes every flyby tested |
| `k_dyn[b]` | `mu[b] * (dt/eta)^2` | precomputed at level load; no cube root at runtime |

### 4.5 Ladder comparison

Base `dt = 60 s`, PEFRL, grazing flyby at one body radius, integrated 300 radii
in and out, error expressed as downstream miss over a further 10 days
(`p5_ladder.py`, P5a). "doc" is rule 4 as written with `r_ref = 1e7 km`. Relative
cost is against no ladder at all.

| body | v_inf | ladder | L used | eph evals | rel cost | miss @ 10 d | |
|---|---|---|---|---|---|---|---|
| Jupiter | 100 | none | 0 | 28 512 | 1.00 | 0.64 km | ok |
| Jupiter | 100 | dyn | 0 | 28 512 | 1.00 | 0.64 km | ok |
| Jupiter | 100 | cross | 3 | 29 488 | 1.03 | 0.0034 km | ok |
| Jupiter | 100 | doc | 7 | 68 904 | 2.42 | 1.5e-5 km | ok |
| Jupiter | 300 | none | 0 | 9 532 | 1.00 | **1.39 km** | **FAIL** |
| Jupiter | 300 | dyn | 0 | 9 532 | 1.00 | **1.39 km** | **FAIL** |
| Jupiter | 300 | cross | 4 | 10 976 | 1.15 | 0.0055 km | ok |
| Saturn | 300 | none | 0 | 8 036 | 1.00 | 0.34 km | ok |
| Saturn | 300 | dyn+cross | 4 | 9 540 | 1.19 | 0.0021 km | ok |
| Saturn | 300 | doc | 7 | 22 656 | 2.82 | 2.4e-6 km | ok |
| **Earth** | **100** | **none** | 0 | 2 552 | 1.00 | **2 681 km** | **FAIL** |
| **Earth** | **100** | **dyn** | 1 | 2 560 | 1.00 | **276 km** | **FAIL** |
| Earth | 100 | dyn+cross | 6 | 4 936 | 1.93 | 0.00037 km | ok |
| Earth | 100 | doc | 10 | 62 480 | **24.5** | 3.2e-7 km | ok |
| **Earth** | **200** | **none** | 0 | 1 276 | 1.00 | **32 230 km** | **FAIL** |
| Earth | 200 | dyn+cross | 7 | 4 140 | 3.24 | 0.0002 km | ok |
| Earth | 200 | doc | 10 | 31 984 | **25.1** | 5.3e-7 km | ok |
| **Earth** | **300** | **none** | 0 | 852 | 1.00 | **53 040 km** | **FAIL** |
| Earth | 300 | dyn+cross | 7 | 3 460 | 4.06 | 0.00039 km | ok |
| Earth | 300 | doc | 10 | 20 736 | **24.3** | 1.6e-6 km | ok |

Three conclusions.

- **The ladder is not optional.** Without it an Earth-class grazing pass at 200
  km/s is 32 000 km off, which is larger than the uncertainty box at 20
  light-minutes. This answers the first open question in GAME-0001 section 9:
  a coarse base timestep is safe *only* with the ladder.
- **The dynamical criterion alone is nearly useless at cruise speeds.** It picks
  `L = 0` or 1 and fails everywhere it matters. It earns its place only for slow
  objects (section 4.7).
- **The document's ladder works, but costs 6x to 13x more than the two-ladder
  replacement** (24.5x versus 1.93x against no ladder for the Earth-class pass at
  100 km/s), and buys accuracy three to four orders of magnitude beyond the bar.

### 4.6 Tuning `zeta`

Worst case over three bodies and three speeds, `dt = 60 s`, PEFRL, `L_MAX = 10`
(`p5_ladder.py`, P5b):

| `zeta` | worst miss @ 10 d | worst L | worst rel cost |
|---|---|---|---|
| 1/2 | 418 km | 3 | 1.06 |
| 1/4 | 82.7 km | 4 | 1.15 |
| 1/8 | 4.05 km | 5 | 1.38 |
| 1/16 | 0.47 km | 6 | 1.90 |
| **1/32** | **0.064 km** | **7** | **3.10** |
| 1/64 | 0.0047 km | 8 | 5.81 |
| 1/128 | 0.00029 km | 9 | 11.6 |

`zeta = 1/32` gives a 64 m worst case with a 15x margin on the bar. The 3.1x
cost multiplier applies only inside the encounter window, which for an
Earth-class flyby is about five hours out of a ten-day flight, so the
whole-level cost increase is negligible. The independent moving-field test
agrees within 30 %: 0.085 km at `zeta = 1/32` (section 4.8).

### 4.7 Base timestep sweep

PEFRL, `dyn+cross` at `zeta = 1/16`, `L_MAX = 10` (`p5_ladder.py`, P5c):

| body | v_inf | dt | L used | eph evals | miss @ 10 d | |
|---|---|---|---|---|---|---|
| Jupiter | 100 | 10 | 0 | 171 052 | 0.00048 km | ok |
| Jupiter | 100 | 30 | 0 | 57 020 | 0.040 km | ok |
| Jupiter | 100 | 60 | 1 | 28 608 | 0.455 km | ok |
| Jupiter | 100 | 120 | 2 | 14 472 | **1.02 km** | **FAIL** |
| Jupiter | 300 | 60 | 3 | 9 800 | 0.356 km | ok |
| Earth | 100 | 60 | 4 | 3 016 | 0.076 km | ok |
| Earth | 300 | 60 | 6 | 1 620 | 0.116 km | ok |
| Earth | 300 | 120 | 7 | 1 452 | **2.12 km** | **FAIL** |

**`dt = 60 s` passes everywhere; `dt = 120 s` does not.** At `zeta = 1/32` the
margin at `dt = 60` widens to roughly 15x. The document's stated range of 10 to
60 seconds is exactly right, with 60 as a ceiling rather than a comfortable
default.

The non-monotonic Earth entries (`dt = 120` worse than `dt = 300`) are a warning
sign: at `zeta = 1/16` the ladder is at the edge of adequacy and the level
choice interacts with where tick boundaries fall. At `zeta = 1/32` that
behaviour disappears. Treat non-monotonicity in `dt` as the signal that `zeta`
is too loose.

### 4.8 The moving-attractor case

The static test cannot capture the field's time dependence: during a 2 000 s
Jupiter encounter the planet itself moves 26 000 km, about a third of a
planetary radius. `p6_ladder_robust.py` P6b places a Jupiter-class body on a
circular 1 AU orbit around a solar-mass primary and grazes it at 200 km/s,
referenced against PEFRL at `dt = 1 s`:

| integrator | dt | zeta | L used | substeps | \|dx\| (m) | \|dv\| (m/s) | miss @ 10 d | |
|---|---|---|---|---|---|---|---|---|
| pefrl | 60 | 1/16 | 3 | 2 484 | 1.14e2 | 1.39e-3 | 1.20 km | FAIL |
| **pefrl** | **60** | **1/32** | 4 | 2 652 | 8.13e0 | 9.88e-5 | **0.085 km** | **ok** |
| pefrl | 60 | 1/64 | 5 | 3 052 | 1.49e0 | 1.80e-5 | 0.016 km | ok |
| pefrl | 30 | 1/32 | 3 | 4 960 | 8.59e0 | 1.05e-4 | 0.090 km | ok |
| verlet | 60 | 1/16 | 3 | 2 484 | 2.52e5 | 3.05e0 | 2 637 km | FAIL |
| verlet | 60 | 1/32 | 4 | 2 652 | 6.44e4 | 7.76e-1 | 670 km | FAIL |
| verlet | 60 | 1/64 | 5 | 3 052 | 1.61e4 | 1.93e-1 | 167 km | FAIL |

Verlet converges at the expected second order (a 4x finer step gives a 16x
smaller error) but would need `zeta` near 1/2800, meaning `L = 12`, to match
PEFRL at `zeta = 1/32`. That is 4 096 substeps per tick against PEFRL's 16.
**The choice of integrator is settled by this table more than by any other.**

### 4.9 The one-level-per-tick blind spot

The level is chosen from the state at the *start* of a tick, so in principle an
object could fall a long way inside the tick and be under-refined. In practice
the crossing criterion is self-protecting: if the object could fall far within a
tick, then `v * dt / r` is already large at the tick start and the criterion
fires. `p6_ladder_robust.py` P6a tested an Earth-class orbit with periapsis at
1.05 body radii and apoapsis at 60, over six orbits: relative energy error
6.7e-8, osculating periapsis drift 8 mm. Evaluating the ladder at a pessimistic
radius `max(r - v*dt, r_floor)` changed nothing measurable.

**If a level ever wants a deeper flyby than these tests cover, the principled
fix is recursive refinement**: at each substep re-test the criterion and halve
again if needed, to a depth of `L_MAX`. That is still driven only by state, so
it is equally deterministic, and it is strictly more accurate. It costs nothing
in the common case because the test fails immediately at `L = 0`. Consider
adopting it in the contract's wording so the option is open:

```
advance(obj, t, h, depth):
    if depth < L_MAX and needsRefinement(obj, h):
        advance(obj, t,       h/2, depth+1)
        advance(obj, t + h/2, h/2, depth+1)
    else:
        pefrlSubstep(obj, t, h)
```

### 4.10 Slow objects

Debris on a near-circular orbit at 1.5 body radii, 20 orbits, `dt = 60 s`
(`p5_ladder.py`, P5e): every ladder selects `L = 0` and the position error is
31 m (Jupiter-class) or 55 m (Earth-class), with radial drift of 1.2e-5 m and
2.0e-5 m. The dynamical criterion never fires at `eta = 0.05`. It is still worth
keeping, because it is the only thing that protects an object that is close and
slow, where the crossing criterion is blind by construction. It costs 10 ns per
object per tick.

### 4.11 Deflection: confirming the design table

`p1_flyby_analytic.py`, from the exact two-body hyperbolic relations
`e = 1 + r_p v_inf^2 / mu` and `sin(theta/2) = 1/e`:

| body | v_inf | e | deflection | v at periapsis | free \|dv\| |
|---|---|---|---|---|---|
| Jupiter-class | 50 | 2.411 | **49.013 deg** | 77.7 km/s | 41.5 km/s |
| Jupiter-class | 100 | 6.643 | **17.315 deg** | 116.4 km/s | 30.1 km/s |
| Jupiter-class | 200 | 23.573 | **4.863 deg** | 208.7 km/s | 17.0 km/s |
| Jupiter-class | 300 | 51.789 | **2.213 deg** | 305.9 km/s | 11.6 km/s |
| Saturn-class | 100 | 16.889 | 6.789 deg | 106.1 km/s | 11.8 km/s |
| Neptune-class | 100 | 37.223 | 3.079 deg | 102.7 km/s | 5.4 km/s |
| Earth-class | 100 | 161.0 | **0.712 deg** | 100.6 km/s | 1.24 km/s |
| Luna-class | 100 | 3543 | 0.032 deg | 100.0 km/s | 0.06 km/s |

The design document's 17.3 / 4.9 / 2.2 is confirmed exactly, and the quoted
cruise speed is unambiguously the speed at infinity: reading it as the periapsis
speed instead would give 24.87 / 5.31 / 2.30 degrees, which does not match.

Two facts for level design that fall out of this table.

- **Only gas giants are useful for gravity assist at Graviton's cruise speeds.**
  An Earth-class body at one radius bends a 100 km/s probe by 0.7 degrees. The
  "Slingshot" campaign beat (GAME-0001 section 6, beat 6) therefore requires a
  Jupiter- or Saturn-class body, and at the slow end of the speed band.
- **A grazing Jupiter pass is worth 11 to 41 km/s of free delta-v**, against a
  probe's own budget of roughly 27 km/s (section 3.6). That is the whole reason
  the slingshot beat can be made mandatory rather than merely efficient.

Encounter durations, for choosing when the ladder engages (P1e): a Jupiter-class
pass spends 3 802 s inside three planetary radii at 100 km/s and 1 338 s at 300
km/s. The Earth-class equivalents are 360 s and 120 s, which is **two base ticks
at `dt = 60`** and is precisely why the Earth-class rows fail without a ladder.

---

## 5. Light-cone solvers

### 5.1 The equations

With `c` the speed of light, `x_P` the post (on a body, so analytic and exact at
any `t`), `x_M` the probe:

- **Uplink.** Emission at `t_e` from `x_P(t_e)`. Find `t_a` with
  `|x_M(t_a) - x_P(t_e)| = c (t_a - t_e)`.
- **Downlink.** Reception at `t_r` at `x_P(t_r)`. Find `t_e` with
  `|x_M(t_e) - x_P(t_r)| = c (t_r - t_e)`.

Both are `g(s) = |x_M(s) - q| -/+ c (s - t0) = 0`. With `u` the unit vector from
`q` to `x_M(s)`:

```
g_uplink(s)   = |x_M(s) - q| - c*(s - t_e)      g'(s) = u . v_M(s) - c
g_downlink(s) = |x_M(s) - q| - c*(t_r - s)      g'(s) = u . v_M(s) + c
```

`|u . v_M| <= |v_M| ~ 3e5 m/s`, so `|g'| >= c (1 - beta)` with `beta = v/c ~
1e-3`. The derivative can never vanish and never changes sign, so Newton is
unconditionally well conditioned. **Starter: the geometric delay evaluated at
the known endpoint**, `t = t_e + |x_M(t_e) - q| / c` (uplink) or
`t = t_r - |x_M(t_r) - q| / c` (downlink).

### 5.2 How many iterations

`p7_lightcone.py` uses a deliberately hostile truth model: a curved arc at 300
km/s under 3 m/s^2 of thrust, post on a 1 AU circular orbit, ranges out to 118
light-minutes, well beyond the campaign's 40.

Difference from the 12-iteration fixed point (P7b):

| solver | range | after 1 | after 2 | after 3 | after 3, in metres of light |
|---|---|---|---|---|---|
| uplink | 31.7 lm | 2.5e-12 s | **0** | 4.5e-13 s | 1.4e-4 m |
| uplink | 53.9 lm | 1.4e-06 s | **0** | **0** | 0 |
| uplink | 117.9 lm | 2.5e-05 s | **0** | **0** | 0 |
| downlink | 31.7 lm | 2.5e-12 s | **0** | 4.5e-13 s | 1.4e-4 m |
| downlink | 115.6 lm | 2.3e-05 s | **0** | **0** | 0 |

**Two Newton iterations already reach the double-precision fixed point.** The
residual `|g|` bottoms out at 1e-4 to 1e-2 m, which is just the ulp of a
coordinate of magnitude 1e13 m, not a convergence failure.

The derivative-free fixed-point iteration `t <- t_e + |x_M(t) - q| / c`
contracts by `beta = 1.48e-3` per pass and reaches 9.1e-12 s in two passes
(P7c), so it would also work. Newton is preferred because its convergence does
not depend on the speed regime, and because the derivative is one dot product.

**Recommendation: exactly 3 Newton iterations, no tolerance test, no early
exit.** The third is insurance against a level with an unusually fast contact.
A tolerance test would be deterministic too but would add a branch for nothing.

### 5.3 Deterministic tolerance handling

Worst residual after 3 passes over 4 000 emission times is **1.16e-10 s**
(P7d), which is:

| dt | residual as a fraction of one tick |
|---|---|
| 10 s | 1.16e-11 |
| 30 s | 3.88e-12 |
| 60 s | 1.94e-12 |

Solver output feeds an **integer tick**: `arrival_tick = ceil(t_a / dt)`. For the
residual to change the answer, the true arrival would have to fall within 2e-12
of a tick boundary. Even then the result is still deterministic, because the same
arithmetic runs every time. So:

- Run a fixed 3 iterations and take the result.
- Quantise immediately to a tick with a single documented rule (`ceil` for
  arrival, `floor` for the observation the arrival was built from).
- Never compare the residual to a tolerance and branch on it.

### 5.4 Interpolating the probe's past and future

`x_P(t)` is analytic. `x_M(t)` is only known at substep endpoints, so both
solvers need a value at an arbitrary `t`. Use **cubic Hermite interpolation on
position and velocity** at the bracketing endpoints: it is C1, exact for the
constant-velocity case that dominates cruise, deterministic, and it gives the
solver's derivative term for free.

The downlink solver looks backwards by up to `d/c`, which at 40 light-minutes is
2 400 s, or 40 ticks at `dt = 60`. **Keep a ring buffer of past states covering
at least `2 * max_range / c / dt` ticks**, rounded up generously; 4 096 ticks is
2.8 days at `dt = 60` and costs 4096 * 4 doubles = 128 kB per tracked object.
The buffer is part of the serialised state, because a save mid-flight must be
able to answer a downlink query about an emission that predates the save.

### 5.5 Occlusion

Segment against sphere plus a grazing margin, using only `sqrt` and dot
products, evaluated against every body:

```
d = B - A;  f = A - centre
b2 = dot(f, d);  c2 = dot(f, f) - (R + margin)^2
if c2 > 0 and b2 > 0: clear                    # both endpoints outside, moving away
disc = b2*b2 - dot(d,d)*c2
if disc < 0: clear
t1 = (-b2 - sqrt(disc)) / dot(d,d)
if 0 <= t1 <= 1: blocked
```

Iterate bodies by index and stop at the first block; the result is a boolean, so
iteration order does not affect the value, but fixing it anyway keeps the
profile stable.

---

## 6. Uncertainty box and reachable set

### 6.1 The formulas the simulation exposes

```
tau      = t_intercept - t_observation                  # >= tau_floor, always
r_stale  = 0.5 * a_contact_max * tau^2
r_meas   = sigma_angular * min over observers of d(C, observer)
r_box    = r_stale + r_meas

r_reach  = dv * (t_go - dv / (2 * a_max))     if dv <= a_max * t_go
r_reach  = 0.5 * a_max * t_go^2               otherwise
```

`tau_floor = d(C,P)/c + d(M,P)/c` as the domain document states. `r_stale`,
`r_meas`, `r_box` and `tau_floor` are all confirmed correct.

### 6.2 Why `r_reach` doubles

The document's `0.5 * (dv/t_go) * t_go^2` is the displacement from spreading the
budget evenly across the whole interval at constant acceleration `a = dv/t_go`.
Spending it as early as the information allows does better. Burning at `a_max`
for `t_b = dv / a_max` and then coasting gives

```
0.5 * a_max * t_b^2 + a_max * t_b * (t_go - t_b) = dv * (t_go - dv / (2 a_max))
```

which tends to `dv * t_go`, twice the document's value, as `t_b / t_go -> 0`.
The impulsive-early model is also the *physically right* one for Graviton,
because the probe corrects once, at the moment its own sensors resolve the
contact.

`p9_box_exposure2.py`, P9c, `a_max = 3 m/s^2`:

| dv (m/s) | t_go (s) | docs (km) | corrected (km) | ratio |
|---|---|---|---|---|
| 500 | 3 600 | 900 | 1 758 | 1.95 |
| 500 | 600 | 150 | 258 | 1.72 |
| 2 000 | 3 600 | 3 600 | 6 533 | 1.81 |
| 100 | 7 200 | 360 | 710 | 1.97 |
| 2 000 | 600 | 540 | 540 | 1.00 |
| 5 000 | 1 200 | 2 160 | 2 160 | 1.00 |
| 20 000 | 600 | 540 | 540 | 1.00 |

The two agree exactly once the thrust limit binds. They differ by 1.7x to 2.0x
in the delta-v-limited branch, which is where a mid-course correction lives. The
practical effect of the correction is that levels tuned against the old formula
will feel about twice as generous as intended.

### 6.3 Intercept confidence

Define it as the fraction of the uncertainty disc the reachable disc covers:

```
confidence = area(B intersect R) / area(B)
```

With `B` of radius `r_box` centred on the predicted contact position and `R` of
radius `r_reach` centred on the probe's nominal aim point, separated by `d`:

```
if d >= r_box + r_reach:            confidence = 0
if d <= |r_box - r_reach|:          confidence = min(1, (r_reach / r_box)^2)
otherwise:
    a1 = dacos((d^2 + r_box^2   - r_reach^2) / (2 d r_box))
    a2 = dacos((d^2 + r_reach^2 - r_box^2)   / (2 d r_reach))
    A  = r_box^2  * (a1 - sin(2 a1)/2)
       + r_reach^2* (a2 - sin(2 a2)/2)
    confidence = A / (pi * r_box^2)
```

`sin(2a) = 2 sin a cos a` comes from the `dsincos` already computed, so the whole
thing is two `dacos` calls, each one `datan2`. Measured behaviour (P9d):

| r_reach / r_box | offset / r_box | confidence |
|---|---|---|
| 0.50 | 0.0 | 0.2500 |
| 0.75 | 0.0 | 0.5625 |
| 1.00 | 0.0 | 1.0000 |
| 0.75 | 0.5 | 0.4696 |
| 1.00 | 0.5 | 0.6850 |
| 1.00 | 1.0 | 0.3910 |
| 1.50 | 1.0 | 0.7417 |
| 2.00 | 1.0 | 1.0000 |

**In the concentric case the whole formula collapses to
`min(1, (r_reach/r_box)^2)`**, needing no inverse trig at all. Since the aim
point drifts off the predicted contact position as soon as the probe has spent
part of its budget, implement the full lens formula, but note that the cheap
branch covers the common planner display.

The design's stated win condition, "the reachable set contains the uncertainty
box", is `confidence == 1`, i.e. `d + r_box <= r_reach`. Displaying **both** the
number and the shaded overlap answers the second open question in GAME-0001
section 9: the number is what a player tunes against, and the shading is what
makes an offset legible, and they cost the same computation.

### 6.4 Circles or ellipses?

**Version one should use circles.** The reasoning is physical rather than
expedient.

- `r_stale` is genuinely isotropic. A contact can thrust in any direction, so
  the reachable region of an accelerating contact is a disc.
- `r_reach` is also isotropic to first order. For pure position displacement in
  free space with a fixed budget and a fixed time, the achievable set is a disc.
  Anisotropy enters only through the gravity gradient and the arrival-speed
  constraint, both second order over a terminal correction.
- `r_meas` is the term that is genuinely anisotropic, and interestingly so. An
  optical tracker resolves cross-range well and range badly, so the measurement
  ellipse is elongated **along the line of sight**, with semi-axes roughly
  `sigma_angular * d` across and `sigma_range * d` along.

That last point is what ellipses would buy, and it is a real mechanic rather
than a cosmetic one: **two observers at different bearings collapse a
line-of-sight-elongated ellipse to the intersection of two thin slabs.** That
turns observer placement into a geometry puzzle instead of a range upgrade, and
it is a much better justification for forward observers than "shrinks the box".

Recommendation: ship circles in version one, keep the field for a per-axis
`r_meas`, and hold the two-observer triangulation mechanic as the first
extension. It fits section 4.7's existing claim that observers shrink the
measurement term while leaving staleness untouched.

### 6.5 What the corrected `r_reach` implies for level design

The interesting consequence is a hard link between the box, the correction
window and the probe's **sensor range**. Covering a box of radius `r_box`
requires the correction at least `t_go = r_box/dv + dv/(2 a_max)` before impact,
and the probe must be able to *see* the contact by then, so it needs a sensor
range of `v_closing * t_go` (`p10_reach_windows.py`, P10a; `a_max = 3 m/s^2`,
closing speed 200 km/s, contact at 1 g):

| range | `r_box` | dv budget | `t_go` needed | sensor range needed |
|---|---|---|---|---|
| 5 lm | 1 800 km | 0.5 km/s | 3 683 s | 736 667 km |
| 5 lm | 1 800 km | 2 km/s | 1 233 s | 246 667 km |
| 10 lm | 7 200 km | 2 km/s | 3 933 s | 786 667 km |
| 20 lm | 28 800 km | 2 km/s | 14 733 s | 2 946 667 km |
| 20 lm | 28 800 km | 5 km/s | 6 593 s | 1 318 667 km |
| 40 lm | 115 200 km | 5 km/s | 23 873 s | 4 774 667 km |

And read the other way, the largest box one probe can ever cover given its
sensor range (P10c):

| sensor range | `t_go` | dv=0.5 km/s | dv=1 | dv=2 | dv=5 | dv=10 |
|---|---|---|---|---|---|---|
| 10 000 km | 50 s | 4 km | 4 km | 4 km | 4 km | 4 km |
| 50 000 km | 250 s | 83 km | 94 km | 94 km | 94 km | 94 km |
| 100 000 km | 500 s | 208 km | 333 km | 375 km | 375 km | 375 km |
| 500 000 km | 2 500 s | 1 208 km | 2 333 km | 4 333 km | 8 333 km | 9 375 km |
| 1 000 000 km | 5 000 s | 2 458 km | 4 833 km | 9 333 km | 20 833 km | 33 333 km |

Below a few hundred thousand km of sensor range the thrust limit binds and extra
delta-v buys nothing at all. **Probe sensor range is therefore a first-class
difficulty dial, currently missing from GAME-0001 section 5**, and it is the
parameter that decides whether a level's answer is a conditional clause, a wave,
or neither. That is worth stating explicitly because it is the numerical
backbone of the "Authority" and "Wave" campaign beats.

---

## 7. Exposure

### 7.1 The law

```
rate(r, psi) = k / max(r, r_core)^2 * chi(psi)      for r <= R_halo, else 0
chi(psi)     = chi_0 + (1 - chi_0) * |sin psi|
E            = integral of rate dt,  probe lost at E >= 1
```

`psi` is the angle between the probe's long axis, which is slaved to its
velocity, and the line to the source, so on a straight pass `|sin psi| = b/r`
where `b` is the miss distance. `chi_0 = A_nose / A_side` is the ratio of the
presented areas head-on and broadside. `k` has units of m^2/s.

`r_core` is not in the design document and is the correction described in
section 7.4.

### 7.2 Closed form for a straight pass

With `b <= R_halo` and `L = sqrt(R_halo^2 - b^2)`:

```
I2 = integral dt / r^2 = (2 / (b v)) * atan(L / b)
I3 = integral dt / r^3 = (2 / (b^2 v)) * (L / R_halo)

E(b, v) = (k / (b v)) * [ 2 chi_0 atan(L/b) + 2 (1 - chi_0) L / R_halo ]
```

For a deep pass, `R_halo >> b`, `atan -> pi/2` and `L/R_halo -> 1`:

```
E -> K / (b v)      with      K = k * (chi_0 * pi + 2 * (1 - chi_0))
```

**Exposure is inversely proportional to the product of miss distance and speed.**
Survivability is the single hyperbola `b * v = K` in the plane the planner draws,
which makes the whole hazard tunable with one number.

Verified against over-resolved numerical integration (`p8_exposure.py`, P8a):
agreement to between 2.0e-15 and 1.2e-12 relative across five miss distances and
two speeds. The closed form is exact, not an approximation.

### 7.3 Calibration

Pick one reference pass and everything else follows. Taking **"at 200 km/s a
3 000 km miss is exactly lethal"** with `chi_0 = 0.25` and `R_halo = 30 000 km`:

```
K = b_ref * v_ref = 6.0e11 m^2/s
k = K / (chi_0 * pi + 2*(1 - chi_0)) = 2.6254e11 m^2/s
```

| v (km/s) | lethal miss distance | as a multiple of `r_box` at 5 lm, 1 g |
|---|---|---|
| 100 | 6 000 km | 3.33 |
| 150 | 4 000 km | 2.22 |
| 200 | 3 000 km | 1.67 |
| 250 | 2 400 km | 1.33 |
| 300 | 2 000 km | 1.11 |

The lethal miss distance is deliberately comparable to the uncertainty box.
That is what makes the two mechanics interact: the box says where you might have
to go, and the halo says how fast you have to be going when you get there.

Exposure table (P8d), `E >= 1` means lost:

| b (km) | v=50 | v=100 | v=150 | v=200 | v=300 |
|---|---|---|---|---|---|
| 500 | 23.910 | 11.955 | 7.970 | 5.978 | 3.985 |
| 1 000 | 11.908 | 5.954 | 3.969 | 2.977 | 1.985 |
| 2 000 | 5.904 | 2.952 | 1.968 | 1.476 | **0.984** |
| 3 000 | 3.899 | 1.950 | 1.300 | **0.975** | 0.650 |
| 5 000 | 2.290 | 1.145 | **0.763** | 0.573 | 0.382 |
| 8 000 | 1.376 | **0.688** | 0.459 | 0.344 | 0.229 |
| 12 000 | **0.855** | 0.428 | 0.285 | 0.214 | 0.143 |
| 20 000 | 0.404 | 0.202 | 0.135 | 0.101 | 0.067 |

This is "fast and oblique survives, slow and head-on does not" as a table, and
the survival boundary sweeps diagonally across it exactly as the design wants.

### 7.4 The divergence, and the core radius

**With a pure `1/r^2` flux the model is broken for the case the game is actually
about.** For a probe on a radial approach, `E` accumulated from `R_halo` down to
`r` is `(k chi_0 / v)(1/r - 1/R_halo)`, which diverges as `r -> 0`. It crosses
`E = 1` at `r ~ k chi_0 / v = 328 km`, which at 200 km/s is **1.6 seconds before
impact**. So every probe that strikes a haloed contact is destroyed just short
of arrival, no matter how it is flown. `p8_exposure.py` P8e shows exposure at
impact between 0.33 and 656 depending on the assumed impact radius: the model as
written has no stable answer at all, because the answer depends on a quantity
(the target's radius) the design never intended to be a hazard parameter.

**Fix: a core radius.** Flatten the flux inside `r_core`:

```
flux(r) = k / max(r, r_core)^2
```

Head-on exposure becomes finite and, more importantly, becomes a speed trade:

```
E_headon(v) = (k chi_0 / v) * (2/r_core - 1/R_halo)
```

With `r_core = 500 km` and the calibration above (`p9_box_exposure2.py`, P9a):

| v (km/s) | E at impact | outcome |
|---|---|---|
| 100 | 2.603 | lost |
| 150 | 1.736 | lost |
| 200 | 1.302 | lost |
| 250 | 1.041 | lost |
| **260** | **1.001** | threshold |
| 300 | 0.868 | survives |
| 400 | 0.651 | survives |

A head-on impactor now survives above about 260 km/s and dies below it, which is
the intended pressure toward expensive high-energy terminal geometry, expressed
as a number the player can read off the exposure strip. `r_core` is a per-halo
level parameter alongside `k` and `R_halo`.

There is a second, complementary option worth considering with the mechanics
work: **a terminal commit radius**, inside which a probe destroyed by exposure
still delivers its mass at the same closing speed. That is physically honest
(a shattered impactor's fragments arrive anyway) and it removes the frustrating
outcome of being killed 300 km short. The two can coexist.

### 7.5 Accumulating exposure without a stiff ladder

The naive accumulation `E += rate(r_mid) * h` is badly wrong at `dt = 60`
because `1/r^2` varies by orders of magnitude across a substep near closest
approach. But **the same closed form that gives the whole-pass integral also
gives one substep's contribution**, treating the substep as a straight chord:

```
s0 = signed sqrt(r0^2 - b^2);   s1 = signed sqrt(r1^2 - b^2)
dE = k * [ chi_0 * (atan(s1/b) - atan(s0/b)) / (b v)
         + (1 - chi_0) * (s1/sqrt(b^2+s1^2) - s0/sqrt(b^2+s0^2)) / (b v) ]
```

Comparison against the exact whole-pass value, `dt = 60 s`
(`p9_box_exposure2.py`, P9b; "pt" is point sampling, "cf" is the closed form):

| b (km) | v | exact | pt L=0 | cf L=0 | pt L=2 | cf L=2 | pt L=4 | cf L=4 |
|---|---|---|---|---|---|---|---|---|
| 3 000 | 200 | 0.9748 | 1.8426 | **0.9651** | 0.9645 | 0.9734 | 0.9746 | 0.9746 |
| 1 000 | 200 | 2.9770 | 15.8217 | **2.9688** | 1.8749 | 2.9757 | 2.9729 | 2.9767 |

**At `L = 0` the closed form is already within 1 %, where point sampling is 89 %
and 431 % wrong.** Point sampling needs `L = 4` to `L = 8` to catch up
(`p8_exposure.py`, P8f), which would mean a third ladder term competing with the
gravitational ones. The closed form removes that entirely.

Two implementation notes. The substep-local `b` is the perpendicular distance
from the source to the substep's chord, computable from the endpoints with dot
products only. And the core radius has to be folded in by splitting a substep
that crosses `r = r_core`, exactly as `E_pass` does in the probe script.

The planner's exposure strip must come from this same accumulation running along
the ghost, not from the whole-pass formula, because rule 11 requires every
displayed number to originate in the simulation and rule 9 requires the planner
to use the simulation's code path. The whole-pass closed form is a **designer's
tool** for choosing `k`, not a runtime path.

---

## 8. State hashing, seeded randomness, serialisation

### 8.1 State hash

FNV-1a over the raw bit patterns of the state's doubles, in two 32-bit lanes
with different multipliers, concatenated to 64 bits:

```
function hashF64(arr, n):
    a = 0x811c9dc5;  b = 0x01000193
    for i in 0 .. n-1:
        v = arr[i]
        if v === 0: v = 0                       # collapse -0 to +0
        (h, l) = bit words of v
        a = imul(a ^ l, 0x01000193);  a = imul(a ^ h, 0x01000193)
        b = imul(b ^ h, 0x85ebca6b);  b = imul(b ^ l, 0x85ebca6b)
    return hex(a) ++ hex(b)
```

Two details that are easy to get wrong and would produce a flaky golden-replay
test.

- **`-0` must be canonicalised.** `-0 === 0` is true, so two states that compare
  equal in every way can have different bit patterns and hash differently. A
  velocity component that reaches exactly zero from below is enough to trigger
  it. Verified (`q2_selftest.mjs`, Q2c): `hash([1, -0, 3.5, 1e11])` and
  `hash([1, +0, 3.5, 1e11])` both give `10f55b836550e295`.
- **NaN must never appear.** There are 2^52 distinct NaN bit patterns and
  arithmetic is not required to preserve which one. A development-build NaN
  guard over the state arrays after each tick is cheap and turns a
  hash-mismatch mystery into an immediate assertion.

Sensitivity and cost: changing the last value by one ulp changes the hash
(`0ef319c6df65182a`). Hashing 60 000 doubles takes **0.158 ms**, so hashing
every tick is affordable in tests and hashing at checkpoints is free in play.

Iterating 32-bit words rather than bytes departs from canonical FNV-1a. That is
fine: this is a test oracle, not a cryptographic or a portable-format hash. It
should be labelled as an FNV-1a-style word hash so nobody expects reference
vectors to match.

### 8.2 Named random streams

splitmix32 for seeding, sfc32 for generation, one stream per named purpose:

```
function makeStream(levelSeed, name):
    nameHash = FNV-1a-32 over the name's char codes
    sm = splitmix32(levelSeed ^ nameHash)
    state = [sm(), sm(), sm(), sm()]            # four uint32
    discard 12 draws                            # warm-up
    return state

function sfc32(st):                             # Doty-Humphrey, PractRand
    t = (st[0] + st[1] | 0) + st[3] | 0
    st[3] = st[3] + 1 | 0
    st[0] = st[1] ^ (st[1] >>> 9)
    st[1] = st[2] + (st[2] << 3) | 0
    st[2] = ((st[2] << 21) | (st[2] >>> 11)) + t | 0
    return t >>> 0
```

Measured (`q2_selftest.mjs`, Q2d): three named streams reproduce exactly from
the same `(levelSeed, name)` pair and produce visibly independent sequences;
chi-square over 16 top-nibble bins with N = 4e6 is **10.53** against an
expectation of 15 with 15 degrees of freedom; throughput **803 Mdraws/s**.

Rules that follow from the determinism contract and are worth writing into the
implementation:

- The four words of every stream are **part of the serialised state**. Drawing
  is a state mutation.
- Streams are advanced only from inside the simulation. A renderer that draws
  from `sensor_noise` to jitter a sprite silently desynchronises the replay.
- Draw order must be fixed. Debris ejection iterates by object index; culling
  uses a stable key (oldest by creation tick, then by index).
- `sfcUnit` divides by exactly `2^-32`, a power of two, so the conversion to
  `[0, 1)` is exact and never rounds.
- Deriving the stream seed from a hash of the name means adding a stream cannot
  perturb the sequences of existing ones. Deriving them from a counter would,
  and would silently invalidate every golden replay on any refactor.

### 8.3 Serialisation layout

A level run is `(level_id, seed, ordered command log)`. Everything else derives.
Dense typed arrays in structure-of-arrays form, no maps, no sets, no object
graphs:

| Block | Type | Notes |
|---|---|---|
| `tick` | int32 | the only clock |
| `level_id`, `seed` | uint32 | identify the run |
| `count`, `capacity` | int32 | dense object arrays, iterated by index |
| `kind[]` | uint8 | probe, contact, debris chunk |
| `x[] y[] vx[] vy[]` | float64 | position and velocity |
| `mass[] prop[] exposure[] dvAcc[]` | float64 | per object |
| `burnNode[] burnEnd[] nx[] ny[]` | int32 / float64 | active burn, frozen direction |
| `createdTick[] parentId[]` | int32 | stable culling keys |
| `level[]` | int32 | last substep level, cached for the renderer only |
| `history` | float64 ring buffer | past states for the downlink solver (8.5) |
| `streams` | uint32 x 4 x nStreams | RNG state, one row per named stream |
| `commandLog` | records | `(tick, kind, payload)`, quantised integers |
| `hash` | uint64 | of everything above, for the round-trip test |

Serialise doubles as **raw bit patterns**, not decimal text. `Number.toString`
round-trips exactly per the specification, so text would also be lossless, but
binary is smaller and removes the question entirely.

Two things must **not** be in the state: anything derived that could be
recomputed inconsistently (cached ephemeris values, cached ghosts), and anything
the renderer owns. The `level[]` array is the one exception and should be marked
as advisory, recomputed at load rather than trusted.

Command log payloads should be **quantised integers**. A launch heading stored as
1/65536 of a turn, a burn component stored in mm/s, a time stored as an integer
tick. That makes the log independent of the UI's floating-point path and makes
undo, replay and debrief exact by construction rather than by luck.

### 8.4 A startup self-check

Since the whole strategy rests on `+ - * / sqrt` being identical everywhere,
prove it at startup instead of assuming it:

```
KERNEL_GOLDEN = "..."          # hash of dsin/dcos/datan2/dexp/dlog/solveKepler
                               # over a fixed 256-value input vector
assert hashF64(runKernelVector()) === KERNEL_GOLDEN
```

It takes microseconds, it runs on every platform the game ships to, and it turns
"cross-platform bit-identity is a stretch goal" into a measurable, monitored
property. The 18 bit patterns in section 2.6 are a ready-made seed for that
vector.

### 8.5 Determinism of the tick loop, measured

`q4_perf.mjs`, Q4d, 500 ticks of a 50-object flyby scenario, hashing all
position, velocity and exposure state:

| run | hash | |
|---|---|---|
| run 1 | `205bb34b7a537ac9` | |
| run 2 | `205bb34b7a537ac9` | identical |
| save and reload at tick 250 | `205bb34b7a537ac9` | identical |

Not a substitute for the contract's five required tests, but it confirms that
the structure proposed here (integer tick, dense arrays, per-object ladder,
grouped PEFRL, no libm) is determinism-clean as built.

---

## 9. Performance

All measurements on Node 24.14.0, x64, single thread (`q5_perf2.mjs`).

### 9.1 Component costs

| Operation | Cost |
|---|---|
| `dsincos(x)` | **22.0 ns** |
| `Math.sin` + `Math.cos` (banned) | 16.3 ns |
| `solveKepler(M, e)`, 3 `dsincos` | **164.6 ns** |
| `ephemeris(t)`, 6 bodies, 5 Kepler solves | **805.6 ns** |
| `accel()`, 6 attractors | 29.1 ns |
| `levelFor()`, 6 bodies, both ladders | 28.5 ns |

The own kernels cost **35 % more than libm**, which is the entire price of
determinism and is not worth a second thought. `solveKepler` is dominated by its
nine sequential divisions (three per Danby iteration), not by the trig; Halley
would trade a division for a trig pair and is not obviously better.

**The ephemeris is a fixed per-tick cost independent of object count**, because
one evaluation serves every object at that instant. At 50 objects it is about a
third of the tick; at 200 objects a sixth.

### 9.2 Tick throughput

`dt = 60 s`, `eta = 0.05`, `zeta = 1/32`, `L_MAX = 10`, PEFRL, 6 attractors:

| scenario | objects | ticks/s | max L | eph/tick | substeps/tick | simulated days per wall second |
|---|---|---|---|---|---|---|
| cruise | 1 | 235 226 | 0 | 5.0 | 1.0 | 163.4 |
| **cruise** | **50** | **85 936** | 0 | 5.0 | 50.0 | **59.7** |
| cruise | 200 | 29 296 | 0 | 5.0 | 200.0 | 20.3 |
| flyby | 50 | 85 207 | 0 | 5.0 | 50.0 | 59.2 |
| flyby | 200 | 29 618 | 0 | 5.0 | 200.1 | 20.6 |
| graze | 50 | 83 138 | 3 | 5.1 | 50.3 | 57.7 |
| graze | 200 | 27 675 | 6 | 5.8 | 205.4 | 19.2 |

"cruise" scatters objects at 1 to 3 AU; "flyby" puts every object on a circular
orbit at 1.1 Jupiter radii; "graze" puts every object on a 220 km/s hyperbolic
pass at 1.05 Jupiter radii.

**The design's premise that the simulation is cheap is correct with room to
spare.** 50 objects run at 86 000 ticks per second, which is sixty simulated days
per wall second.

### 9.3 Worst case, with the level pinned

The scenario averages above understate the peak, because objects leave a tight
flyby within a few ticks. Pinning the level so the whole tick runs at `2^L`
substeps gives the true bound (Q5d, 50 objects):

| L | substeps | ticks/s | microseconds per tick | simulated days per wall second | cost of x1e6 warp |
|---|---|---|---|---|---|
| 0 | 1 | 85 628 | 11.7 | 59.5 | 3.2 ms/frame |
| 2 | 4 | 24 638 | 40.6 | 17.1 | 11.3 ms/frame |
| 4 | 16 | 6 613 | 151.2 | 4.6 | 42.0 ms/frame |
| **6** | **64** | **1 701** | **587.8** | **1.18** | 163 ms/frame |
| 8 | 256 | 432 | 2 314.5 | 0.30 | 643 ms/frame |

Even with all fifty objects pinned at level 8 (256 substeps of 0.23 s) the
simulation runs 0.3 simulated days per wall second, so real time and the lower
warp rungs stay comfortable. The top rungs become unaffordable during a deep
flyby, which is exactly when GAME-0001 section 4.11's automatic drop to x1 turns
them off anyway. The two mechanisms agree, which is a good sign.

### 9.4 Warp ceiling

At 84 000 ticks/s and an 8 ms per-frame simulation budget (half a 60 Hz frame),
`dt = 60 s`:

| warp | ticks per frame | ms per frame | |
|---|---|---|---|
| x1 000 | 0.28 | 0.003 | affordable |
| x10 000 | 2.78 | 0.033 | affordable |
| x100 000 | 27.8 | 0.331 | affordable |
| x1 000 000 | 277.8 | 3.31 | affordable |

**Every rung up to a million times real time fits inside half a frame during
cruise.** The practical ceiling is not throughput at all: it is the automatic
drop to x1 on events of interest, and the fact that a multi-week flight is only
20 160 ticks at `dt = 60`. A 14-day flight replays end to end in **264 ms**.

### 9.5 Planner budget

The demanding case, as the determinism document correctly identifies, is
planner scrubbing. Re-integrating one ghost over a 14-day plan is 20 160 ticks
for a single object, which at 235 000 ticks/s is **86 ms**. That is five frames,
so a full re-solve on every mouse move is too slow but a re-solve on drag
release is comfortable. The document's advice stands and is now quantified:

- Cache ghost integrations and invalidate from the earliest edited node forward,
  not the whole plan. Editing the last of four nodes then costs a quarter of 86
  ms.
- Store a checkpoint state every 256 ticks along the ghost (about 79 checkpoints
  for a 14-day plan, 4 kB) so a re-solve restarts from the checkpoint before the
  edited node instead of from launch.
- Horizon scrub is free for tier one, which is closed form, and reads the cached
  ghost for tier two. No integration at all.

### 9.6 A note on where this could go faster, if it ever needs to

None of this is needed at these numbers, but for the record, in order of
value: precompute per-body rotation constants (already assumed, and worth 25 %);
hoist the ephemeris out of the innermost loop by level group (already assumed);
and, only if a level ever wants many objects simultaneously deep in a well,
**freeze the far field**, re-evaluating only the dominant attractor per substep
and the rest once per tick. That last one is determinism-safe if the rule is
state-driven (a body whose contribution falls below a fixed fraction of the
total acceleration is evaluated at the tick midpoint), and it would cut the
level-8 cost by roughly the ratio of near to far bodies. It changes the
numerical answer, so it belongs in the contract or not at all.

---

## 10. Suggested test matrix

Mapping the contract's five required tests onto the numbers above, plus the ones
this note argues are missing.

| Test | Assertion | Source of the number |
|---|---|---|
| Kernel golden vector | hash of `dsin`/`dcos`/`datan2`/`dexp`/`dlog`/`solveKepler` over 256 fixed inputs matches a stored constant | section 2.6, 8.4 |
| Kepler residual | `\|E - e sinE - M\| <= 1e-15` for `e` in [0, 0.8], 4096 mean anomalies | section 1.2 |
| Reduction bound | `dsin` asserts `\|x\| <= 2^18`; ephemeris asserts `M` in `[0, 2pi)` | section 2.2 |
| Body eccentricity | level load asserts `e <= 0.8` per body | section 1.2 |
| Topological body order | level load asserts `parent[i] < i` | section 1.4 |
| **Flyby accuracy** | grazing pass of every body class at 100/200/300 km/s, downstream miss over 10 days under 1 km against the analytic hyperbolic solution | section 4.5, 4.7 |
| **Per-level `dt` validation** | the above, run for each shipped level's own `dt` and tightest permitted flyby | GAME-0001 section 9, open question 1 |
| Ghost invariant | committed plan with no amendments is bit-identical to the planner's trajectory | contract |
| **Ghost isolation** | the same probe integrated alone and among 200 other objects gives an identical hash | section 4.3 |
| Warp invariance | identical final hash at every warp factor | contract |
| Golden replay | `(level_id, seed, command log)` replays to a stored hash | contract |
| Serialisation round-trip | save, reload, continue matches the uninterrupted run | contract, verified in 8.5 |
| Substep determinism | a trajectory crossing level boundaries reproduces across save and reload either side | contract |
| `-0` canonicalisation | a state with `-0` hashes equal to the same state with `+0` | section 8.1 |
| NaN guard | development builds assert no NaN in the state arrays after each tick | section 8.1 |
| Light cone | 3 Newton iterations agree with 12 to within 1e-9 s over 4 000 emission times at 40 light-minutes | section 5.2 |
| Burn magnitude | delivered delta-v equals the node's request to within 1e-9 relative | section 3.6 |
| Exposure closed form | per-substep accumulation along a straight pass agrees with the analytic chord integral to 1e-3 at `L = 0` | section 7.5 |
| Reachable set | `r_reach` matches the analytic burn-then-coast displacement | section 6.2 |

---

## 11. Probe scripts

All under
`scratchpad/research/sim-probe/`.
Python 3.12 standard library only, Node 24 with no dependencies.

| Script | What it establishes |
|---|---|
| `p1_flyby_analytic.py` | Deflection angles for five body classes, confirming the design table; free delta-v; encounter durations |
| `p2_kepler.py` | Kepler solver accuracy: 5 starters x 3 correctors x 4 iteration counts x 11 eccentricities against a 60-digit reference |
| `p3_dtrig.py` | `dsin`/`dcos`/`datan2`/`dexp`/`dlog` implementations and ulp measurements |
| `p3b_reduction_and_kepler.py` | Cody-Waite exactness bound with exact rational arithmetic; Kepler on the own kernels |
| `p4_integrator.py` | Exact hyperbolic reference propagator; Verlet, Yoshida4, PEFRL, RK4; both ladders |
| `p5_ladder.py` | Ladder comparison, `zeta` sweep, base-timestep sweep, Verlet-versus-PEFRL under the ladder, slow-object case |
| `p6_ladder_robust.py` | One-level-per-tick blind spot; time-dependent field with a moving attractor |
| `p7_lightcone.py` | Uplink and downlink Newton convergence, fixed-point comparison, tick quantisation |
| `p8_exposure.py` | Closed form against numerical integration; calibration; the divergence at contact; point-sampling stiffness |
| `p9_box_exposure2.py` | Core radius; per-substep closed-form accumulation; corrected `r_reach`; intercept confidence |
| `p10_reach_windows.py` | Correction windows and required sensor range implied by the corrected `r_reach` |
| `p11_burn.py` | Finite burn with mass depletion; delivered delta-v against target; accumulator variant |
| `q1_core.mjs` | TypeScript-ready reference implementation: kernels, Kepler, hashing, splitmix32, sfc32 |
| `q2_selftest.mjs` | Node-side kernel accuracy, Kepler grid, `-0` hashing, RNG independence and throughput |
| `q3_crosscheck.py` | CPython versus V8 bit-pattern comparison, 18 values |
| `q4_perf.mjs` | First throughput pass, and the determinism check in section 8.5 |
| `q5_perf2.mjs` | Corrected throughput: component costs, three scenarios, pinned-level worst case, warp ladder |

Two probes were wrong on their first run and are worth flagging so nobody
repeats the mistakes. `p3_dtrig.py` initially converted floats to `Decimal`
through `repr()`, which loses up to half an ulp and produced spurious 1e-8
errors that looked like a broken range reduction. `q4_perf.mjs` left `Math.cos`
and `Math.sin` calls for the per-body rotation inside the tick loop, which was
both a 25 % throughput loss and a determinism violation of exactly the kind this
note is about; `q5_perf2.mjs` is the corrected version and its numbers are the
ones to quote.

---

## 12. References

Astrodynamics.

- R.R. Bate, D.D. Mueller, J.E. White, *Fundamentals of Astrodynamics*, Dover,
  1971, chapters 1 and 7. Hyperbolic encounter geometry and the deflection
  relation `sin(theta/2) = 1/e`.
- D.A. Vallado, *Fundamentals of Astrodynamics and Applications*, 4th edition,
  Microcosm, 2013, section 12.4. Gravity-assist geometry.

Kepler's equation.

- J.M.A. Danby, T.M. Burkardt, "The solution of Kepler's equation, I",
  *Celestial Mechanics* **31** (1983) 95. The quartic corrector used here.
- J.M.A. Danby, "The solution of Kepler's equation, III", *Celestial Mechanics*
  **40** (1987) 303. The `0.85 e` starter.
- S. Mikkola, "A cubic approximation for Kepler's equation", *Celestial
  Mechanics* **40** (1987) 329. Tested and rejected here.
- F.L. Markley, "Kepler equation solver", *Celestial Mechanics and Dynamical
  Astronomy* **63** (1995) 101. The non-iterative alternative, rejected for
  needing a cube root.

Symplectic integration.

- H. Yoshida, "Construction of higher order symplectic integrators", *Physics
  Letters A* **150** (1990) 262. The triple-jump construction, measured here and
  found to have too large an error constant.
- I.P. Omelyan, I.M. Mryglod, R. Folk, "Optimized Forest-Ruth- and Suzuki-like
  algorithms for integration of motion in many-body systems", *Computer Physics
  Communications* **146** (2002) 188. **PEFRL, the recommendation.** The
  coefficients used here are that paper's, and the 4th-order convergence and
  small error constant are independently confirmed by section 3.3.

Floating point and libm.

- IEEE 754-2019, *Standard for Floating-Point Arithmetic*. Correct rounding is
  mandated for `+ - * /` and `sqrt`, and for nothing transcendental. This is the
  whole basis of the safe-operation set.
- FDLIBM 5.3, Sun Microsystems, 1993, public domain. Source of every kernel
  coefficient in section 2.4. The same constants ship in musl libm, Go's `math`
  package and Java's `StrictMath`, which is three independent validations at the
  1-ulp level.
- W.J. Cody, W. Waite, *Software Manual for the Elementary Functions*,
  Prentice-Hall, 1980. The multi-part argument reduction.
- ECMA-262, `Math` object. Most `Math` functions are explicitly
  implementation-approximated, which is the specification-level reason the sim
  cannot use them. `Math.sqrt` is in the same category in the specification text
  but is universally the hardware instruction; section 8.4 covers the gap.

Randomness.

- C. Doty-Humphrey, PractRand. sfc32.
- G.L. Steele, D. Lea, C.H. Flood, "Fast splittable pseudorandom number
  generators", OOPSLA 2014. splitmix64, of which the 32-bit variant used here
  (constants `0x9e3779b9`, `0x21f0aaad`, `0x735a2d97`) is a widely used
  community adaptation rather than a published algorithm. Treated here only as a
  seed expander, which is all it needs to be.
- G. Fowler, L.C. Noll, K.-P. Vo, FNV hash. Note that iterating 32-bit words
  rather than bytes, as section 8.1 does, means this is FNV-1a-*style* and its
  outputs will not match published FNV vectors.

Citations were written from established literature; this session's web-search
budget was exhausted before they could be re-verified against the publishers,
so treat volume and page numbers as high-confidence but unconfirmed. Every
*numerical* claim in this note is independently reproducible from the probe
scripts and does not depend on the citations being right.
