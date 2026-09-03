# Level definition format and solvability evidence

Research for Graviton, 2026-09-03. Every number below was measured on this
machine (Node 24.14.0, pnpm 11.25.0, esbuild 0.28.2) rather than recalled.
Working files are in `../sizelab/`.

## Recommendations in one page

| Question | Answer |
|---|---|
| Authoring format | YAML 1.2, pinned, one `.level.yaml` per level |
| Runtime format | Canonical JSON, compiled at build time. No YAML parser ships. |
| Validation | `valibot` 1.4.2 |
| Editor support | JSON Schema generated from the valibot schema via `@valibot/to-json-schema` 1.7.1 |
| Units | Dimension-scoped suffix strings (`radius: 71492 km`), resolved during validation |
| Palette and glyphs | Separate body-class table in the renderer package, never in the level file |
| Solvability evidence | Recorded command log at full double precision, replayed in CI, plus a generated per-level evidence report |
| Automated solver | Build it in v1. It is roughly 200 lines and finds a level's launch solution in 41 seconds. |

---

# Part A — the level definition format

## A.1 Measured cost of each candidate

Bundle sizes, `esbuild --bundle --minify --format=esm --platform=browser`, then
`gzip -9`. Each parser entry is a realistic import, not a bare `import`.

| Parser | minified | min+gzip |
|---|---|---|
| `JSON.parse` (built in) | 42 B | 76 B |
| `smol-toml` 1.8.0 | 10 993 B | 4 381 B |
| `json5` 2.2.3 | 32 439 B | 9 901 B |
| `js-yaml` 5.4.1 | 46 036 B | 13 488 B |
| `yaml` 2.9.0 | 97 756 B | 30 442 B |

Parse throughput on one realistic level (6.0 kB of JSON, 4.5 kB of YAML):

| Parser | per parse |
|---|---|
| `JSON.parse` | 0.013 ms |
| `js-yaml` 5.4.1 | 0.215 ms |
| `yaml` 2.9.0 | 1.872 ms |

`yaml` is 144 times slower than `JSON.parse` and 30 kB heavier. Neither matters
once levels are compiled at build time, and both matter if they are not. That
single observation decides the runtime format on its own.

## A.2 Measured cost of each validator

Same build settings, each entry building the full Graviton level schema
described in A.6 and exposing a `parseLevel` function.

| Validator | minified | min+gzip |
|---|---|---|
| `valibot` 1.4.2 | 10 675 B | 3 355 B |
| `ajv` 8.20.0, precompiled standalone | 83 623 B | 8 106 B |
| `zod/mini` 4.5.4 | 29 847 B | 9 331 B |
| `@sinclair/typebox` 0.34.52 + `Value.Check` | 107 463 B | 26 262 B |
| `zod` 4.5.4, named imports | 99 207 B | 28 230 B |
| `ajv` 8.20.0, compiling at runtime | 139 550 B | 41 478 B |
| `zod` 4.5.4, `import { z } from 'zod'` | 435 674 B | 87 698 B |

Two results here are worth keeping.

The `zod` namespace import costs **87.7 kB gzipped**, and rewriting the identical
schema with named imports drops it to 28.2 kB. Zod's own documentation says the
method-chained API resists tree-shaking; this measures how much. If the project
ends up on Zod for other reasons, the lint rule banning `import { z }` is worth
more than the library choice.

`ajv` in standalone mode is a strong result (8.1 kB) but that number is the
*generated validator for this one schema*, produced at build time by
`ajv/dist/standalone`. It grows per schema and it forfeits static types, which
have to be reintroduced with a separate `json-schema-to-ts` step. Note also that
`ajv`'s default export only speaks draft-07; draft 2020-12 needs
`ajv/dist/2020.js`, which is not obvious and cost time to discover.

## A.3 Format behaviour, measured

The interesting differences are not syntax, they are what each format does when
the author makes a mistake. An AI agent will be authoring these files, so silent
acceptance of a mistake is the expensive failure mode.

| Behaviour | YAML 1.2 | JSON5 | TOML | JSON |
|---|---|---|---|---|
| Comments | yes | yes | yes | **no** |
| Duplicate key | **error** | **silently last wins** | **error** | silently last wins |
| Tab used as indent | error, `TAB_AS_INDENT` | n/a | n/a | n/a |
| `no` / `yes` / `on` become booleans | no, they stay strings | n/a | n/a | n/a |
| `12:30` becomes a number | no, stays a string | n/a | n/a | n/a |
| Anchors, aliases, merge keys | yes | no | no | no |
| Value located to line and column | yes | limited | limited | limited |
| Lines for the same level fragment | **26** | ~30 | **41** | ~35 |

Three of these decide the choice.

**JSON5 silently drops duplicate keys.** `JSON5.parse('{"mass":1,"mass":2}')`
returns `{"mass":2}` with no diagnostic. In a level file, a duplicated `mass` or
`radius` is a physics change that produces a level that looks authored and does
not work. YAML and TOML both refuse it. This alone removes JSON5 and plain JSON
from consideration as an authoring format.

**The YAML footguns people warn about are 1.1 footguns.** Both `yaml` 2.9.0 and
`js-yaml` 5.4.1 default to the 1.2 core schema, where `no` stays the string
`"no"`, `12:30` stays a string, and `071` is seventy-one rather than octal. The
same document parsed with `version: '1.1'` gives `false`, `750` and `57`. So the
compiler must pin `version: '1.2'` explicitly and reject any `%YAML 1.1`
directive in a level file. With that pinned, the Norway problem does not exist
here.

