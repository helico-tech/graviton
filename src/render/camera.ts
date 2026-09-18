// The plot's camera (GAME-0002 §6, GRV-0022 acceptance "logarithmic zoom over nine orders of
// magnitude, pan"): pure world<->screen mapping and view maths, no Canvas2D, no sim types --
// callers hand it plain numbers (canvas size, a system extent in metres) so it stays testable
// with nothing but arithmetic. `View` is explicit state, never derived or animated (GAME-0002 §9:
// only simulated time moves anything).

export interface View {
  readonly centreX: number;
  readonly centreY: number;
  /** World metres one screen pixel covers -- the zoom, expressed linearly; callers zoom by
   *  multiplying it, which is what makes the zoom logarithmic in the player's felt sense. */
  readonly metresPerPixel: number;
}

export interface ZoomBounds {
  readonly min: number;
  readonly max: number;
}

/** Finest zoom: a pixel is 100 m across, on the order of a probe against a contact's capture
 *  radius (GAME-0002 §6 "whole system to probe against contact"). */
export const ZOOM_FLOOR_METRES_PER_PIXEL = 100;
/** The zoom spans this many decades above the floor by default (GAME-0002 §6 "roughly nine
 *  orders of magnitude"). */
export const ZOOM_DECADES = 9;

/** Nine decades above the 100 m floor, widened only if the level's own largest orbit would not
 *  otherwise fit inside it -- a level with an unusually large system must still be zoomable out
 *  to see all of it. */
export function zoomBounds({ largestOrbitRadius }: { largestOrbitRadius: number }): ZoomBounds {
  const min = ZOOM_FLOOR_METRES_PER_PIXEL;
  const decadeCeiling = min * 10 ** ZOOM_DECADES;
  // The orbit's diameter, with margin, visible across a generously small 40 px span.
  const neededToSeeTheSystem = (largestOrbitRadius * 2.4) / 40;
  return { min, max: Math.max(decadeCeiling, neededToSeeTheSystem) };
}

export function clampMetresPerPixel(metresPerPixel: number, bounds: ZoomBounds): number {
  return Math.min(Math.max(metresPerPixel, bounds.min), bounds.max);
}

export function worldToScreen({
  view,
  canvasWidth,
  canvasHeight,
  x,
  y,
}: {
  view: View;
  canvasWidth: number;
  canvasHeight: number;
  x: number;
  y: number;
}): { x: number; y: number } {
  return {
    x: canvasWidth / 2 + (x - view.centreX) / view.metresPerPixel,
    // Screen y grows downward, world y grows "up" (the orbital-plane convention every other
    // number in this module and its callers uses), hence the flip.
    y: canvasHeight / 2 - (y - view.centreY) / view.metresPerPixel,
  };
}

export function screenToWorld({
  view,
  canvasWidth,
  canvasHeight,
  x,
  y,
}: {
  view: View;
  canvasWidth: number;
  canvasHeight: number;
  x: number;
  y: number;
}): { x: number; y: number } {
  return {
    x: view.centreX + (x - canvasWidth / 2) * view.metresPerPixel,
    y: view.centreY - (y - canvasHeight / 2) * view.metresPerPixel,
  };
}

/** Zooms by `factor` (>1 zooms out, <1 zooms in) about a screen point, keeping the world point
 *  under it fixed -- the wheel's contract (GRV-0022 acceptance "wheel zooms about the cursor"). */
export function zoomAt({
  view,
  canvasWidth,
  canvasHeight,
  screenX,
  screenY,
  factor,
  bounds,
}: {
  view: View;
  canvasWidth: number;
  canvasHeight: number;
  screenX: number;
  screenY: number;
  factor: number;
  bounds: ZoomBounds;
}): View {
  const before = screenToWorld({ view, canvasWidth, canvasHeight, x: screenX, y: screenY });
  const metresPerPixel = clampMetresPerPixel(view.metresPerPixel * factor, bounds);
  const zoomed = { ...view, metresPerPixel };
  const after = screenToWorld({ view: zoomed, canvasWidth, canvasHeight, x: screenX, y: screenY });
  return {
    centreX: zoomed.centreX + (before.x - after.x),
    centreY: zoomed.centreY + (before.y - after.y),
    metresPerPixel,
  };
}

/** Pans by a screen-pixel delta -- the drag's contract. */
export function pan({
  view,
  dxPixels,
  dyPixels,
}: {
  view: View;
  dxPixels: number;
  dyPixels: number;
}): View {
  return {
    centreX: view.centreX - dxPixels * view.metresPerPixel,
    centreY: view.centreY + dyPixels * view.metresPerPixel,
    metresPerPixel: view.metresPerPixel,
  };
}

/** Frames the system primary (always at the world origin, ephemeris.ts) with every orbit visible
 *  and a margin, filling the shorter canvas dimension. */
export function defaultView({
  largestOrbitRadius,
  canvasWidth,
  canvasHeight,
}: {
  largestOrbitRadius: number;
  canvasWidth: number;
  canvasHeight: number;
}): View {
  const margin = 1.2;
  const span = Math.max(largestOrbitRadius * 2 * margin, ZOOM_FLOOR_METRES_PER_PIXEL);
  const minDimension = Math.max(Math.min(canvasWidth, canvasHeight), 1);
  const bounds = zoomBounds({ largestOrbitRadius });
  return {
    centreX: 0,
    centreY: 0,
    metresPerPixel: clampMetresPerPixel(span / minDimension, bounds),
  };
}

export interface ScaleBar {
  readonly metres: number;
  readonly label: string;
  readonly pixels: number;
}

const AU_METRES = 1.495978707e11;
/** 1/2/5 x 10^n -- the "round metric length" the acceptance list asks for. */
const NICE_MULTIPLIERS = [1, 2, 5] as const;

function trimNumber(value: number): string {
  return String(Number(value.toPrecision(3)));
}

/** Labels a metre length in m/km/Mm/Gm/au, whichever reads as the fewest digits (GRV-0022
 *  acceptance, GAME-0002 §6). */
export function formatMetres(metres: number): string {
  if (metres >= AU_METRES) return `${trimNumber(metres / AU_METRES)} au`;
  if (metres >= 1e9) return `${trimNumber(metres / 1e9)} Gm`;
  if (metres >= 1e6) return `${trimNumber(metres / 1e6)} Mm`;
  if (metres >= 1e3) return `${trimNumber(metres / 1e3)} km`;
  return `${trimNumber(metres)} m`;
}

/** Picks the 1/2/5 x 10^n metre length closest to `targetFraction` of the canvas width at the
 *  given zoom (default a fifth, GRV-0022 acceptance "fits ~1/5 of the width"). */
export function pickScaleBar({
  metresPerPixel,
  canvasWidth,
  targetFraction = 0.2,
}: {
  metresPerPixel: number;
  canvasWidth: number;
  targetFraction?: number;
}): ScaleBar {
  const targetMetres = canvasWidth * metresPerPixel * targetFraction;
  if (!(targetMetres > 0)) return { metres: 0, label: formatMetres(0), pixels: 0 };

  const exponent = Math.floor(Math.log10(targetMetres));
  let best = NICE_MULTIPLIERS[0] * 10 ** exponent;
  let bestDiff = Infinity;
  for (const e of [exponent - 1, exponent, exponent + 1]) {
    for (const m of NICE_MULTIPLIERS) {
      const candidate = m * 10 ** e;
      const diff = Math.abs(candidate - targetMetres);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = candidate;
      }
    }
  }
  return { metres: best, label: formatMetres(best), pixels: best / metresPerPixel };
}
