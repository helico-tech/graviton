// App shell smoke tests (GRV-0021, ADR-0004 §1-2): level loading, the fixed-step debug API, the
// unknown-level error state and keyboard warp control, all read back as data-readout text so a
// broken panel fails even when the simulation underneath is correct. Console gate with
// failOnAnyConsoleMessage, matching parity.spec.ts's convention.
import { expect, test } from '@playwright/test';
import { attachConsoleGate } from './console-gate.ts';

const DASH = '—';

test('level 01 loads and every status readout is present', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  const readouts = await page.evaluate(() => window.graviton!.readouts());

  expect(readouts['status.time']).toBe('T+00:00:00:00');
  expect(readouts['status.warp']).toBe('0x');
  expect(readouts['status.warp.effective']).toBe('0x');
  expect(readouts['status.post']).toBe('Meskel'); // meskel-rail's host, L01-intercept.level.json
  expect(readouts['status.delay']).toBe(DASH);

  expect(gate.violations()).toEqual([]);
});

test('step(120) advances status.time to the tick-120 timestamp at the level dt', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.evaluate(() => window.graviton!.step(120));
  const readouts = await page.evaluate(() => window.graviton!.readouts());

  expect(readouts['status.time']).toBe('T+00:01:00:00'); // 120 * 30 s = 3600 s = 1 h

  expect(gate.violations()).toEqual([]);
});

test('warpTo advances to an absolute tick', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  const snap = await page.evaluate(() => window.graviton!.warpTo(3298));
  const readouts = await page.evaluate(() => window.graviton!.readouts());

  expect(snap?.tick).toBe(3298);
  expect(readouts['status.time']).toBe('T+01:03:29:00'); // 3298 * 30 s = 98940 s

  expect(gate.violations()).toEqual([]);
});

test('an unknown level shows a visible error state with a clean console', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=nope');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await expect(page.locator('.plot-error')).toBeVisible();
  await expect(page.locator('.plot-error-title')).toContainText('nope');
  await expect(page.locator('.plot-error-list')).toContainText('L01-intercept');

  const errors = await page.evaluate(() => window.graviton!.errors);
  const readouts = await page.evaluate(() => window.graviton!.readouts());

  expect(errors).toEqual([]);
  expect(readouts['status.time']).toBe(DASH);
  expect(readouts['status.post']).toBe(DASH);

  expect(gate.violations()).toEqual([]);
});

test('] steps the warp ladder up, read back through readouts (debug mode runs no loop)', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.keyboard.press(']');
  expect((await page.evaluate(() => window.graviton!.readouts()))['status.warp']).toBe('1x');

  await page.keyboard.press(']');
  expect((await page.evaluate(() => window.graviton!.readouts()))['status.warp']).toBe('10x');

  await page.keyboard.press('[');
  expect((await page.evaluate(() => window.graviton!.readouts()))['status.warp']).toBe('1x');

  await page.keyboard.press(' ');
  expect((await page.evaluate(() => window.graviton!.readouts()))['status.warp']).toBe('0x');

  expect(gate.violations()).toEqual([]);
});

test('readouts() contains every data-readout key present in the DOM', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  const domKeys = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-readout]')].map((el) => el.dataset.readout),
  );
  const readoutKeys = await page.evaluate(() => Object.keys(window.graviton!.readouts()));

  expect(readoutKeys.sort()).toEqual([...new Set(domKeys)].sort());
  expect(readoutKeys.length).toBeGreaterThan(0);

  expect(gate.violations()).toEqual([]);
});

test('window.graviton is not installed without ?debug=1, and the shell still renders', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/');
  await expect(page.locator('.status-bar')).toBeVisible();

  const graviton = await page.evaluate(() => window.graviton);
  expect(graviton).toBeUndefined();

  expect(gate.violations()).toEqual([]);
});
