// Celestial bodies: the glyph-vs-banded-sphere threshold, the banded sphere itself (GAME-0002 §5)
// and a body's orbit curve. Pure over `Ctx2D` and plain numbers -- no sim types past what
// `Frame`/`View` already carry (ctx2d.ts, camera.ts, frame.ts).
import { worldToScreen } from './camera.ts';
import type { View } from './camera.ts';
import { BODY_CLASS_STYLES, HAIRLINE, KNOWN } from './palette.ts';
import type { GlyphShape } from './palette.ts';
import type { FrameBody } from './frame.ts';
import type { Ctx2D } from './ctx2d.ts';

const TWO_PI = Math.PI * 2;

/** A world-space angle (standard convention, y "up") as a canvas rotation/drawing angle (y grows
 *  downward): negating is the whole conversion, since canvas angles already mean "clockwise from
 *  +x" -- the same visual sense as a y-up counterclockwise angle once y is flipped. Every angle
 *  this module draws (terminator direction, surface phase) is a world angle and passes through
 *  this once. */
function toScreenAngle(worldAngle: number): number {
  return -worldAngle;
}

/** Below this screen radius a body draws as its class glyph rather than a resolved sphere
 *  (GAME-0002 §6, GRV-0022 acceptance) -- and the glyph itself is drawn at exactly this size. */
export const GLYPH_SCREEN_RADIUS = 6;

export function bodyScreenRadius(body: FrameBody, view: View): number {
  return body.radius / view.metresPerPixel;
}

