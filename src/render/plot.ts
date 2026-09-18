// The system plot (GAME-0002 §4-7, GRV-0022 acceptance): `renderPlot` is a pure function over a
// `Ctx2D` subset and a read-only `Frame` snapshot -- it never touches `document`, the clock or
// the simulation (ADR-0002 guard-rail 6), so the same function runs in the page
// (src/ui/plot.ts) and under `@napi-rs/canvas` in Node (src/headless/render.ts,
// tests/render/*.test.ts).
import { formatMetres, pickScaleBar, worldToScreen } from './camera.ts';
import type { View } from './camera.ts';
import { drawBody, drawMarker, drawOrbit } from './bodies.ts';
import {
  CONFIRMED_GOOD,
  GRID_MAJOR,
  GRID_MINOR,
  GROUND,
  KNOWN,
  KNOWN_DIM,
  LINE_STYLES,
  MARKER_SHAPES,
  MONO_FONT_FAMILY,
  TEXT_SECONDARY,
  UNVERIFIED_DIM,
} from './palette.ts';
import type { Frame, FrameContact, FrameObject, FrameRail } from './frame.ts';
import type { Ctx2D } from './ctx2d.ts';
import { createHash, digest, updateWord } from '../sim/state/hash.ts';

const RAIL_TICK_LENGTH_PX = 8;
const CONTACT_MARKER_RADIUS_PX = 4;
const PROBE_MARKER_RADIUS_PX = 5;
// Exported so tests/render/plot.test.ts can locate the scale bar's drawn pixels exactly, rather
// than re-deriving these layout constants.
export const SCALE_BAR_MARGIN_PX = 16;
export const SCALE_BAR_TICK_PX = 4;
const READOUT_FONT_SIZE_PX = 10;
const READOUT_LINE_GAP_PX = 14;
const READOUT_FONT = `${READOUT_FONT_SIZE_PX}px "${MONO_FONT_FAMILY}"`;

function clearGround(ctx: Ctx2D, canvasWidth: number, canvasHeight: number): void {
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
}

/** A 1 px stroke centred on an integer coordinate straddles two pixel rows/columns at 50%
 *  coverage each (a standard Canvas2D gotcha); centring it on a half-pixel instead makes it
 *  land fully inside one row/column -- crisp, the way GAME-0002's "hairline"/"1 px" language
 *  throughout means it. Only meaningful for axis-aligned strokes (grid lines, the scale bar);
 *  a diagonal or curved stroke (orbits, trails, ticks) is anti-aliased regardless. */
function crisp(value: number): number {
  return Math.floor(value) + 0.5;
}

/** Minor and major grid lines in world units, aligned to the scale bar's own decade (minor at a
 *  fifth of it, major at exactly its length) so the grid and the scale bar read as one system. */
function drawGrid(
  ctx: Ctx2D,
  {
    view,
    canvasWidth,
    canvasHeight,
    majorSpacing,
  }: { view: View; canvasWidth: number; canvasHeight: number; majorSpacing: number },
): void {
  if (!(majorSpacing > 0)) return;
  drawGridLines(ctx, {
    view,
    canvasWidth,
    canvasHeight,
    spacing: majorSpacing / 5,
    color: GRID_MINOR,
  });
  drawGridLines(ctx, { view, canvasWidth, canvasHeight, spacing: majorSpacing, color: GRID_MAJOR });
}

function drawGridLines(
  ctx: Ctx2D,
  {
    view,
    canvasWidth,
    canvasHeight,
    spacing,
    color,
  }: { view: View; canvasWidth: number; canvasHeight: number; spacing: number; color: string },
): void {
  const worldMinX = view.centreX - (canvasWidth / 2) * view.metresPerPixel;
  const worldMaxX = view.centreX + (canvasWidth / 2) * view.metresPerPixel;
  const worldMinY = view.centreY - (canvasHeight / 2) * view.metresPerPixel;
  const worldMaxY = view.centreY + (canvasHeight / 2) * view.metresPerPixel;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  for (let x = Math.floor(worldMinX / spacing) * spacing; x <= worldMaxX; x += spacing) {
    const a = worldToScreen({ view, canvasWidth, canvasHeight, x, y: worldMinY });
    const b = worldToScreen({ view, canvasWidth, canvasHeight, x, y: worldMaxY });
    const screenX = crisp(a.x);
    ctx.beginPath();
    ctx.moveTo(screenX, a.y);
    ctx.lineTo(screenX, b.y);
    ctx.stroke();
  }
  for (let y = Math.floor(worldMinY / spacing) * spacing; y <= worldMaxY; y += spacing) {
    const a = worldToScreen({ view, canvasWidth, canvasHeight, x: worldMinX, y });
    const b = worldToScreen({ view, canvasWidth, canvasHeight, x: worldMaxX, y });
    const screenY = crisp(a.y);
    ctx.beginPath();
    ctx.moveTo(a.x, screenY);
    ctx.lineTo(b.x, screenY);
    ctx.stroke();
  }
}

