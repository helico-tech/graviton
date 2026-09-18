// The plot renderer through the real page (GRV-0022, ADR-0004 §1-2): frameHash determinism,
// setView/URL reproducing the same view, and wheel/drag actually moving the camera. Console gate
// with failOnAnyConsoleMessage, matching shell.spec.ts's and parity.spec.ts's convention.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSim } from '../../src/sim/sim.ts';
import { evaluateEphemeris } from '../../src/sim/ephemeris/bodies.ts';
import { worldToScreen } from '../../src/render/camera.ts';
import type { CompiledLevel } from '../../src/levels/compile.ts';
import { attachConsoleGate } from './console-gate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const level = JSON.parse(
  fs.readFileSync(path.join(here, '../../levels/L01-intercept.level.json'), 'utf8'),
) as CompiledLevel;

/** The contact's host body (Yarune) at tick 0, computed the same way the sim itself would --
 *  Node-side, so the test doesn't need a debug-API accessor for body positions that doesn't
 *  otherwise exist. */
function contactHostAtEpoch(): { x: number; y: number; radius: number } {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  const eph = {
    x: new Float64Array(sim.bodies.count),
    y: new Float64Array(sim.bodies.count),
    vx: new Float64Array(sim.bodies.count),
    vy: new Float64Array(sim.bodies.count),
  };
  evaluateEphemeris(sim.bodies, 0, eph);
  const index = level.bodyIds.indexOf('yarune');
  return { x: eph.x[index]!, y: eph.y[index]!, radius: sim.bodies.radius[index]! };
}

/** Counts pixels in a `(2*radius+1)` square around `(x, y)` whose RGB sum clearly exceeds the
 *  ground colour (`#05070a`, sum 22) -- a size-independent way to say "how much of this region is
 *  drawn content" without needing to know exactly which colour is there. */
async function countNonGroundPixels(
  page: Page,
  x: number,
  y: number,
  radius: number,
): Promise<number> {
  return page.evaluate(
    ([px, py, r]) => {
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      const size = r * 2 + 1;
      const x0 = Math.max(0, Math.round(px - r));
      const y0 = Math.max(0, Math.round(py - r));
      const data = ctx.getImageData(x0, y0, size, size).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! + data[i + 1]! + data[i + 2]! > 40) count++;
      }
      return count;
    },
    [x, y, radius] as const,
  );
}

test('default view renders: frameHash is stable across two render() calls and differs after step(600)', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.evaluate(() => window.graviton!.render());
  const first = await page.evaluate(() => window.graviton!.frameHash());
  await page.evaluate(() => window.graviton!.render());
  const second = await page.evaluate(() => window.graviton!.frameHash());
  expect(second).toBe(first);

  const readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['plot.scale']).toBeTruthy();
  expect(readouts['plot.zoom']).toBeTruthy();

  await page.evaluate(() => window.graviton!.step(600));
  await page.evaluate(() => window.graviton!.render());
  const third = await page.evaluate(() => window.graviton!.frameHash());
  expect(third).not.toBe(first);

  expect(gate.violations()).toEqual([]);
});

test("setView zoomed onto the contact's host shows a larger body", async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  const host = contactHostAtEpoch();
  const SAMPLE_RADIUS = 35; // smaller than the zoomed-in sphere, larger than the default glyph

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);
  await page.evaluate(() => window.graviton!.render());

  const defaultView = await page.evaluate(() => window.graviton!.view());
  const canvasSize = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    return { width: canvas.width, height: canvas.height };
  });
  const atDefault = worldToScreen({
    view: defaultView,
    canvasWidth: canvasSize.width,
    canvasHeight: canvasSize.height,
    x: host.x,
    y: host.y,
  });
  const beforeCount = await countNonGroundPixels(page, atDefault.x, atDefault.y, SAMPLE_RADIUS);

  await page.evaluate((v) => window.graviton!.setView(v), {
    centreX: host.x,
    centreY: host.y,
    metresPerPixel: host.radius / 50,
  });
  await page.evaluate(() => window.graviton!.render());
  // setView recentres the view exactly on the host, so its own screen position is now the canvas
  // centre by construction.
  const afterCount = await countNonGroundPixels(
    page,
    canvasSize.width / 2,
    canvasSize.height / 2,
    SAMPLE_RADIUS,
  );

  // At the default (whole-system) view the host is a small glyph; zoomed tight on its own
  // surface (screen radius 50 px, wider than the sample region) it fills the sampled region.
  expect(afterCount).toBeGreaterThan(beforeCount);
  expect(afterCount).toBeGreaterThan((SAMPLE_RADIUS * 2 + 1) ** 2 * 0.9);

  expect(gate.violations()).toEqual([]);
});

test('URL zoom/cx/cy reproduce the same frameHash as setView with the same numbers', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  const host = contactHostAtEpoch();
  const target = { centreX: host.x, centreY: host.y, metresPerPixel: host.radius / 20 };

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);
  await page.evaluate((v) => window.graviton!.setView(v), target);
  await page.evaluate(() => window.graviton!.render());
  const viaSetView = await page.evaluate(() => window.graviton!.frameHash());

  await page.goto(
    `/?debug=1&zoom=${target.metresPerPixel}&cx=${target.centreX}&cy=${target.centreY}`,
  );
  await page.waitForFunction(() => window.graviton?.ready === true);
  await page.evaluate(() => window.graviton!.render());
  const viaUrl = await page.evaluate(() => window.graviton!.frameHash());

  expect(viaUrl).toBe(viaSetView);
  expect(gate.violations()).toEqual([]);
});

test('wheel zooms about the cursor and drag pans, both changing view()', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);
  await page.evaluate(() => window.graviton!.render()); // establishes the default view

  const canvas = page.locator('canvas');
  await canvas.hover();
  const before = await page.evaluate(() => window.graviton!.view());

  await page.mouse.wheel(0, -200); // scroll "up" zooms in
  const afterWheel = await page.evaluate(() => window.graviton!.view());
  expect(afterWheel.metresPerPixel).not.toBe(before.metresPerPixel);

  const box = await canvas.boundingBox();
  if (!box) throw new Error('plot canvas has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await page.evaluate(() => window.graviton!.view());
  expect(afterDrag.centreX).not.toBe(afterWheel.centreX);
  expect(afterDrag.centreY).not.toBe(afterWheel.centreY);

  expect(gate.violations()).toEqual([]);
});

test('view() returns a copy: mutating the result does not move the camera', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);
  await page.evaluate(() => window.graviton!.render());

  const before = await page.evaluate(() => window.graviton!.view().metresPerPixel);
  const after = await page.evaluate(() => {
    const leaked = window.graviton!.view();
    leaked.metresPerPixel = 999999;
    return window.graviton!.view().metresPerPixel;
  });
  expect(after).toBe(before);

  expect(gate.violations()).toEqual([]);
});