**TOML is 58% more lines and positionally fragile.** The same body list needs
41 lines in TOML against 26 in YAML, because every nested object becomes its own
`[bodies.orbit]` header. Worse, that header attaches to whichever `[[bodies]]`
entry came last in the file, so inserting a body above it silently reattaches
the orbit to the wrong planet and still parses. For a file that is a list of
lists of objects, which is exactly what a star system is, TOML is the wrong
shape.

## A.4 What YAML buys that the others do not

Two capabilities were prototyped end to end and both worked
(`../sizelab/proto.mjs`).

**Anchors and merge keys give real reuse.** A probe archetype declared once and
referenced from several probes:

```yaml
defaults:
  probe: &sweeper
    dryMass: 420 kg
    exhaustVelocity: 31 km/s
probes:
  - id: prb
    count: 2
    <<: *sweeper
```

This expands correctly with `parseDocument(src, { merge: true })`. No other
candidate format has this, and a twelve-level campaign will reuse probe and
hazard archetypes constantly.

One caveat found: an alias with no matching anchor produces **no error from
`parseDocument`**. It throws from `parse()` and from `doc.toJS()`. The compiler
must therefore wrap `toJS()` in a try/catch and not merely inspect `doc.errors`.

**Validation errors map back to an exact line and column.** `parseDocument`
retains byte ranges on every node, so a valibot issue path converts to a real
source position:

```
proto.level.yaml:37:19  probes.0.clauseBudget: Invalid value: Expected >=0 but received -1
```

That is a clickable diagnostic in an editor and in CI. Producing the same thing
from a `JSON.parse` result requires a separate source-mapping parser. This is
the single strongest argument for YAML as the *authoring* format, and it costs
nothing at runtime because the parser stays in the build.

## A.5 Units: recommended, with a caveat that must be designed around

SI everywhere would mean writing `radius: 71492000` and `rotationPeriod: 35700`.
Both are error-prone by an order of magnitude in a file where a wrong exponent
produces a level that is merely unsolvable rather than invalid. Unit suffixes are
worth having.

**The cost is a genuine ambiguity, and it bit immediately.** A first
implementation with one global unit table parsed `9h 55m` as 32 455 seconds
instead of 35 700, because `m` resolved to metres rather than minutes. That is
not a hypothetical: it is what the prototype printed.

The fix is that **units are scoped by dimension, and the schema knows each
field's dimension**. `m` is metres in a length and minutes in a duration; a unit
from the wrong dimension is a validation error, not a silent conversion.
`../sizelab/units.mjs` implements this and `units.test.mjs` passes all sixteen
cases, including compound durations (`1d 2h 3m 4s` gives 93 784 s) and these
rejections:

```
reject length   "9 h"          unit "h" is not a length unit (accepted: m, km, Mm, Gm, au, ls, lm)
reject duration "5 km"         unit "km" is not a duration unit (accepted: s, m, min, h, d, a)
reject length   "3 furlong"    unit "furlong" is not a length unit
reject length   "5 km banana"  cannot read "5 km banana" as a length
```

**The second cost is a determinism consequence, and it is important.** Unit
conversion rounds. `24.1 d` evaluates to `2082240.0000000002`, one unit in the
last place away from the 2 082 240 an author would expect. The conversion is
deterministic on a given platform, but the value is not the one written in the
file. Therefore:

> The compiled JSON is the canonical level artefact. The level hash that a golden
> replay is keyed on covers the compiled JSON, never the YAML source.

JSON round-trips that double exactly (`JSON.stringify` emits the shortest
representation that reparses identically, verified), so canonical JSON is a
lossless home for it.

Accepting a bare number as already-SI keeps the escape hatch open, so
`radius: 71492000` and `radius: 71492 km` both work and mean the same thing.

## A.6 Recommended schema

Written as the commented example a level author would copy. Every entity the
design mentions appears. Full file, with the reasoning inline.

