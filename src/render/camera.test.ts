// Pure camera maths (GRV-0022): world<->screen round-trips, zoom-about-cursor keeping the world
// point fixed, and the scale bar's "1/2/5 x 10^n" picker, table-driven.
import { describe, expect, test } from 'vitest';
import {
  clampMetresPerPixel,
  defaultView,
  formatMetres,
  pan,
  pickScaleBar,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomBounds,
} from './camera.ts';
import type { View } from './camera.ts';

const CANVAS = { canvasWidth: 1280, canvasHeight: 720 };
const view = (overrides: Partial<View> = {}): View => ({
  centreX: 0,
  centreY: 0,
  metresPerPixel: 1000,
  ...overrides,
});

describe('worldToScreen / screenToWorld', () => {
  test('the view centre maps to the canvas centre', () => {
    const screen = worldToScreen({ view: view(), ...CANVAS, x: 0, y: 0 });
    expect(screen).toEqual({ x: 640, y: 360 });
  });

  test('world y "up" maps to screen y "down"', () => {
    const screen = worldToScreen({ view: view(), ...CANVAS, x: 0, y: 1000 });
    expect(screen.y).toBeLessThan(360); // a point above the centre draws higher on screen
  });

  test('round-trips for an off-centre view at an arbitrary zoom', () => {
    const v = view({ centreX: 5.2e9, centreY: -3.1e8, metresPerPixel: 42.7 });
    for (const point of [
      { x: 0, y: 0 },
      { x: 1279, y: 719 },
      { x: 640, y: 360 },
    ]) {
      const world = screenToWorld({ view: v, ...CANVAS, ...point });
      const screen = worldToScreen({ view: v, ...CANVAS, ...world });
      expect(screen.x).toBeCloseTo(point.x, 6);
      expect(screen.y).toBeCloseTo(point.y, 6);
    }
  });
});

describe('zoomAt', () => {
  test('keeps the world point under the cursor fixed', () => {
    const v = view({ metresPerPixel: 1000 });
    const bounds = zoomBounds({ largestOrbitRadius: 1e11 });
    const before = screenToWorld({ view: v, ...CANVAS, x: 900, y: 200 });

    const zoomed = zoomAt({ view: v, ...CANVAS, screenX: 900, screenY: 200, factor: 1.5, bounds });

    const after = screenToWorld({ view: zoomed, ...CANVAS, x: 900, y: 200 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.metresPerPixel).toBeCloseTo(1500, 6);
  });

  test('clamps to the given bounds', () => {
    const bounds = { min: 100, max: 1_000_000 };
    const zoomedOut = zoomAt({
      view: view({ metresPerPixel: 900_000 }),
      ...CANVAS,
      screenX: 0,
      screenY: 0,
      factor: 10,
      bounds,
    });
    expect(zoomedOut.metresPerPixel).toBe(bounds.max);

    const zoomedIn = zoomAt({
      view: view({ metresPerPixel: 200 }),
      ...CANVAS,
      screenX: 0,
      screenY: 0,
      factor: 0.01,
      bounds,
    });
    expect(zoomedIn.metresPerPixel).toBe(bounds.min);
  });
});

describe('pan', () => {
  test('a positive screen-x drag moves the world view left (drags the world with the cursor)', () => {
    const panned = pan({ view: view({ metresPerPixel: 10 }), dxPixels: 50, dyPixels: 0 });
    expect(panned.centreX).toBe(-500);
    expect(panned.centreY).toBe(0);
  });

  test('a positive screen-y drag moves the world view up', () => {
    const panned = pan({ view: view({ metresPerPixel: 10 }), dxPixels: 0, dyPixels: 20 });
    expect(panned.centreY).toBe(200);
  });
});

describe('clampMetresPerPixel', () => {
  test('clamps into [min, max]', () => {
    const bounds = { min: 10, max: 100 };
    expect(clampMetresPerPixel(5, bounds)).toBe(10);
    expect(clampMetresPerPixel(500, bounds)).toBe(100);
    expect(clampMetresPerPixel(50, bounds)).toBe(50);
  });
});

describe('zoomBounds', () => {
  test('nine decades above the 100 m floor for an ordinary system', () => {
    const bounds = zoomBounds({ largestOrbitRadius: 1e11 }); // ~0.67 au
    expect(bounds.min).toBe(100);
    expect(bounds.max).toBe(100 * 1e9);
  });

  test('widens the ceiling for a system too large for the default decade span', () => {
    const bounds = zoomBounds({ largestOrbitRadius: 1e20 });
    expect(bounds.max).toBeGreaterThan(100 * 1e9);
  });
});

describe('defaultView', () => {
  test('centres on the origin and frames the system extent with margin', () => {
    const v = defaultView({ largestOrbitRadius: 1e11, canvasWidth: 1000, canvasHeight: 500 });
    expect(v.centreX).toBe(0);
    expect(v.centreY).toBe(0);
    // Diameter*margin / shorter dimension: (2e11 * 1.2) / 500.
    expect(v.metresPerPixel).toBeCloseTo((1e11 * 2 * 1.2) / 500, 6);
  });

  test('stays within its own zoom bounds even for a degenerate (zero-orbit) system', () => {
    const v = defaultView({ largestOrbitRadius: 0, canvasWidth: 800, canvasHeight: 600 });
    const bounds = zoomBounds({ largestOrbitRadius: 0 });
    expect(v.metresPerPixel).toBeGreaterThanOrEqual(bounds.min);
    expect(v.metresPerPixel).toBeLessThanOrEqual(bounds.max);
  });
});

describe('formatMetres', () => {
  test.each([
    [50, '50 m'],
    [1500, '1.5 km'],
    [2_500_000, '2.5 Mm'],
    [3_000_000_000, '3 Gm'],
    [1.495978707e11, '1 au'],
  ])('%i -> %s', (metres, label) => {
    expect(formatMetres(metres)).toBe(label);
  });
});

describe('pickScaleBar', () => {
  test.each([
    // metresPerPixel, canvasWidth -> the nice 1/2/5 x 10^n length nearest a fifth of the width
    [1, 1000, 200],
    [1000, 1280, 200_000],
    [3, 1000, 500],
    [4_000_000, 1280, 1_000_000_000],
  ])('metresPerPixel=%i canvasWidth=%i -> %i m', (metresPerPixel, canvasWidth, expectedMetres) => {
    const bar = pickScaleBar({ metresPerPixel, canvasWidth });
    expect(bar.metres).toBe(expectedMetres);
    expect(bar.pixels).toBeCloseTo(expectedMetres / metresPerPixel, 6);
    expect(bar.label).toBe(formatMetres(expectedMetres));
  });

  test('is a round 1/2/5 x 10^n number for a dense sweep of zoom levels', () => {
    for (let mpp = 0.3; mpp < 1e12; mpp *= 1.37) {
      const bar = pickScaleBar({ metresPerPixel: mpp, canvasWidth: 1280 });
      const exponent = Math.floor(Math.log10(bar.metres));
      const mantissa = Math.round(bar.metres / 10 ** exponent);
      expect([1, 2, 5]).toContain(mantissa);
    }
  });

  test('degenerates to zero rather than NaN/Infinity at zero zoom', () => {
    const bar = pickScaleBar({ metresPerPixel: 0, canvasWidth: 1280 });
    expect(bar).toEqual({ metres: 0, label: '0 m', pixels: 0 });
  });
});
