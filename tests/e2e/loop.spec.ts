// The real, non-debug rAF loop through the page (docs/issues/2026-09-18-real-loop-has-no-e2e-
// test.md): every other spec loads `?debug=1`, which by design never starts main.ts's animation
// loop (ADR-0004 §1), so the tick-budget clamp, the fixed-step frame and the warp ease -- the
// thing docs/issues/2026-09-18-warp-label-sticks-on-eased-value.md broke -- have only ever run by
// hand. This drives the loop the way a player actually does: real keyboard input, real wall-clock
// waits, no debug API, reading back only what's on screen. Console gate with
// failOnAnyConsoleMessage, matching the other specs' convention. Asserts only on the shape of the
// result (a whole multiple of `dt`, a settled warp label) and uses generous waits, never an exact
// tick or frame count, so it stays robust on a slow runner.
import { expect, test } from '@playwright/test';
import { attachConsoleGate } from './console-gate.ts';

const DT_SECONDS = 30; // levels/L01-intercept.level.json's dt (shell.spec.ts's fixture too)

function parseSimTimeSeconds(text: string): number {
  const match = /^T\+(\d+):(\d+):(\d+):(\d+)$/.exec(text);
  if (!match) throw new Error(`unparseable status.time reading: ${JSON.stringify(text)}`);
  const [days, hours, minutes, seconds] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

test('] warps to the top rung and advances time in whole dt ticks; space freezes it at 0x', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?level=L01-intercept');
  const timeReadout = page.locator('[data-readout="status.time"]');
  const warpReadout = page.locator('[data-readout="status.warp"]');
  const warpEffectiveReadout = page.locator('[data-readout="status.warp.effective"]');
  await expect(timeReadout).toHaveText('T+00:00:00:00');

  for (let i = 0; i < 5; i++) await page.keyboard.press(']');
  await page.waitForTimeout(600); // real frames run here -- the loop this spec exists to cover

  const timeSeconds = parseSimTimeSeconds((await timeReadout.textContent()) ?? '');
  expect(timeSeconds).toBeGreaterThan(0);
  expect(timeSeconds % DT_SECONDS).toBe(0);

  // The warp-ease bug (now fixed, src/app/loop.ts's warpEaseFrame): the label must settle on the
  // exact rung, never stick mid-ease.
  await expect(warpReadout).toHaveText('10000x');
  const effectiveText = (await warpEffectiveReadout.textContent()) ?? '';
  expect(effectiveText).toMatch(/^\d+x$/);
  expect(Number(effectiveText.slice(0, -1))).toBeLessThanOrEqual(10000);

  await page.keyboard.press(' ');
  await page.waitForTimeout(300); // outlasts the ~150ms ease

  const frozenFirst = await timeReadout.textContent();
  await page.waitForTimeout(300);
  const frozenSecond = await timeReadout.textContent();
  expect(frozenSecond).toBe(frozenFirst);
  await expect(warpReadout).toHaveText('0x');

  expect(gate.violations()).toEqual([]);
});