```yaml
# yaml-language-server: $schema=../schema/level.schema.json
#
# Graviton level definition. Authored here, compiled to canonical JSON by
# `pnpm levels:build`. The compiled JSON is what the game loads and what the
# golden replay hashes; this file is the source, not the artefact.
#
# Numbers are SI unless they carry a unit suffix. Suffixes are scoped by
# dimension, so `m` is metres in a length and minutes in a duration.
#   length    m km Mm Gm au ls lm
#   mass      kg t Mt
#   duration  s m min h d a
#   speed     m/s km/s c
#   accel     m/s2 g
#   force     N kN MN
#   angle     deg rad turn
#   energy    J kJ MJ GJ TJ
#   power     W kW MW GW
#   rate      1/s 1/h

schema: 1                     # format version; the compiler refuses anything else
id: L09-exposure              # matches the filename and the campaign entry
name: The Sheath at Tesh

# One paragraph each, shown before and after the level. The interface is the
# voice, so keep them terse.
brief: >
  A survey tender broke up over Tesh eleven days ago and its reactor is still
  venting. The lane to Ilvaeth Station runs inside the sheath. Clear the hulk.
  Anything you send through the halo is accumulating.
debrief: >
  Exposure is not a die roll. The strip under the timeline was telling you the
  whole flight what a slow head-on approach would cost.

# ---------------------------------------------------------------------------
# Determinism. Every named stream is seeded from `seed` and the stream name, so
# adding a stream never perturbs an existing one.
# ---------------------------------------------------------------------------
seed: 4815162342
streams: [debris_ejection, sensor_noise, hazard_onset]

epoch: 0                      # simulation t=0, in seconds; all anomalies are at epoch
dt: 30 s                      # base timestep. See `substep` and the note below.
substep:
  referenceRadius: 10 Gm      # L = clamp(floor(log2(refRadius / r_nearest)), 0, maxLevel)
  maxLevel: 8                 # validated for this level; see the evidence report
window:
  start: 0
  end: 20 d                   # a contact cleared after this scores nothing

# The clearance post. Fixed position, origin of every order. Either sited on a
# body or given absolute coordinates.
post:
  name: Kerwen Station
  host: sadal
  latitude: 14.2 deg
  longitude: -61.0 deg

# ---------------------------------------------------------------------------
# Tier one. Analytic Keplerian, O(1) at any time, no mutual perturbation.
# Bodies MUST be listed parent-first; the compiler enforces it so the ephemeris
# is a single ordered pass with no recursion.
# ---------------------------------------------------------------------------
bodies:
  - id: kerwen
    name: Kerwen
    class: star                     # rock | ice | gas | molten | metal | star
    mass: 1.71e30 kg
    radius: 612000 km
    rotationPeriod: 25.5 d
    axialPhaseAtEpoch: 0 deg        # surface phase at epoch; rail windows read off this
    # no `orbit`: this is the system primary and sits at the origin

  - id: sadal
    name: Sadal
    class: rock
    mass: 4.9e24 kg
    radius: 6100 km
    rotationPeriod: 25h 33m
    axialPhaseAtEpoch: 22.9 deg
    atmosphereMargin: 120 km        # signal paths graze-fail this far above the surface
    orbit:
      parent: kerwen
      a: 0.92 au
      e: 0.014
      argPeriapsis: 17.8 deg
      meanAnomalyAtEpoch: 0 deg
      direction: prograde           # prograde | retrograde

  - id: ilvaeth
    name: Ilvaeth
    class: gas
    mass: 1.7e27 kg
    radius: 71492 km
    rotationPeriod: 9h 55m
    axialPhaseAtEpoch: 0 deg
    atmosphereMargin: 1500 km
    orbit: { parent: kerwen, a: 1.44 au, e: 0.031, argPeriapsis: 12.0 deg,
             meanAnomalyAtEpoch: 108.9 deg }

  - id: tesh
    name: Tesh
    class: ice
    mass: 8.9e22 kg
    radius: 1820 km
    rotationPeriod: 1.77 d
    axialPhaseAtEpoch: 34.4 deg
    orbit: { parent: ilvaeth, a: 670000 km, e: 0.004, argPeriapsis: 0 deg,
             meanAnomalyAtEpoch: 34.4 deg }

# ---------------------------------------------------------------------------
# Launch rails. A rail inherits its host's spin and orbital velocity, so its
# bearing sweeps and the launch window is a rotation phase.
# ---------------------------------------------------------------------------
rails:
  - id: sadal-north
    name: Sadal North Rail
    host: sadal
    latitude: 61.0 deg
    longitude: 12.5 deg
    # Muzzle speed band. NOTE the magnitude: the design's "intercepts measured in
    # days" requires 60 to 300 km/s. At chemical speeds the same transfer takes
    # 252 days and no solution exists inside any sane window. See B.6.
    muzzleSpeed: { min: 60 km/s, max: 300 km/s }
    # Half-angle of the cone the rail can fire into, about the local vertical.
    # This is what makes rotation phase a real constraint rather than a cosmetic
    # one: with a narrow cone the player must wait for the host to turn.
    headingCone: 69 deg
    reloadTime: 6 h

  - id: sadal-trailing
    name: Sadal Trailing Rail
    host: sadal
    latitude: -8.0 deg
    longitude: 174.0 deg
    muzzleSpeed: { min: 60 km/s, max: 300 km/s }
    headingCone: 69 deg
    reloadTime: 6 h

# ---------------------------------------------------------------------------
# Probes. Delta-v follows from mass and exhaust velocity; mass is tracked
# through burns so impact energy is physically real.
# ---------------------------------------------------------------------------
probes:
  - id: sweeper
    name: Sweeper
    count: 3                        # how many of this type the level grants
    dryMass: 420 kg
    propellantMass: 680 kg
    exhaustVelocity: 31 km/s
    maxThrust: 9.4 kN
    sensorRange: 1.2 Gm
    transmitterRange: 5.0 au
    impactorMass: 120 kg
    crossSection: 3.4              # m^2 presented to a halo; modulates exposure rate
    clauseBudget: 2                # onboard conditional clauses
    nodeBudget: 4                  # burn nodes in the flight plan
    # Which clause conditions this level teaches. Gating the vocabulary per
    # level is how the campaign introduces one idea at a time.
    allowedClauseConditions: [closestApproachBelow, exposureRateAbove, timeElapsed]

# ---------------------------------------------------------------------------
# Contacts. Fixed contacts ride a known ephemeris and have no uncertainty box.
# Mobile contacts are free-flying under thrust and are the box's whole cause.
# ---------------------------------------------------------------------------
contacts:
  - kind: fixed
    id: tender-hulk
    name: Survey Tender (hulk)
    host: tesh                      # rides Tesh's ephemeris exactly
    latitude: -12.0 deg
    longitude: 88.0 deg
    mass: 1.9e6 kg
    radius: 90 m
    captureRadius: 40 km            # within this, the impact resolves
    clearedBy:
      minimumImpactEnergy: 2.4 TJ   # a consolidated hulk: below this it does not break up

  - kind: mobile
    id: drift-9
    name: Drift 9
    mass: 840 t
    radius: 40 m
    captureRadius: 20 km
    state:                          # absolute, at epoch, in the orbital plane
      position: [1.1e11 m, 2.0e9 m]
      velocity: [-3.0 km/s, 21.0 km/s]
    agility: 1 g                    # sustained; this is the campaign's main difficulty dial
    driveBearing: 41.0 deg          # a stuck-open drive points somewhere
    # Collision avoidance is often the last working system on a derelict. This
    # is reflex, not intent. Nothing in Graviton opposes the player.
    avoidance:
      triggerRange: 40000 km
      acceleration: 0.6 g
      lead: 60 s
    clearedBy:
      minimumImpactEnergy: 0.4 TJ

# ---------------------------------------------------------------------------
# Hazards. Passive, physical facts about objects. Nothing here is a defence.
# ---------------------------------------------------------------------------
hazards:
  - kind: halo
    id: tender-sheath
    anchor: tender-hulk             # a contact id or a body id
    radius: 220000 km               # outside this the rate is zero
    peakRate: 3.1e-4                # exposure per second at 1 km, per m^2 presented
    falloffExponent: 2              # inverse square, stated so the planner can draw it
    surveyed: true                  # false means the player does not see it until onset
    # onsetTime: 6.2 d              # only meaningful when surveyed is false

  - kind: hulk
    id: tender-consolidation
    anchor: tender-hulk
    minimumImpactEnergy: 2.4 TJ     # duplicated in clearedBy so the planner can read it

  - kind: stream
    id: shed-belt
    polyline:
      - [1.00e11 m, 1.0e9 m]
      - [1.20e11 m, 3.0e9 m]
      - [1.35e11 m, 2.0e9 m]
    width: 30000 km
    rate: 4.0e-5                    # added to the exposure rate inside the corridor

# ---------------------------------------------------------------------------
# Relays and observers. They defeat occlusion and extend reach. They NEVER
# reduce latency: light travels straight and a relay path is never shorter.
# The schema deliberately has no field that could imply otherwise.
# ---------------------------------------------------------------------------
relays:
  - id: ilvaeth-l4
    name: Ilvaeth Trailing Watch
    role: both                      # relay | observer | both
    host: ilvaeth
    orbit: { parent: ilvaeth, a: 4.1e8 m, e: 0.0, argPeriapsis: 0 deg,
             meanAnomalyAtEpoch: 300 deg }
    range: 6.0 au                   # transmit reach
    angularResolution: 1.2e-8       # radians; shrinks r_meas, never r_stale
    deployable: false               # reserved: v1 ships only pre-placed relays

# ---------------------------------------------------------------------------
# Debris. Bounded and deterministic, derived from impact geometry and the
# named `debris_ejection` stream.
# ---------------------------------------------------------------------------
debris:
  fragmentationEnergy: 0.8 TJ       # below this an impact ejects nothing
  maxChunksPerImpact: 24            # hard ceiling from the design
  liveChunkCap: 240                 # per level; oldest culled first, deterministically
  playVolume: { centre: kerwen, radius: 6 au }   # anything leaving is culled

# ---------------------------------------------------------------------------
# Scoring. Contacts cleared inside the window first, then probes unexpended,
# then delta-v remaining.
# ---------------------------------------------------------------------------
scoring:
  clearedPerContact: 1000
  probeUnexpended: 150
  deltaVRemainingPerKmPerS: 4
  ranks: { bronze: 900, silver: 1500, gold: 2050 }
```