function pathGlyph(ctx: Ctx2D, shape: GlyphShape, radius: number): void {
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(0, 0, radius, 0, TWO_PI);
      return;
    case 'diamond':
      ctx.moveTo(0, -radius);
      ctx.lineTo(radius, 0);
      ctx.lineTo(0, radius);
      ctx.lineTo(-radius, 0);
      ctx.closePath();
      return;
    case 'square':
      ctx.moveTo(-radius, -radius);
      ctx.lineTo(radius, -radius);
      ctx.lineTo(radius, radius);
      ctx.lineTo(-radius, radius);
      ctx.closePath();
      return;
    case 'triangle':
      for (let k = 0; k < 3; k++) {
        const angle = -Math.PI / 2 + (k * TWO_PI) / 3;
        const point = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
        if (k === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
      return;
    case 'hexagon':
      for (let k = 0; k < 6; k++) {
        const angle = (k * TWO_PI) / 6;
        const point = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
        if (k === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
      return;
    case 'star':
      for (let k = 0; k < 10; k++) {
        const r = k % 2 === 0 ? radius : radius * 0.45;
        const angle = -Math.PI / 2 + (k * Math.PI) / 5;
        const point = { x: r * Math.cos(angle), y: r * Math.sin(angle) };
        if (k === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
      return;
  }
}

/** Fills one shape marker at `(x, y)`, optionally rotated (rails, probes point along a
 *  direction). Shared by body glyphs (this module) and the rail/contact/probe markers
 *  (plot.ts) -- one drawing primitive, one place a marker's shape is drawn. */
export function drawMarker(
  ctx: Ctx2D,
  {
    x,
    y,
    shape,
    radius,
    color,
    rotation = 0,
  }: { x: number; y: number; shape: GlyphShape; radius: number; color: string; rotation?: number },
): void {
  ctx.save();
  ctx.translate(x, y);
  if (rotation) ctx.rotate(rotation);
  pathGlyph(ctx, shape, radius);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** The glyph-mode body: its class glyph at a fixed screen size, plus a hairline ring at the
 *  body's true screen radius when that ring would be visible (GAME-0002 §6: "signposted" scale
 *  concession) -- both centred on the body's screen position. */
function drawBodyGlyph(
  ctx: Ctx2D,
  {
    body,
    screenX,
    screenY,
    screenRadius,
  }: { body: FrameBody; screenX: number; screenY: number; screenRadius: number },
): void {
  const style = BODY_CLASS_STYLES[body.klass];
  drawMarker(ctx, {
    x: screenX,
    y: screenY,
    shape: style.glyph,
    radius: GLYPH_SCREEN_RADIUS,
    color: style.bands.at(-1)!,
  });
  if (screenRadius >= 1) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(screenX, screenY, screenRadius, 0, TWO_PI);
    ctx.strokeStyle = HAIRLINE;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

/** The resolved body: concentric flat-colour bands (outer band first, so later, smaller circles
 *  paint over it toward the centre -- "no smooth gradients"), the far hemisphere from the system
 *  primary darkened under a clip (GAME-0002 §5's hard terminator), and a limb tick at the current
 *  rotation phase so the player can read it exactly (GAME-0001 §4.2: launch windows are rotation
 *  phases). */
function drawBandedSphere(
  ctx: Ctx2D,
  {
    body,
    screenX,
    screenY,
    screenRadius,
  }: { body: FrameBody; screenX: number; screenY: number; screenRadius: number },
): void {
  const style = BODY_CLASS_STYLES[body.klass];
  const bands = style.bands;

  ctx.save();
  ctx.translate(screenX, screenY);

  for (let i = 0; i < bands.length; i++) {
    const r = (screenRadius * (bands.length - i)) / bands.length;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TWO_PI);
    ctx.fillStyle = bands[i]!;
    ctx.fill();
  }

  if (style.terminator === 'hard') {
    const litAngle = toScreenAngle(Math.atan2(body.directionToPrimaryY, body.directionToPrimaryX));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, screenRadius, litAngle + Math.PI / 2, litAngle + (3 * Math.PI) / 2);
    ctx.closePath();
    ctx.clip();
    ctx.beginPath();
    ctx.arc(0, 0, screenRadius, 0, TWO_PI);
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.35; // "darkened one step" as a flat wash over the far hemisphere's bands
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  const tickAngle = toScreenAngle(body.surfacePhase);
  const innerR = screenRadius - 3;
  const outerR = screenRadius + 3;
  ctx.beginPath();
  ctx.moveTo(innerR * Math.cos(tickAngle), innerR * Math.sin(tickAngle));
  ctx.lineTo(outerR * Math.cos(tickAngle), outerR * Math.sin(tickAngle));
  ctx.strokeStyle = KNOWN;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

export function drawBody(
  ctx: Ctx2D,
  {
    body,
    view,
    canvasWidth,
    canvasHeight,
  }: { body: FrameBody; view: View; canvasWidth: number; canvasHeight: number },
): void {
  const { x: screenX, y: screenY } = worldToScreen({
    view,
    canvasWidth,
    canvasHeight,
    x: body.x,
    y: body.y,
  });
  const screenRadius = bodyScreenRadius(body, view);
  if (screenRadius < GLYPH_SCREEN_RADIUS)
    drawBodyGlyph(ctx, { body, screenX, screenY, screenRadius });
  else drawBandedSphere(ctx, { body, screenX, screenY, screenRadius });
}

/** A body's orbit as a dashed ellipse (GAME-0002 §4 "Dashed | Predicted from a known
 *  ephemeris"); a no-op for the system primary, which has no orbit (`body.orbit` is `null`). */
export function drawOrbit(
  ctx: Ctx2D,
  {
    body,
    view,
    canvasWidth,
    canvasHeight,
    dash,
    color,
  }: {
    body: FrameBody;
    view: View;
    canvasWidth: number;
    canvasHeight: number;
    dash: readonly number[];
    color: string;
  },
): void {
  if (!body.orbit) return;
  const { centreX, centreY, semiMajorAxis, semiMinorAxis, rotation } = body.orbit;
  const centre = worldToScreen({ view, canvasWidth, canvasHeight, x: centreX, y: centreY });
  ctx.save();
  ctx.beginPath();
  ctx.setLineDash([...dash]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.ellipse(
    centre.x,
    centre.y,
    semiMajorAxis / view.metresPerPixel,
    semiMinorAxis / view.metresPerPixel,
    toScreenAngle(rotation),
    0,
    TWO_PI,
  );
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
