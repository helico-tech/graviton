// Renders level 01 through @napi-rs/canvas and asserts sampled pixels and statistics (GRV-0022
// acceptance) -- never pixel goldens (research §3: Playwright's Chromium and @napi-rs/canvas
// anti-alias text and strokes 7% differently, so the two can never share one).
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, test } from 'vitest';
import { advance, createSim } from '../../src/sim/sim.ts';
import type { Command, Scenario } from '../../src/sim/sim.ts';
import { captureFrame } from '../../src/render/frame.ts';
import type { Frame, FrameLevelNames } from '../../src/render/frame.ts';
import { defaultView, pickScaleBar, worldToScreen } from '../../src/render/camera.ts';
import type { View } from '../../src/render/camera.ts';
import { hashCanvasPixels, renderPlot, SCALE_BAR_MARGIN_PX } from '../../src/render/plot.ts';
import type { PlotSelection } from '../../src/render/plot.ts';
import { GLYPH_SCREEN_RADIUS } from '../../src/render/bodies.ts';
import { GROUND, HAIRLINE, KNOWN, KNOWN_DIM, UNVERIFIED } from '../../src/render/palette.ts';
import type { Ctx2D } from '../../src/render/ctx2d.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';

interface CompiledLevelFile extends FrameLevelNames {
  seed: number;
  scenario: Scenario;
}

interface SolutionFile {
  log: Command[];
  ticks: number;
}

const level: CompiledLevelFile = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'levels/L01-intercept.level.json'), 'utf8'),
);
const solution: SolutionFile = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'levels/L01-intercept.solution.json'), 'utf8'),
);

function frameAt({ ticks = 0, log = [] }: { ticks?: number; log?: Command[] } = {}): Frame {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  if (ticks > 0) advance({ sim, log, ticks });
  return captureFrame({ sim, level });
}

const WIDTH = 640;
const HEIGHT = 360;

function draw({
  frame,
  view,
  selection = null,
}: {
  frame: Frame;
  view: View;
  selection?: PlotSelection | null;
}): {
  data: Buffer;
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>;
} {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  renderPlot({
    ctx: ctx as unknown as Ctx2D,
    view,
    frame,
    trails: new Map(),
    canvasWidth: WIDTH,
    canvasHeight: HEIGHT,
    selection,
  });
  return { data: canvas.toBuffer('image/png'), ctx };
}

function pixelAt(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
): [number, number, number, number] {
  const { data } = ctx.getImageData(Math.round(x), Math.round(y), 1, 1);
  return [data[0]!, data[1]!, data[2]!, data[3]!];
}

function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const GROUND_RGB = hexToRgb(GROUND);
const HAIRLINE_RGB = hexToRgb(HAIRLINE);
const KNOWN_DIM_RGB = hexToRgb(KNOWN_DIM);

describe('renderPlot: ground', () => {
  test('a spot far from any content, off the grid, is exactly the ground colour', () => {
    const frame = frameAt();
    // Centred far out in empty space, at a coarse zoom -- no body, orbit or marker anywhere near.
    const view: View = { centreX: 5e14, centreY: 5e14, metresPerPixel: 1e9 };
    const { ctx } = draw({ frame, view });

    const bar = pickScaleBar({ metresPerPixel: view.metresPerPixel, canvasWidth: WIDTH });
    // Halfway between two minor gridlines in world space, converted to screen -- guaranteed off
    // every gridline by construction, not by luck.
    const minorSpacing = bar.metres / 5;
    const worldX = Math.floor(view.centreX / minorSpacing) * minorSpacing + minorSpacing / 2;
    const worldY = Math.floor(view.centreY / minorSpacing) * minorSpacing + minorSpacing / 2;
    const screen = worldToScreen({
      view,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
      x: worldX,
      y: worldY,
    });

    expect(pixelAt(ctx, screen.x, screen.y).slice(0, 3)).toEqual(GROUND_RGB);
  });
});