### Notes on specific choices

**`bodies` must be parent-first.** The prototype ephemeris (`../sizelab/sim2.mjs`)
computes every tier-one state in one indexed pass with no recursion and no
lookup, which is both faster and free of the hash-map iteration that determinism
rule 5 forbids. Requiring the author to order the list is a one-line validation
and it removes a whole class of runtime work.

**`captureRadius` is on the contact, not global.** Measured in B.4, this is the
number that decides whether a level is solvable at all, and it differs between a
90 m hulk and a 40 m derelict.

**`headingCone` on the rail is load-bearing.** Without a cone, launch heading is
free and the host's rotation phase never constrains anything, which would make
campaign level 4 unteachable from data.

**`clearedBy.minimumImpactEnergy` appears on both the contact and the hulk
hazard.** They are the same number for the same reason the planner shows it and
the resolver enforces it. The compiler cross-checks them and errors on a
mismatch rather than picking one.

## A.7 Palette and glyphs go in a separate table, in the renderer package

The aesthetic spec says body class drives the palette, with four to six banded
steps per body. Two reasons that table must not live in the level file.

**It would break every golden replay.** The level hash is the input to the
replay test. If an artist retints Ilvaeth, the level file changes, the hash
changes, and twelve passing tests fail for a reason that has nothing to do with
the simulation. Determinism rule 10 says the renderer never writes simulation
state; the same separation has to hold for the inputs.

**The simulation package must not depend on it.** The sim runs headless. A
`palette` key in the level schema means the headless package either carries
colour data it never reads or validates a field it does not own.

So:

```
packages/sim/levels/L09-exposure.level.yaml     # physics only
packages/render/appearance/body-classes.yaml    # palette and glyph table
packages/render/appearance/L09-exposure.yaml    # optional per-level overrides
```

