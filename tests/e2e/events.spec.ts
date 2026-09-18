// Events and time control (GRV-0027, GAME-0001 §4.11, GAME-0002 §9): automatic drop to 1x on a
// landed event, warp to event, and the determinism guarantee that an event's tick is the same
// whether reached at 1x, at the warp ceiling, or by repeated warpToEvent(). Console gate with
// failOnAnyConsoleMessage, matching every other spec in this directory. The real (non-debug) loop
// case mirrors tests/e2e/loop.spec.ts's own no-`?debug=1` style (docs/issues/2026-09-18-real-loop-
// has-no-e2e-test.md): every other test here drives `window.graviton` directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TICK_BUDGET_PER_FRAME } from '../../src/app/loop.ts';
import { attachConsoleGate } from './console-gate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// levels/L01-intercept.evidence.json's own recorded outcome; the solution's own launch command
// (levels/L01-intercept.solution.json) fires at tick 2464.
const L01_LAUNCH_TICK = 2464;
const L01_IMPACT_TICK = 3298;

interface EvidenceContact {
  impactTick: number;
}

const l01Evidence = JSON.parse(
  fs.readFileSync(path.join(here, '../../levels/L01-intercept.evidence.json'), 'utf8'),
) as { contacts: EvidenceContact[] };

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.graviton?.ready === true);
}

test('warpToEvent() drops to launch, then to impact, at the evidence file’s own recorded tick', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=L01-intercept');
  await waitReady(page);
  await page.evaluate(() => window.graviton!.loadSolution());

  await page.evaluate(() => window.graviton!.warpToEvent());
  let readouts = await page.evaluate(() => window.graviton!.readouts());
  let state = await page.evaluate(() => window.graviton!.state());
  expect(readouts['status.event']).toBe('LAUNCH PRB-01');
  expect(readouts['status.warp']).toBe('1x');
  expect(state.tick).toBe(L01_LAUNCH_TICK + 1); // one past the tick the launch command fires at

  // The design note allows either a closest approach or an impact next; this solution is a direct
  // intercept (no flyby before the hit), so the real next drop is straight to impact -- looping
  // (bounded) keeps the test honest about that rather than assuming it.
  let guard = 0;
  do {
    await page.evaluate(() => window.graviton!.warpToEvent());
    readouts = await page.evaluate(() => window.graviton!.readouts());
    expect(readouts['status.warp']).toBe('1x'); // every drop lands at 1x, never anything else
    guard++;
  } while (!readouts['status.event']!.startsWith('IMPACT') && guard < 5);

  state = await page.evaluate(() => window.graviton!.state());
  expect(readouts['status.event']).toBe(`IMPACT PRB-01 → ${'DRIFT-HULK'}`);
  expect(state.tick).toBe(L01_IMPACT_TICK + 1);
  expect(l01Evidence.contacts[0]!.impactTick).toBe(L01_IMPACT_TICK); // cross-check the fixture itself

  const events = await page.evaluate(() => window.graviton!.events());
  expect(events).toContainEqual({ tick: L01_IMPACT_TICK, kind: 'impact', probe: 0, contact: 0 });

  expect(gate.violations()).toEqual([]);
});

test('a further warpToEvent() with nothing left to predict is a no-op', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=L01-intercept');
  await waitReady(page);
  await page.evaluate(() => window.graviton!.loadSolution());

  // Drain every known event (bounded well past what this solution has).
  for (let i = 0; i < 5; i++) await page.evaluate(() => window.graviton!.warpToEvent());
  const tickBefore = (await page.evaluate(() => window.graviton!.state())).tick;
  expect(await page.evaluate(() => window.graviton!.nextEventTick())).toBeNull();

  await page.evaluate(() => window.graviton!.warpToEvent());

  expect((await page.evaluate(() => window.graviton!.state())).tick).toBe(tickBefore);

  expect(gate.violations()).toEqual([]);
});