describe('renderPlot: bodies', () => {
  test("a banded sphere's lit hemisphere (toward the primary) is brighter than its dark one", () => {
    const frame = frameAt();
    const meskel = frame.bodies.find((b) => b.id === 'meskel')!;
    // meanAnomalyAtEpoch is 0 for meskel (L01-intercept.level.yaml), so at tick 0 it sits on the
    // +x axis and its direction to the primary (at the origin) is exactly -x.
    expect(meskel.directionToPrimaryX).toBeCloseTo(-1, 6);
    expect(meskel.directionToPrimaryY).toBeCloseTo(0, 6);

    const metresPerPixel = meskel.radius / 40; // a comfortably large banded sphere, ~40 px radius
    const view: View = { centreX: meskel.x, centreY: meskel.y, metresPerPixel };
    const { ctx } = draw({ frame, view });
    const centre = worldToScreen({
      view,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
      x: meskel.x,
      y: meskel.y,
    });

    const lit = pixelAt(ctx, centre.x - 20, centre.y); // -x screen = toward the primary here
    const dark = pixelAt(ctx, centre.x + 20, centre.y);
    const litBrightness = lit[0]! + lit[1]! + lit[2]!;
    const darkBrightness = dark[0]! + dark[1]! + dark[2]!;
    expect(litBrightness).toBeGreaterThan(darkBrightness);
  });

  test('below the glyph threshold, a hairline ring appears at the true screen radius', () => {
    const frame = frameAt();
    const meskel = frame.bodies.find((b) => b.id === 'meskel')!;
    // Screen radius 3 px: below GLYPH_SCREEN_RADIUS (glyph mode) but >= 1 px (the ring draws).
    const metresPerPixel = meskel.radius / 3;
    const view: View = { centreX: meskel.x, centreY: meskel.y, metresPerPixel };
    const { ctx } = draw({ frame, view });
    expect(meskel.radius / metresPerPixel).toBeLessThan(GLYPH_SCREEN_RADIUS);

    const centre = worldToScreen({
      view,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
      x: meskel.x,
      y: meskel.y,
    });
    const ringRadius = meskel.radius / metresPerPixel;
    let sawRing = false;
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      const px = pixelAt(
        ctx,
        centre.x + ringRadius * Math.cos(rad),
        centre.y + ringRadius * Math.sin(rad),
      );
      if (colorDistance(px, HAIRLINE_RGB) < 20) sawRing = true;
    }
    expect(sawRing).toBe(true);
  });
});

describe('renderPlot: orbits', () => {
  test('a dashed orbit sampled along its path has both stroke and ground pixels', () => {
    const frame = frameAt();
    const meskel = frame.bodies.find((b) => b.id === 'meskel')!;
    const orbit = meskel.orbit!;
    const view = defaultView({
      largestOrbitRadius: frame.systemExtent,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
    });
    const { ctx } = draw({ frame, view });

    let sawStroke = false;
    let sawGap = false;
    for (let deg = 0; deg < 360; deg += 1) {
      const rad = (deg * Math.PI) / 180;
      const worldX =
        orbit.centreX +
        orbit.semiMajorAxis * Math.cos(rad) * Math.cos(orbit.rotation) -
        orbit.semiMinorAxis * Math.sin(rad) * Math.sin(orbit.rotation);
      const worldY =
        orbit.centreY +
        orbit.semiMajorAxis * Math.cos(rad) * Math.sin(orbit.rotation) +
        orbit.semiMinorAxis * Math.sin(rad) * Math.cos(orbit.rotation);
      const screen = worldToScreen({
        view,
        canvasWidth: WIDTH,
        canvasHeight: HEIGHT,
        x: worldX,
        y: worldY,
      });
      const px = pixelAt(ctx, screen.x, screen.y);
      if (colorDistance(px, KNOWN_DIM_RGB) < 40) sawStroke = true;
      else if (colorDistance(px, GROUND_RGB) < 10) sawGap = true;
    }
    expect(sawStroke).toBe(true);
    expect(sawGap).toBe(true);
  });
});

describe('renderPlot: scale bar', () => {
  test("the drawn ruler's pixel length matches pickScaleBar for the same view", () => {
    const frame = frameAt();
    const view: View = { centreX: 0, centreY: 0, metresPerPixel: 5000 };
    const { ctx } = draw({ frame, view });
    const bar = pickScaleBar({ metresPerPixel: view.metresPerPixel, canvasWidth: WIDTH });

    const y = HEIGHT - SCALE_BAR_MARGIN_PX;
    const x1 = WIDTH - SCALE_BAR_MARGIN_PX;
    const x0 = x1 - bar.pixels;
    expect(colorDistance(pixelAt(ctx, x0 + 1, y), KNOWN_DIM_RGB)).toBeLessThan(40);
    expect(colorDistance(pixelAt(ctx, x1 - 1, y), KNOWN_DIM_RGB)).toBeLessThan(40);
    // Just past the ruler's far end, the stroke stops.
    expect(colorDistance(pixelAt(ctx, x0 - 10, y), KNOWN_DIM_RGB)).toBeGreaterThan(40);
  });
});

