---
status: accepted
date: 2026-09-03
id: GAME-0002
supersedes: none
---

# Graviton — visual and audio language

The look is a deep-space traffic-control console. Not a retro scope, not a
diorama, not a chart. A working instrument in a darkened room.

Game design: `2026-09-03-GAME-0001-graviton-design.md`.

## 1. Principles

**The interface is the voice.** There are no characters and no dialogue. Tone
is carried entirely by typography, terseness and restraint.

**The plot is a plot, not a scene.** It shows where things are and where they
will be. It is not a window onto space.

**Nothing animates that is not moving in the simulation.** Panels snap. Values
change instantly. The only motion is the passage of simulated time. Warp
transitions are the sole exception.

**Two accents, held with discipline.** Ice blue is yours and known. Amber is
unverified and extrapolated. Red is alarm and nothing else. A third accent
would break the readability the whole design depends on.

**Data over decoration.** Every glowing thing on screen is a number the player
needs.

## 2. Palette

| Role | Hex |
|---|---|
| Ground | `#05070A` |
| Panel | `#0B0F14` |
| Panel raised | `#111820` |
| Hairline | `#1A2530` |
| Grid minor | `#111A22` |
| Grid major | `#1C2A36` |
| Text primary | `#E8F0F4` |
| Text secondary | `#6C818E` |
| Text disabled | `#3A4954` |
| Known, yours | `#7FD4E8` |
| Known, dim | `#3E7A8A` |
| Unverified, extrapolated | `#E8A33D` |
| Unverified, dim | `#8A6224` |
| Alarm | `#E85D4D` |
| Confirmed good | `#7FE8A8` |

Confirmed good is used sparingly, for a solved intercept and a cleared contact.
Nothing else is green.

## 3. Typography

One monospace for all data, one condensed grotesque for headers and labels.
Tabular numerals are mandatory everywhere a number can change, so digits never
jitter.

| Use | Size | Tracking |
|---|---|---|
| Panel header | 10 px condensed, uppercase | +0.12 em |
| Field label | 10 px mono, uppercase | +0.08 em |
| Value | 13 px mono | 0 |
| Value, emphasis | 16 px mono | 0 |
| Body text, briefs | 12 px mono | 0 |

Small and dense. The player is reading an instrument, not a website.

## 4. Line language

Meaning is carried by dash pattern as well as by hue, so the display stays
readable without colour. This is an accessibility requirement, not a stylistic
preference.

| Line | Meaning |
|---|---|
| Solid, one pixel | Observed. This happened. |
| Dashed | Predicted from a known ephemeris or a loaded plan. |
| Dotted, fading tail | Extrapolated from a stale observation. |
| Dimmed solid | Plan segment past the lock point. Cannot be amended. |
| Hairline ring | True physical size of a body drawn as a glyph. |

## 5. Celestial bodies

Three-dimensional spheres rendered into the two-dimensional orbital plane.

- Banded shading from a limited per-body palette, four to six steps, no smooth
  gradients. They read as rendered objects, not sprites, and they stay legible
  at small size.
- A hard terminator line, lit from the system primary.
- Visible rotation at the body's real period, carried by surface features plus a
  small phase tick on the limb so the player can read rotation phase exactly.
  This matters because rail launch windows are rotation phases.
- Body class drives the palette: rock, ice, gas, molten, metal.

## 6. Scale handling

The problem is real: at true scale a solar system is almost entirely vacuum, and
at false scale it looks like a toy. The answer is to keep the simulation honest
and make the rendering concession explicit.

- The simulation is always true scale.
- Every object has a minimum screen size and is drawn as a glyph below that
  threshold.
- A glyph is wrapped in a hairline ring showing the body's true size at the
  current zoom, so the player can always see how much larger the glyph is than
  reality.
- Past a zoom threshold the glyph resolves into the actual sphere.
- A persistent scale bar and a numeric zoom readout sit on the plot at all
  times.
- Zoom is logarithmic and spans roughly nine orders of magnitude, from whole
  system to probe against contact.

Nothing is faked. The concession is signposted by the ring and the scale bar.

## 7. The three core overlays

**Trajectories.** Solid where flown, dashed where planned, dotted where merely
extrapolated. Burn nodes are small squares on the line, filled when amendable
and hollow when locked.

**The two ellipses.** Amber uncertainty box around a contact's extrapolated
position, ice-blue reachable set around the probe's projected impact point.
Their overlap is filled at low opacity. Watching the blue swallow the amber is
the game's central visual moment, and the fill is what makes it readable at a
glance.

**The exposure strip.** A horizontal strip beneath the timeline showing
cumulative exposure along the plotted path, with the loss point marked when it
reaches one. The player reads survivability off this before committing.

## 8. Screen layout

```
┌ STATUS ─────────────────────────────────────────────────────────┐
│ T+04:12:33:08   WARP 10000x   POST: KERWEN STN   DELAY 8m14s    │
├──────────────────────────────────────────┬──────────────────────┤
│                                          │ SELECTION            │
│                                          │  PRB-01              │
│               SYSTEM PLOT                │  dv      412 m/s     │
│                                          │  a_max   18.0 m/s2   │
│         pan, zoom, inspect               │  t_go    02:41:10    │
│                                          │  sig     8m14s       │
│                                          │ ─────────────────────│
│                                          │ SOLUTION             │
│                                          │  PCA     1 204 km    │
│                                          │  box r  28 800 km    │
│                                          │  reach r 31 200 km   │
│                                          │  conf    0.98        │
├──────────────────────────────────────────┴──────────────────────┤
│ TIMELINE   nodes · uplink windows · telemetry arrivals          │
│ EXPOSURE   cumulative exposure along path                       │
└─────────────────────────────────────────────────────────────────┘
```

The status bar always shows simulated time, warp factor, clearance post and
current one-way delay to the selection. Those four never move.

## 9. Motion

Panels do not animate. Values do not tween. Selection is instant.

The plot moves only because simulated time is moving, at whatever rate the warp
factor dictates.

Warp changes are the one permitted transition, and they are eased over about
150 milliseconds so the player's eye can keep track of what is moving.

Automatic drop to one times is announced by a single frame of the status bar
inverting, not by a modal.

## 10. Sound

Sparse and functional. Every sound is information.

- A soft tick per simulated hour at low warp, which fades out as warp rises.
- A short chirp when an order is transmitted, and a different one when it is
  received by the probe.
- A two-tone arrival marker when telemetry lands, pitched by whether it changed
  the solution.
- A low sustained tone while exposure is accumulating, rising in pitch toward
  one.
- Impact is silence. The readouts go still and the plot stops updating for a
  beat. Nothing bursts.

Music is ambient, tonal and very quiet, present mainly during planning and
absent during the terminal phase.

## 11. Accessibility

- Never rely on hue alone. Dash pattern and glyph shape carry the same meaning.
- The blue and amber pair is distinguishable under the common forms of colour
  vision deficiency by luminance as well as by hue, and a high-contrast mode
  raises the separation further.
- All type meets contrast requirements against its own panel colour, not
  against the ground.
- Every reading available on the plot is also available as text in the
  selection panel, so nothing is spatial-only.