`body-classes.yaml` keys on the six classes the level schema already declares:

```yaml
# Four to six banded steps, no smooth gradients, lit from the system primary.
rock:
  bands: ['#4A4038', '#5C5045', '#6E6055', '#877668', '#A08D7C']
  glyph: circle-filled
  terminator: hard
gas:
  bands: ['#3A4A5C', '#4A5E73', '#5E7389', '#7389A0', '#8CA0B5', '#A6B8C9']
  glyph: circle-banded
  terminator: hard
  ring: false
ice: { bands: [...], glyph: circle-hollow, terminator: hard }
molten: { bands: [...], glyph: circle-filled, terminator: soft, emissive: 0.3 }
metal: { bands: [...], glyph: diamond, terminator: hard, specular: 0.6 }
star: { bands: [...], glyph: star, terminator: none, emissive: 1.0 }
```

A per-level override file keyed by body id handles a signature body that needs
to look unlike its class. Palette changes then touch neither the level hash nor
the sim package.

## A.8 Loading at runtime on GitHub Pages

Levels are compiled to canonical JSON at build time and loaded with
`import.meta.glob`, lazily:

```ts
const levels = import.meta.glob('./levels/*.level.json', { import: 'default' })
export const loadLevel = (id: string) => levels[`./levels/${id}.level.json`]()
```

This is preferable to `fetch` on GitHub Pages for a specific reason: Pages serves
the site from a subpath (`/graviton/`), so every `fetch` needs
`import.meta.env.BASE_URL` threaded through it correctly, and getting it wrong
produces a 404 that only appears in production. `import.meta.glob` makes each
level its own content-hashed chunk with the base path resolved by the bundler,
code-split so the campaign menu does not download twelve star systems.

A level is roughly 6 kB of JSON, so twelve levels bundled eagerly would also be
acceptable. Lazy is still preferable because it keeps the door open for the
scenario editor in the design's open questions.

**Custom levels, when that arrives**, take the other path: a file the player
drops in is parsed and validated at runtime. That is the only code path that
needs a validator in the shipped bundle, and it should be a dynamic import so
the 3.4 kB is paid only by players who use it. The built-in campaign then ships
with **zero** validation and **zero** parser bytes.

## A.9 Hot reload during authoring

A small first-party Vite plugin, roughly 80 lines, is worth more than
`@rollup/plugin-yaml` 5.0.0 (which works in Vite but only converts YAML to a
module and knows nothing about the schema).

```ts
// vite-plugin-graviton-levels
export function gravitonLevels(): Plugin {
  return {
    name: 'graviton-levels',
    async transform(src, id) {
      if (!id.endsWith('.level.yaml')) return
      const { json, issues } = compileLevel(src, id)   // shared with the CLI
      if (issues.length) this.error(formatWithLineCol(issues, src, id))
      return { code: `export default ${JSON.stringify(json)}`, map: null }
    },
    handleHotUpdate({ file, server }) {
      if (!file.endsWith('.level.yaml')) return
      server.ws.send({ type: 'custom', event: 'graviton:level-changed', data: { file } })
    },
  }
}
```

The value is that `compileLevel` is one function shared by the plugin, the CLI
that produces the shipped JSON, and the Vitest suite. An author editing a YAML
file sees a schema error as a Vite overlay with the right line, and the running
game reloads the level without losing the session. Reusing that same function in
tests is what stops the build and the tests from validating different things.

## A.10 The campaign file

Ordering lives in one file, separate from the levels, so a level can exist
without being in the campaign (useful for test fixtures and for the eventual
free-play mode).

```yaml
# campaign.yaml
schema: 1
id: clearance
name: Lane Clearance
levels:
  - { id: L01-intercept,  teaches: 'A fixed contact, one rail, gravity negligible.' }
  - { id: L02-gravity,    teaches: 'The path must bend around a body.' }
  - { id: L03-lead,       teaches: 'A contact riding a moving body.' }
  - { id: L04-rotation,   teaches: 'The launch window is a rotation phase.' }
  - { id: L05-budget,     teaches: 'A mid-course correction is required.' }
  - { id: L06-slingshot,  teaches: 'A flyby is mandatory.' }
  - { id: L07-staleness,  teaches: 'The uncertainty box appears.' }
  - { id: L08-authority,  teaches: 'The box exceeds the reachable set. Clauses.' }
  - { id: L09-exposure,   teaches: 'Terminal geometry starts costing.' }
  - { id: L10-occlusion,  teaches: 'The uplink is blocked. A relay is needed.' }
  - { id: L11-wave,       teaches: 'Several probes covering one box.' }
  - { id: L12-debris,     teaches: 'Crack a moonlet to sweep a cluster.' }
```

Unlock rule for v1: strictly sequential, cleared at bronze or better. Keeping
`teaches` in the campaign file rather than the level file makes the teaching
order reviewable in one screen, which is the thing that actually needs review.

## A.11 Editor support

`@valibot/to-json-schema` 1.7.1 converts the valibot schema to draft-07 JSON
Schema, verified working. Transform pipes (the unit-suffix quantities) cannot be
represented and throw by default; with `errorMode: 'ignore'` they degrade to
`anyOf: [number, string]`, which is exactly the right hint for a field that
accepts `71492000` or `"71492 km"`.

Generate it into `packages/sim/schema/level.schema.json` as a build step, and
reference it from the top of every level file with the
`# yaml-language-server: $schema=` comment shown in A.6. Authors and agents then
get completion and inline errors in the editor before the compiler ever runs.
One schema definition, two consumers, no drift.