/** A rail's launch window read as geometry (GAME-0001 §4.2): a short tick outward from the
 *  host's limb at the rail's current surface angle. */
function drawRail(
  ctx: Ctx2D,
  {
    rail,
    view,
    canvasWidth,
    canvasHeight,
  }: { rail: FrameRail; view: View; canvasWidth: number; canvasHeight: number },
): void {
  const p = worldToScreen({ view, canvasWidth, canvasHeight, x: rail.x, y: rail.y });
  const dx = rail.ux;
  const dy = -rail.uy; // world outward direction -> screen direction (bodies.ts's y-flip rule)
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + dx * RAIL_TICK_LENGTH_PX, p.y + dy * RAIL_TICK_LENGTH_PX);
  ctx.strokeStyle = KNOWN;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
}

/** Amber-dim until cleared, then confirmed-good (GAME-0002 §2, §11: marker shape -- a square --
 *  carries the meaning "contact", colour carries cleared/not). */
function drawContact(
  ctx: Ctx2D,
  {
    contact,
    view,
    canvasWidth,
    canvasHeight,
  }: { contact: FrameContact; view: View; canvasWidth: number; canvasHeight: number },
): void {
  const p = worldToScreen({ view, canvasWidth, canvasHeight, x: contact.x, y: contact.y });
  drawMarker(ctx, {
    x: p.x,
    y: p.y,
    shape: MARKER_SHAPES.contact,
    radius: CONTACT_MARKER_RADIUS_PX,
    color: contact.cleared ? CONFIRMED_GOOD : UNVERIFIED_DIM,
  });
}

/** The probe's flown trail: solid, one pixel, sampled positions only (GAME-0002 §4 "Solid, one
 *  pixel | Observed"; GRV-0022 design: the app's ring buffer, never derived here). Dims to
 *  `KNOWN_DIM` once its probe is expended -- GAME-0002 §4's "Dimmed solid" row, same dash
 *  pattern as an active trail (palette.ts). */
function drawTrail(
  ctx: Ctx2D,
  { points, color }: { points: readonly { x: number; y: number }[]; color: string },
): void {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([...LINE_STYLES.trail.dash]);
  ctx.stroke();
}

/** A small triangle pointing along the probe's current velocity (GRV-0022 acceptance); expended
 *  probes dim to `KNOWN_DIM`. */
function drawProbe(
  ctx: Ctx2D,
  {
    object,
    view,
    canvasWidth,
    canvasHeight,
  }: { object: FrameObject; view: View; canvasWidth: number; canvasHeight: number },
): void {
  const p = worldToScreen({ view, canvasWidth, canvasHeight, x: object.x, y: object.y });
  const velocityScreen = { x: object.vx, y: -object.vy };
  const speed = Math.hypot(velocityScreen.x, velocityScreen.y);
  const rotation = speed > 0 ? Math.atan2(velocityScreen.x, -velocityScreen.y) : 0;
  drawMarker(ctx, {
    x: p.x,
    y: p.y,
    shape: MARKER_SHAPES.probe,
    radius: PROBE_MARKER_RADIUS_PX,
    color: object.expended ? KNOWN_DIM : KNOWN,
    rotation,
  });
}

/** Bottom-right ruler graphic and its label (GAME-0002 §6 "a persistent scale bar... sit on the
 *  plot at all times", §3's 10 px mono readout text) -- bottom-left is the level brief's corner
 *  (src/ui/plot.ts). The same label is also DOM text, `data-readout="plot.scale"`
 *  (src/ui/plot.ts, ADR-0004 §2): a canvas has no text a verifier can read back as a string. */
function drawScaleBar(
  ctx: Ctx2D,
  {
    pixels,
    label,
    canvasWidth,
    canvasHeight,
  }: { pixels: number; label: string; canvasWidth: number; canvasHeight: number },
): void {
  if (!(pixels > 0)) return;
  const y = canvasHeight - SCALE_BAR_MARGIN_PX;
  const x1 = canvasWidth - SCALE_BAR_MARGIN_PX;
  const x0 = x1 - pixels;
  const crispY = crisp(y);
  const crispX0 = crisp(x0);
  const crispX1 = crisp(x1);
  ctx.strokeStyle = KNOWN_DIM;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(crispX0, crispY);
  ctx.lineTo(crispX1, crispY);
  ctx.moveTo(crispX0, y - SCALE_BAR_TICK_PX);
  ctx.lineTo(crispX0, y + SCALE_BAR_TICK_PX);
  ctx.moveTo(crispX1, y - SCALE_BAR_TICK_PX);
  ctx.lineTo(crispX1, y + SCALE_BAR_TICK_PX);
  ctx.stroke();

  ctx.font = READOUT_FONT;
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x1, y - SCALE_BAR_TICK_PX - 4);
}

