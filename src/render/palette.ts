// GAME-0002 §2 palette as named constants -- the one source of truth shared with
// `src/app/styles.css`'s custom properties (palette.test.ts parses the CSS file and asserts the
// two never drift) -- plus the per-body-class band palette and glyph registry GAME-0002 §5 and
// research §A.7 call for ("a separate table, in the renderer package, never the level file").

export const GROUND = '#05070a';
export const PANEL = '#0b0f14';
export const PANEL_RAISED = '#111820';
export const HAIRLINE = '#1a2530';
export const GRID_MINOR = '#111a22';
export const GRID_MAJOR = '#1c2a36';
export const TEXT_PRIMARY = '#e8f0f4';
export const TEXT_SECONDARY = '#6c818e';
export const TEXT_DISABLED = '#3a4954';
export const KNOWN = '#7fd4e8';
export const KNOWN_DIM = '#3e7a8a';
export const UNVERIFIED = '#e8a33d';
export const UNVERIFIED_DIM = '#8a6224';
export const ALARM = '#e85d4d';
export const CONFIRMED_GOOD = '#7fe8a8';

/** name -> CSS custom property, so a test can compare this module's values against
 *  `src/app/styles.css` without hand-maintaining two lists in parallel. */
export const CSS_CUSTOM_PROPERTIES: Record<string, string> = {
  '--ground': GROUND,
  '--panel': PANEL,
  '--panel-raised': PANEL_RAISED,
  '--hairline': HAIRLINE,
  '--grid-minor': GRID_MINOR,
  '--grid-major': GRID_MAJOR,
  '--text-primary': TEXT_PRIMARY,
  '--text-secondary': TEXT_SECONDARY,
  '--text-disabled': TEXT_DISABLED,
  '--known': KNOWN,
  '--known-dim': KNOWN_DIM,
  '--unverified': UNVERIFIED,
  '--unverified-dim': UNVERIFIED_DIM,
  '--alarm': ALARM,
  '--confirmed-good': CONFIRMED_GOOD,
};

/** Matches `src/app/styles.css`'s `--font-mono` family name exactly, so the scale bar and zoom
 *  text drawn on the canvas (src/render/plot.ts) use the same face as the rest of the instrument
 *  (GAME-0002 §3). The headless CLI (src/headless/render.ts) registers this family with
 *  `@napi-rs/canvas`'s `GlobalFonts` from the same font file the web build ships. */
export const MONO_FONT_FAMILY = 'JetBrains Mono';

export type BodyClass = 'rock' | 'ice' | 'gas' | 'molten' | 'metal' | 'star';

export type GlyphShape = 'circle' | 'diamond' | 'hexagon' | 'triangle' | 'square' | 'star';

export interface BodyClassStyle {
  /** Four to six flat colours, outer band first, centre band last (GAME-0002 §5: "banded
   *  shading... four to six steps, no smooth gradients"). */
  bands: readonly string[];
  /** The glyph a body of this class draws below the minimum screen size (GAME-0002 §6). */
  glyph: GlyphShape;
  /** 'hard' darkens the hemisphere facing away from the system primary one band step
   *  (GAME-0002 §5); 'none' is for the star itself, which has no external primary to be lit
   *  by -- it draws the same bands as a plain radial disc instead. */
  terminator: 'hard' | 'none';
}

/** Keyed on the six classes the level schema already declares (research §A.7). Bands are muted,
 *  desaturated material colours by design: GAME-0002 §1 reserves the two bright, saturated
 *  accents (`KNOWN`/`UNVERIFIED`) for information the player must act on, so a body's own surface
 *  never competes with them for attention. */
export const BODY_CLASS_STYLES: Record<BodyClass, BodyClassStyle> = {
  rock: {
    bands: ['#4a4038', '#5c5045', '#6e6055', '#877668', '#a08d7c'],
    glyph: 'circle',
    terminator: 'hard',
  },
  ice: {
    bands: ['#33434c', '#42545f', '#526674', '#65808f', '#7c9ba9'],
    glyph: 'diamond',
    terminator: 'hard',
  },
  gas: {
    bands: ['#3a4a5c', '#4a5e73', '#5e7389', '#7389a0', '#8ca0b5', '#a6b8c9'],
    glyph: 'hexagon',
    terminator: 'hard',
  },
  molten: {
    bands: ['#3c211b', '#5c3426', '#7a4630', '#9c5c3b', '#c07845'],
    glyph: 'triangle',
    terminator: 'hard',
  },
  metal: {
    bands: ['#33383c', '#42484e', '#535a61', '#666e75', '#7c848c'],
    glyph: 'square',
    terminator: 'hard',
  },
  star: {
    bands: ['#5c4118', '#7c5920', '#a3782c', '#cc9b3c', '#f0c05a'],
    glyph: 'star',
    terminator: 'none',
  },
};

/** Overlay markers -- rails, contacts and probes -- drawn on top of the plot rather than as a
 *  body's own material. A separate registry from `BODY_CLASS_STYLES` (GAME-0002 §11: "every
 *  marker its shape"; palette.test.ts checks uniqueness within each registry, not across both --
 *  a rail tick and a probe marker are never near a body glyph of the same shape in a way that
 *  could be misread, and the brief specifies these shapes literally). */
export const MARKER_SHAPES = {
  rail: 'tick',
  contact: 'square',
  probe: 'triangle',
} as const;

/** Line classes this unit draws (GAME-0002 §4): "Predicted" (dashed) and "Observed" (solid),
 *  each with its own dash pattern -- the thing palette.test.ts checks for uniqueness. A flown
 *  trail's colour still switches to `KNOWN_DIM` once its probe is expended (plot.ts), which is
 *  GAME-0002 §4's separate "Dimmed solid" row: still the *solid* (observed) dash pattern, dimmed
 *  by colour alone, not a new dash to register. `ghost` is the planner's own dashed path
 *  (GRV-0026, src/render/ghost.ts) -- "Dashed | Predicted from... a loaded plan", distinct from
 *  a body's own orbit dash so the two never read as the same kind of prediction at a glance.
 *  Extrapolation and locked-plan segments are later epics and are not registered here. */
export const LINE_STYLES = {
  orbit: { dash: [6, 4], color: KNOWN_DIM },
  trail: { dash: [], color: KNOWN },
  ghost: { dash: [3, 3], color: KNOWN },
} as const;