---

# Part B — solvability evidence

## B.1 What the prototype established

A minimal but honest stand-in for the simulation core was built to answer
whether a solver is feasible: analytic Kepler tier one, fixed-step leapfrog tier
two with the design's own substep ladder, launching from a rail on a rotating
host. `../sizelab/sim2.mjs`, about 120 lines.

Against a Level-3-shaped problem, a derelict on a known orbit around a gas giant
reached from a rail on an inner world:

```
grid            5600 evals  best 41507 km
refine dt=1800  0.001 km
ladder dt= 600 L=2  seed 3303198.2 km -> 63642.5365 km
ladder dt= 150 L=4  seed  190609.8 km ->     0.0010 km
ladder dt=  30 L=8  seed    3314.6 km ->     0.0007 km

launch    t0 27117.1013519605 s | delta 0.5126104237101763 rad | speed 293855.6717952626 m/s
outcome   impacted true | miss 0.0007 km / capture 40 km | flight 10.8761 d | closing 301.69 km/s
budget    7745 evals, 19.4M steps, 41.2 s wall
```

**A solver finds a level's launch solution in 41 seconds on one core.** That
settles the "is it worth building in v1" question, and the rest of this section
is the detail that makes it work.

## B.2 A golden replay is nearly free

| Measurement | Value |
|---|---|
| Single replay, dt 30 s, maxLevel 8, 10.9-day flight | 76.8 ms |
| Integrator steps for that replay | 36 423 |
| Final-state hash across 5 runs | identical |

Twelve golden replays cost under a second. There is no argument for not running
them on every commit.

## B.3 Reference solutions must be stored at full precision

The same solution, rounded to fewer significant digits and replayed:

| Significant digits | Miss | Cleared? |
|---|---|---|
| 17 | 1 m | yes |
| 12 | under 1 m | yes |
| 9 | 1.0 km | yes |
| 6 | 116.6 km | **no** |
| 4 | 56 090 km | **no** |

Six significant digits turns a hit into a miss. The command log must therefore
store full-precision doubles. `JSON.stringify` emits the shortest representation
that reparses to the identical double, verified, so canonical JSON is a safe
container and no hex float encoding is needed.

The related sensitivity, measured directly by sweeping launch heading at the
solution:

| Heading change | Miss change |
|---|---|
| 1e-7 rad (0.0000057 deg) | 28.1 km |

Roughly **2.8e8 metres of miss per radian** of launch heading, over a 10.9-day
flight. This is why a human or an agent cannot hand-author a working launch
vector, and it is the core justification for the solver.

The objective is smooth and locally linear across that sweep, with no
discontinuity, which is good news: derivative-free optimisers work on it.

## B.4 Three findings that will otherwise look like solver bugs

**The timestep ladder is mandatory, and it is not monotone.** A solution found
at dt 1800 s carries about 3 300 km of error when replayed at dt 30 s, far larger
than any capture radius. Each rung must re-converge. One rung in the run above
*regressed*, from 0.001 km to 63 642 km, so the runner must keep the best result
across all rungs rather than trusting the last.

**Integration accuracy dominates everything else.** The same trajectory,
same launch parameters, varying only the substep ceiling:

| maxLevel | Miss |
|---|---|
| 0 | 30 508 km |
| 2 | 2 812 km |
| 4 | 563 km |
| 8 | 1 393 km |
| 12 | 1 422 km |

It converges to about 1 420 km above maxLevel 8; below that the answer is not
merely imprecise but wrong by a factor of twenty. This is a direct, numerical
answer to the design's first open question: **maxLevel 8 with a 10 Gm reference
radius is adequate at dt 30 s for a 300 km/s flyby, and maxLevel 6 is not.** The
convergence sweep above should itself become the per-level validation test the
design asks for.

**The substep ladder as specified does not refine on the target.** Rule 4 keys
the substep level on distance to the nearest *body*. A probe closing on a
contact at 300 km/s in open space is nowhere near a body, so it stays at
maxLevel and moves about 150 km per substep, which is coarser than a 40 km
capture radius. Sampling the range at substep boundaries misses the target
entirely.

Two fixes, and both are wanted. Compute closest approach on the swept segment
using relative velocity rather than sampling its endpoints, which is what the
prototype does and what made the coarse search stage work at all. And extend the
substep trigger to include range to the assigned contact, not only range to
bodies. The first is necessary; the second keeps terminal exposure accumulation
and impact energy honest.

**A contact on a body surface can be geometrically unreachable.** An earlier run
stalled at a hard floor of 419 km, which turned out to be the host moon
occluding its own surface point: closer approaches crashed into the moon, and
the optimiser was sitting exactly on that cliff. This is a real level-design
constraint, not a bug. A fixed contact sited on a body needs its approach
hemisphere open during the window, and the level validator should check it
rather than leaving an author to discover an unsolvable level through a failing
search.

## B.5 What to build, in order

**Unit 1 — the level compiler.** `compileLevel(src, path)` giving canonical JSON
plus issues with line and column. Shared by the Vite plugin, the CLI and the
tests. Ships with the JSON Schema generator. This is the prerequisite for
everything else.

**Unit 2 — the golden replay runner.** `pnpm levels:verify` loads a compiled
level and its `.solution.json`, replays the command log headless, and asserts
cleared contacts, score, rank, and final-state hash. At 77 ms per level this
runs on every commit. Failing here means either the level or the simulation
changed, and the diff says which.