describe('renderPlot: selection ring', () => {
  test('rings the selected body in ice blue, at its true screen radius plus margin', () => {
    const frame = frameAt();
    const meskel = frame.bodies.find((b) => b.id === 'meskel')!;
    const meskelIndex = frame.bodies.indexOf(meskel);
    const metresPerPixel = meskel.radius / 40; // resolved-sphere mode, so the ring sits outside it
    const view: View = { centreX: meskel.x, centreY: meskel.y, metresPerPixel };
    const { ctx } = draw({ frame, view, selection: { kind: 'body', index: meskelIndex } });

    const centre = worldToScreen({
      view,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
      x: meskel.x,
      y: meskel.y,
    });
    const ringRadius = meskel.radius / metresPerPixel + 4;
    let sawRing = false;
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      const px = pixelAt(
        ctx,
        centre.x + ringRadius * Math.cos(rad),
        centre.y + ringRadius * Math.sin(rad),
      );
      if (colorDistance(px, hexToRgb(KNOWN)) < 20) sawRing = true;
    }
    expect(sawRing).toBe(true);
  });

  test('rings an uncleared contact in amber, not ice blue', () => {
    const frame = frameAt();
    const hulk = frame.contacts.find((c) => c.id === 'drift-hulk')!;
    expect(hulk.cleared).toBe(false);
    const view: View = { centreX: hulk.x, centreY: hulk.y, metresPerPixel: 500 };
    const { ctx } = draw({ frame, view, selection: { kind: 'contact', index: 0 } });

    const centre = worldToScreen({
      view,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
      x: hulk.x,
      y: hulk.y,
    });
    const ringRadius = 8; // CONTACT_MARKER_RADIUS_PX (4) + the selection ring's margin (4)
    let sawAmber = false;
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      const px = pixelAt(
        ctx,
        centre.x + ringRadius * Math.cos(rad),
        centre.y + ringRadius * Math.sin(rad),
      );
      if (colorDistance(px, hexToRgb(UNVERIFIED)) < 20) sawAmber = true;
    }
    expect(sawAmber).toBe(true);
  });

  test('a null selection draws no ring: identical pixels to omitting the field entirely', () => {
    const frame = frameAt();
    const view = defaultView({
      largestOrbitRadius: frame.systemExtent,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
    });
    const withNull = draw({ frame, view, selection: null });
    const omitted = draw({ frame, view });
    expect(hashCanvasPixels(withNull.ctx, WIDTH, HEIGHT)).toBe(
      hashCanvasPixels(omitted.ctx, WIDTH, HEIGHT),
    );
  });

  test('a selection index the frame does not have (a probe never launched) draws nothing, not a crash', () => {
    const frame = frameAt();
    const view = defaultView({
      largestOrbitRadius: frame.systemExtent,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
    });
    expect(() => draw({ frame, view, selection: { kind: 'probe', index: 0 } })).not.toThrow();
  });
});

describe('renderPlot: determinism', () => {
  test('two renders of the same frame and view are byte-identical', () => {
    const frame = frameAt();
    const view = defaultView({
      largestOrbitRadius: frame.systemExtent,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
    });
    const first = draw({ frame, view });
    const second = draw({ frame, view });
    expect(hashCanvasPixels(first.ctx, WIDTH, HEIGHT)).toBe(
      hashCanvasPixels(second.ctx, WIDTH, HEIGHT),
    );
  });

  test('a frame after advancing (the committed solution flying) differs from tick 0', () => {
    const before = frameAt();
    const after = frameAt({ ticks: solution.ticks, log: solution.log });
    const view = defaultView({
      largestOrbitRadius: before.systemExtent,
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
    });

    const beforeDraw = draw({ frame: before, view });
    const afterDraw = draw({ frame: after, view });
    expect(hashCanvasPixels(beforeDraw.ctx, WIDTH, HEIGHT)).not.toBe(
      hashCanvasPixels(afterDraw.ctx, WIDTH, HEIGHT),
    );
  });
});