/** The zoom readout (GAME-0002 §6), stacked above the scale bar's own label -- the DOM twin is
 *  `data-readout="plot.zoom"`. */
function drawZoomReadout(
  ctx: Ctx2D,
  {
    label,
    canvasWidth,
    canvasHeight,
  }: { label: string; canvasWidth: number; canvasHeight: number },
): void {
  ctx.font = READOUT_FONT;
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  const y = canvasHeight - SCALE_BAR_MARGIN_PX - SCALE_BAR_TICK_PX - 4 - READOUT_LINE_GAP_PX;
  ctx.fillText(label, canvasWidth - SCALE_BAR_MARGIN_PX, y);
}

export interface RenderPlotArgs {
  ctx: Ctx2D;
  view: View;
  frame: Frame;
  /** One flown-trail point list per `frame.objects` index (src/app/trails.ts's `TrailSet`, read
   *  via `trailPoints`) -- already sampled positions, in world coordinates; `renderPlot` only
   *  projects them to screen space. */
  trails: ReadonlyMap<number, readonly { x: number; y: number }[]>;
  canvasWidth: number;
  canvasHeight: number;
}

/** Draws one complete frame of the plot: ground, grid, orbits, bodies, rails, contacts, flown
 *  trails, probes, then the scale bar graphic -- pure over its arguments, called identically by
 *  the page and by `pnpm render` (src/headless/render.ts). */
export function renderPlot({
  ctx,
  view,
  frame,
  trails,
  canvasWidth,
  canvasHeight,
}: RenderPlotArgs): void {
  clearGround(ctx, canvasWidth, canvasHeight);

  const scaleBar = pickScaleBar({ metresPerPixel: view.metresPerPixel, canvasWidth });
  drawGrid(ctx, { view, canvasWidth, canvasHeight, majorSpacing: scaleBar.metres });

  for (const body of frame.bodies) {
    drawOrbit(ctx, {
      body,
      view,
      canvasWidth,
      canvasHeight,
      dash: LINE_STYLES.orbit.dash,
      color: LINE_STYLES.orbit.color,
    });
  }
  for (const body of frame.bodies) drawBody(ctx, { body, view, canvasWidth, canvasHeight });
  for (const rail of frame.rails) drawRail(ctx, { rail, view, canvasWidth, canvasHeight });
  for (const contact of frame.contacts)
    drawContact(ctx, { contact, view, canvasWidth, canvasHeight });

  frame.objects.forEach((object, index) => {
    const points = (trails.get(index) ?? []).map((point) =>
      worldToScreen({ view, canvasWidth, canvasHeight, ...point }),
    );
    drawTrail(ctx, { points, color: object.expended ? KNOWN_DIM : KNOWN });
  });
  for (const object of frame.objects) drawProbe(ctx, { object, view, canvasWidth, canvasHeight });

  drawScaleBar(ctx, { pixels: scaleBar.pixels, label: scaleBar.label, canvasWidth, canvasHeight });
  drawZoomReadout(ctx, {
    label: `${formatMetres(view.metresPerPixel)}/px`,
    canvasWidth,
    canvasHeight,
  });
}

/** Reads a canvas's raw RGBA bytes -- the one thing both `CanvasRenderingContext2D` (browser) and
 *  `@napi-rs/canvas`'s context support that `Ctx2D` deliberately leaves out (renderPlot itself
 *  never reads pixels back, only src/ui/plot.ts's `frameHash()` and src/headless/render.ts do). */
export interface PixelSource {
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
}

/** FNV-1a-style word hash (src/sim/state/hash.ts, the same one golden replay uses) over a
 *  canvas's RGBA bytes, four at a time -- comparable only within one renderer key (research §3:
 *  Playwright's Chromium and `@napi-rs/canvas` anti-alias text and strokes 7% differently, so
 *  this is never compared across the two). */
export function hashCanvasPixels(source: PixelSource, width: number, height: number): string {
  const { data } = source.getImageData(0, 0, width, height);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const state = createHash();
  const words = data.byteLength >>> 2;
  for (let i = 0; i < words; i++) updateWord(state, view.getUint32(i * 4, true));
  return digest(state);
}