**Unit 3 — the evidence report generator.** Writes the per-level artefact
described in B.7. Falls out of unit 2 almost for free.

**Unit 4 — the solver.** `pnpm levels:solve <id>` runs the three-stage search and
writes a `.solution.json`. Build this. An agent authoring twelve levels cannot
produce a nine-significant-digit launch vector any other way, and the prototype
shows the whole thing is about 200 lines and 41 seconds.

**Unit 5 — the screenshot.** A Playwright run that loads the level, replays the
solution at maximum warp, and captures the solved plot. Last, because it depends
on a renderer that does not exist yet, and because the first four units already
prove solvability. The screenshot is for human review, not for the proof.

The important ordering point: units 1 to 3 are the proof and are worth having
before any level is authored. Unit 4 is what makes authoring possible at all.
Unit 5 is presentation.

## B.6 One design number needs correcting

The first solver runs found no solution at all, and the reason is worth flagging
rather than burying. With muzzle speeds in the 6 to 22 km/s band, the transfer
from 0.92 au to 1.44 au needs about 252 days, so nothing is reachable inside a
20 or 40-day window and the search correctly reported a 1.1 au miss.

The design already states the right number in section 4.3, a cruise speed of 100
to 300 km/s, which gives a 10.9-day flight over the same transfer and matches
"intercepts measured in days rather than months". So this is not a design error,
but it is a constraint the level data has to respect: **rail muzzle speeds and
probe delta-v budgets belong in the 1e5 m/s band, not the chemical-rocket band.**
A level authored with plausible-looking chemical numbers will be unsolvable, and
the failure will look like a broken solver rather than a bad level. The validator
should warn when a level's muzzle band cannot cover its longest transfer inside
its window, using the same closed-form Kepler check.

## B.7 The evidence artefact

Three files per level, two of them generated.

**`levels/L09-exposure.solution.json`** — committed, authored by the solver.
The full command log at double precision plus the launch parameters. This is the
input, not the evidence.

**`levels/L09-exposure.evidence.json`** — generated, committed. Machine-readable,
diffable, and the thing CI asserts against:

```json
{
  "level": "L09-exposure",
  "levelHash": "sha256:9f2c...",
  "simVersion": "0.4.2",
  "solutionHash": "sha256:41ab...",
  "finalStateHash": "sha256:d8536cfed6159307...",
  "generated": "2026-09-03T11:42:08Z",
  "outcome": {
    "contactsCleared": 2, "contactsTotal": 2,
    "clearedWithinWindow": true,
    "probesExpended": 2, "probesGranted": 3,
    "deltaVRemaining": 412.7,
    "peakExposure": 0.61,
    "score": 2180, "rank": "gold"
  },
  "perProbe": [
    { "id": "sweeper-1", "missDistance": 0.689, "captureRadius": 40000,
      "timeOfFlight": 939693.4, "closingSpeed": 301690.2,
      "impactEnergy": 5.46e12, "exposureAccumulated": 0.61 }
  ],
  "validation": {
    "substepConvergence": [
      { "maxLevel": 4, "miss": 562733 }, { "maxLevel": 8, "miss": 1392910 },
      { "maxLevel": 12, "miss": 1421686 }
    ],
    "chosenMaxLevel": 8,
    "converged": true,
    "replayMs": 76.8
  }
}
```

The `validation` block is what makes this evidence rather than a scoreboard. It
records that the level's `dt` and `maxLevel` were checked against a finer
integration and agreed, which is the design's open question answered per level
and kept answered.

**`docs/evidence/L09-exposure.md`** — generated, committed. The same content as
a table a human can read in a pull request, plus the Playwright screenshot of
the solved plot, plus a trajectory plot. Committed because the point is that a
reviewer sees the evidence change when a level or the simulation changes.

The `docs/` layout does not currently declare an `evidence/` directory. Adding
it is a deliberate amendment to `docs/README.md` with a line in the ADR that
records why, per the working agreements.

## B.8 CI shape

| Job | Cost | When |
|---|---|---|
| Golden replay, 12 levels | under 1 s | every commit |
| Substep convergence check, 12 levels | about 30 s | every commit |
| Full re-solve from scratch, 12 levels | about 8 min single-threaded, under 1 min across 12 workers | nightly and on any simulation change |

The nightly re-solve is the one that catches the interesting failure: a change
to the integrator that leaves the recorded solution replaying identically while
making the level genuinely harder or unsolvable for a player. The fast replay
catches regressions; the slow re-solve catches design drift.

---

# Part C — the twelve levels against the schema

## C.1 What each level needs

| # | Level | Entities beyond the base | Knob that carries the lesson |
|---|---|---|---|
| 1 | Intercept | 2 bodies, 1 rail, 1 fixed contact | `agility: 0`, wide `captureRadius`, coarse `dt` |
| 2 | Gravity | 3 bodies, one massive and on the path | `muzzleSpeed.max` low enough that gravity bends the path measurably |
| 3 | Lead | Fixed contact anchored to an orbiting body | contact `host` plus that host's `orbit` |
| 4 | Rotation | Rail on a fast-spinning host | `headingCone` narrow, host `rotationPeriod` short, `axialPhaseAtEpoch` |
| 5 | Budget | none new | `nodeBudget: >= 1`, and a `muzzleSpeed` band that provably cannot close alone |
| 6 | Slingshot | A gas giant positioned on the transfer | `propellantMass` below the direct-transfer cost |
| 7 | Staleness | First mobile contact | `agility`, `state`, post position, observer `angularResolution` |
| 8 | Authority | none new | `clauseBudget: >= 1`, `allowedClauseConditions`, agility high enough that the box exceeds reach |
| 9 | Exposure | halo hazard | `radius`, `peakRate`, `falloffExponent`, probe `crossSection` |
| 10 | Occlusion | relay | relay `orbit` and `range`, body `atmosphereMargin`, post and contact geometry |
| 11 | Wave | 2+ rails | `probes[].count >= 3`, rail `reloadTime` |
| 12 | Debris | `debris` block, moonlet, cluster of contacts | `fragmentationEnergy`, `liveChunkCap`, `playVolume` |

