// Selection, its readouts and the timeline through the real page (GRV-0023, ADR-0004 §1-2):
// clicking a body selects it and every panel field matches a value computed independently from
// the compiled level; replaying the committed solution and warping to its recorded impact tick
// then selecting the probe and the contact in turn shows expended/cleared; clicking empty space
// clears. Console gate with failOnAnyConsoleMessage, matching shell.spec.ts's and plot.spec.ts's
// convention.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { worldToScreen } from '../../src/render/camera.ts';
import type { View } from '../../src/render/camera.ts';
import { formatDegrees, formatDuration, formatKilometres } from '../../src/ui/format.ts';
import type { CompiledLevel } from '../../src/levels/compile.ts';
import { attachConsoleGate } from './console-gate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const level = JSON.parse(
  fs.readFileSync(path.join(here, '../../levels/L01-intercept.level.json'), 'utf8'),
) as CompiledLevel;
const evidence = JSON.parse(
  fs.readFileSync(path.join(here, '../../levels/L01-intercept.evidence.json'), 'utf8'),
) as { contacts: { impactTick: number }[] };
// `impactTick` is the tick *during* which stepTick resolved the impact (src/sim/dynamics/step.ts's
// testContactImpacts) -- the contact only reads cleared, and the probe expended, once the sim has
// advanced one tick past it (docs/evidence/GRV-0022/README.md's own note on this).
const AFTER_IMPACT_TICK = evidence.contacts[0]!.impactTick + 1;

const MESKEL_INDEX = level.bodyIds.indexOf('meskel');
const MESKEL = level.scenario.bodies[MESKEL_INDEX] as {
  a: number;
  e: number;
  radius: number;
};
const CORVAI_MU = (level.scenario.bodies[0] as { mu: number }).mu;

/** Clicks a world point, translating the debug API's canvas-backing-pixel screen coordinates
 *  (device-pixel-ratio scaled, ADR-0004 §1) into the CSS pixels `page.mouse.click` expects. */
async function clickWorldPoint(page: Page, world: { x: number; y: number }): Promise<void> {
  const view = await page.evaluate(() => window.graviton!.view());
  const canvasSize = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    return { width: canvas.width, height: canvas.height };
  });
  const screen = worldToScreen({
    view,
    canvasWidth: canvasSize.width,
    canvasHeight: canvasSize.height,
    ...world,
  });
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('plot canvas has no bounding box');
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  await page.mouse.click(box.x + screen.x / dpr, box.y + screen.y / dpr);
}

test('clicking the rail host selects it and every field matches an independently computed value', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  const state = await page.evaluate(() => window.graviton!.state());
  const hostPos = state.bodies[MESKEL_INDEX]!;
  const view: View = { centreX: hostPos.x, centreY: hostPos.y, metresPerPixel: 5000 };
  await page.evaluate((v) => window.graviton!.setView(v), view);
  await page.evaluate(() => window.graviton!.render());

  await clickWorldPoint(page, hostPos);

  const selection = await page.evaluate(() => window.graviton!.selection());
  expect(selection).toEqual({ kind: 'body', index: MESKEL_INDEX });

  const readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['selection.name']).toBe('Meskel');
  expect(readouts['selection.class']).toBe('Rock');
  expect(readouts['selection.radius']).toBe(formatKilometres(MESKEL.radius));
  const expectedPeriod = 2 * Math.PI * Math.sqrt((MESKEL.a * MESKEL.a * MESKEL.a) / CORVAI_MU);
  expect(readouts['selection.period']).toBe(formatDuration(expectedPeriod));
  // meanAnomaly0 is 0 for Meskel (L01-intercept.level.yaml), so at tick 0 it sits at periapsis.
  expect(readouts['selection.distance']).toBe(formatKilometres(MESKEL.a * (1 - MESKEL.e)));
  expect(readouts['selection.phase']).toBe(formatDegrees(0));

  expect(gate.violations()).toEqual([]);
});

test('after the committed solution replays to its impact tick, the probe reads expended and the contact reads cleared', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.evaluate(() => window.graviton!.loadSolution());
  await page.evaluate((tick) => window.graviton!.warpTo(tick), AFTER_IMPACT_TICK);

  await page.evaluate(() => window.graviton!.select({ kind: 'probe', index: 0 }));
  const probeReadouts = await page.evaluate(() => window.graviton!.readouts());
  expect(probeReadouts['selection.state']).toMatch(/^EXPENDED/);
  // Every field this unit's acceptance lists for a probe is present as DOM text.
  for (const field of ['mass', 'propellant', 'deltaV', 'speed', 'range', 'state']) {
    expect(probeReadouts[`selection.${field}`]).toBeTruthy();
  }

  await page.evaluate(() => window.graviton!.select({ kind: 'contact', index: 0 }));
  const contactReadouts = await page.evaluate(() => window.graviton!.readouts());
  expect(contactReadouts['selection.state']).toMatch(/^CLEARED AT /);

  expect(gate.violations()).toEqual([]);
});

test('clicking empty space clears the selection', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.evaluate(() => window.graviton!.select({ kind: 'body', index: 0 }));
  expect(await page.evaluate(() => window.graviton!.selection())).not.toBeNull();

  // Zoomed far out, every marker clusters within a few px of the canvas centre -- a corner is
  // guaranteed empty (the same reasoning tests/e2e/plot.spec.ts's ground-colour test relies on).
  await page.evaluate(() =>
    window.graviton!.setView({ centreX: 0, centreY: 0, metresPerPixel: 1e13 }),
  );
  await page.evaluate(() => window.graviton!.render());
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('plot canvas has no bounding box');
  await page.mouse.click(box.x + 10, box.y + 10);

  expect(await page.evaluate(() => window.graviton!.selection())).toBeNull();
  await expect(page.locator('.placeholder')).toHaveText('NO SELECTION');

  expect(gate.violations()).toEqual([]);
});

test('readouts() keys include every selection and timeline field the panel shows', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&solution=1');
  await page.waitForFunction(() => window.graviton?.ready === true);
  await page.evaluate(() => window.graviton!.select({ kind: 'rail', index: 0 }));

  const readouts = await page.evaluate(() => window.graviton!.readouts());
  const domKeys = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-readout]')].map((el) => el.dataset.readout),
  );

  expect(Object.keys(readouts).sort()).toEqual([...new Set(domKeys)].sort());
  for (const field of ['host', 'angle', 'muzzle', 'cone', 'reload']) {
    expect(readouts[`selection.${field}`]).toBeTruthy();
  }
  expect(readouts['timeline.launch.0']).toBeTruthy();
  expect(readouts['timeline.cursor']).toBeTruthy();

  expect(gate.violations()).toEqual([]);
});