test('events() is identical (ticks and kinds) whether reached at 1x, at 10000x, or by warpToEvent()', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  const horizon = L01_IMPACT_TICK + 10;

  async function eventsFor(run: () => Promise<void>): Promise<{ tick: number; kind: string }[]> {
    await page.goto('/?debug=1&level=L01-intercept');
    await waitReady(page);
    await page.evaluate(() => window.graviton!.loadSolution());
    await run();
    const events = await page.evaluate(() => window.graviton!.events());
    return events.map((e) => ({ tick: e.tick, kind: e.kind })).sort((a, b) => a.tick - b.tick);
  }

  const via1x = await eventsFor(async () => {
    // 1x, in batches -- never a single giant advance.
    let stepped = 0;
    while (stepped < horizon) {
      const batch = Math.min(200, horizon - stepped);
      await page.evaluate((n) => window.graviton!.step(n), batch);
      stepped += batch;
    }
  });

  const viaWarpTo = await eventsFor(async () => {
    await page.evaluate((tick) => window.graviton!.warpTo(tick), horizon);
  });

  const viaWarpToEvent = await eventsFor(async () => {
    let guard = 0;
    while (
      (await page.evaluate(() => window.graviton!.state())).tick < horizon &&
      (await page.evaluate(() => window.graviton!.nextEventTick())) !== null &&
      guard < 10
    ) {
      await page.evaluate(() => window.graviton!.warpToEvent());
      guard++;
    }
  });

  expect(via1x.length).toBeGreaterThan(0);
  expect(viaWarpTo).toEqual(via1x);
  expect(viaWarpToEvent).toEqual(via1x);

  expect(gate.violations()).toEqual([]);
});

test('screenshot: render() right after a landed event shows the status bar inverted, and clears on the next render()', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=L01-intercept&w=1280&h=200');
  await waitReady(page);
  await page.evaluate(() => window.graviton!.loadSolution());
  await page.evaluate(() => window.graviton!.warpToEvent()); // lands the launch

  await page.evaluate(() => window.graviton!.render());
  await expect(page.locator('.status-bar')).toHaveClass(/status-bar--invert/);

  await page.evaluate(() => window.graviton!.render());
  await expect(page.locator('.status-bar')).not.toHaveClass(/status-bar--invert/);

  expect(gate.violations()).toEqual([]);
});

test('the timeline strip marks upcoming events dim and past ones full', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=L01-intercept');
  await waitReady(page);
  await page.evaluate(() => window.graviton!.loadSolution());

  await expect(page.locator('.timeline-mark--past')).toHaveCount(0);
  const upcomingBefore = await page.locator('.timeline-mark:not(.timeline-mark--past)').count();
  expect(upcomingBefore).toBeGreaterThan(0); // the not-yet-reached launch, at least

  await page.evaluate(() => window.graviton!.warpToEvent());
  await page.evaluate(() => window.graviton!.render());

  await expect(page.locator('.timeline-mark--past')).toHaveCount(1); // the launch just landed

  expect(gate.violations()).toEqual([]);
});

// The real, non-debug rAF loop (mirrors loop.spec.ts): real keyboard input, real wall-clock waits,
// no debug API. Polls up to ~20 s -- L01's impact is at tick 3298, and the tick budget (700/frame)
// makes that a few seconds of real frames even from a cold start.
test('the real loop auto-drops to 1x within one frame budget of the recorded impact tick', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?level=L01-intercept&solution=1');
  const eventReadout = page.locator('[data-readout="status.event"]');
  const warpReadout = page.locator('[data-readout="status.warp"]');
  const timeReadout = page.locator('[data-readout="status.time"]');

  // Pressing ']' x5 puts the rung itself at the ladder's top (10000x) synchronously, before any
  // frame runs -- but L01's own flight is short enough at the 700-tick frame budget (well under
  // the ~150 ms warp label's own ease) that the automatic drop can land before the eased *label*
  // ever visibly settles at "10000x" text; the label is cosmetic (loop.ts's warpEaseFrame), so
  // this doesn't assert on it, only on the drop actually landing at 1x with IMPACT.
  for (let i = 0; i < 5; i++) await page.keyboard.press(']');

  await expect(eventReadout).toHaveText(/^IMPACT/, { timeout: 20_000 });
  await expect(warpReadout).toHaveText('1x');

  const timeText = (await timeReadout.textContent()) ?? '';
  const match = /^T\+(\d+):(\d+):(\d+):(\d+)$/.exec(timeText);
  if (!match) throw new Error(`unparseable status.time reading: ${JSON.stringify(timeText)}`);
  const [days, hours, minutes, seconds] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const totalSeconds = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  const tick = totalSeconds / 30; // L01-intercept.level.json's own dt

  expect(tick).toBeGreaterThanOrEqual(L01_IMPACT_TICK);
  expect(tick).toBeLessThanOrEqual(L01_IMPACT_TICK + TICK_BUDGET_PER_FRAME);

  expect(gate.violations()).toEqual([]);
});