## C.2 Levels that force something into the format

**Level 4 forces `headingCone` on the rail.** Without it, launch heading is
unconstrained and host rotation is decorative. This is the one entity field that
exists purely to make a teaching beat teachable, and it is why it appears in the
schema rather than being deferred.

**Level 5 forces a machine-checkable notion of "cannot close alone".** The
lesson only lands if a direct launch genuinely fails. Rather than a rule in the
data, the *evidence* artefact should carry a negative result: the solver runs a
zero-node search, records that its best miss exceeds the capture radius, and the
evidence file states it. A `requiresCorrection: true` assertion in the level file
that CI verifies against that negative result. The same pattern serves level 6
(`requiresFlyby: ilvaeth`) and level 8 (`requiresClauses: true`). This is a small
addition and it is the difference between a campaign that teaches and one that
merely can be completed.

**Level 10 forces relays to have an `orbit`, not just a `host`.** An occlusion
window has to open and close during the level, which means the relay moves
relative to the post and the contact. A relay pinned to a body inherits that
body's motion and cannot be placed where the geometry needs it.

**Level 12 forces the whole `debris` block plus `playVolume`.** It also forces
the `clearedBy` rule to accept clearance by a chunk rather than only by a probe,
since the lesson is sweeping a cluster with fragments. That is a resolver
behaviour, but it shows up in data as `clearedBy` needing to name what counts:
`{ minimumImpactEnergy: ..., by: [probe, chunk] }`.

**Level 9 forces `crossSection` onto the probe.** The design says exposure rate
is modulated by presented cross-section, so the number has to live somewhere,
and the probe is the only sensible owner.

## C.3 Minimal v1 entity set

Ship these. Every one is required by at least one campaign level.

- `body` with class, mass, radius, rotation period, axial phase, atmosphere
  margin, and an optional Keplerian `orbit` naming a parent
- `rail` with host, latitude, longitude, muzzle speed band, heading cone, reload
- `probe` with the full mass and propulsion set, sensor and transmitter range,
  impactor mass, cross-section, clause and node budgets, allowed clause
  conditions
- `contact`, discriminated `fixed` or `mobile`, with capture radius and a
  `clearedBy` rule; mobile carries state, agility, drive bearing and an optional
  avoidance reflex
- `hazard`, discriminated `halo`, `hulk` or `stream`
- `relay` with role, an orbit or a host, range and angular resolution
- `post`, `window`, `dt`, `substep`, `seed`, `streams`
- `debris` block
- `scoring` with rank thresholds
- `brief` and `debrief`

## C.4 Deferrable, but reserve the room

| Feature | Why deferred | What to reserve now |
|---|---|---|
| Rings and belts | Section 4.1 says "occasional"; no campaign level needs one | `ring: { inner, outer }` on `body`, ignored in v1 |
| Player-deployed relays | Level 10 works with a pre-placed relay | `deployable: false` on `relay`, validated as always false |
| Unsurveyed hazards | Section 4.9 wants them but no level in the twelve requires one | `surveyed` and `onsetTime` already in the schema, exercised by a test fixture |
| Multi-stage probes | Nothing in the campaign needs staging | nothing; adding a `stages` array later is additive |
| Scenario editor metadata | Open question in the design | nothing; the format being data is the whole preparation |
| Per-level palette override | Aesthetic polish | lives in the renderer package, invisible to the level schema |

Reserving `ring` and `deployable` as validated-but-inert fields costs two lines
each and means adding them later is not a schema version bump. Everything else on
that list is additive and needs no reservation, which is the right default:
YAGNI applies to the schema as much as to the code.

---

# Appendix — reproducing the measurements

```
cd ../sizelab
pnpm install
node gen-standalone.mjs   # generates src/validate-standalone.mjs for the ajv row
./measure.sh              # bundle sizes, table in A.1 and A.2
node units.test.mjs       # dimension-scoped unit parsing, A.5
node proto.mjs            # anchors, merge keys, error line mapping, A.4
node solve-final.mjs      # three-stage solver, B.1
node replay-cost.mjs      # replay cost, determinism, precision sensitivity, B.2 and B.3
node sweep.mjs            # substep and dt convergence, B.4
node probe-smooth.mjs     # objective smoothness and sensitivity, B.3
```

Verified package versions as of 2026-09-03, read from the npm registry:
`yaml` 2.9.0, `js-yaml` 5.4.1, `json5` 2.2.3, `smol-toml` 1.8.0,
`valibot` 1.4.2, `@valibot/to-json-schema` 1.7.1, `zod` 4.5.4,
`ajv` 8.20.0, `@sinclair/typebox` 0.34.52, `arktype` 2.2.3,
`@rollup/plugin-yaml` 5.0.0, `vite` 8.2.2, `vitest` 5.0.0.
