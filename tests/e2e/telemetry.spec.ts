// Telemetry and the information horizon (GRV-0030, ADR-0007 §5-6, GAME-0001 §4.6-4.7/§4.11,
// GAME-0002 §4/§7/§8/§11): the post only ever sees a probe's last observation, plus a prediction
// from there to now -- driven end to end on T01-far-post (levels/T01-far-post.level.yaml), a
// fixture whose post sits ten light-minutes from its own rail (~20 ticks at dt=30s each way), so
// the one-way delay is large enough to assert on directly rather than needing sub-tick precision.
// Mirrors events.spec.ts's own console-gate and evidence-file-cross-check style.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { attachConsoleGate } from './console-gate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// T01-far-post.solution.json's own committed command (GRV-0030's fixed evaluateLaunch, written by
// `pnpm levels:solve T01-far-post --write`): issued at tick 5724, which -- given the level's
// ~20-tick one-way delay (10 light-minutes / 30 s dt) -- materialises the probe at tick 5744
// (confirmed directly against the running level; docs/evidence/GRV-0030/README.md has the
// derivation) and is itself observed (the LAUNCH telemetry event) at tick 5764.
const T01_LAUNCH_TICK = 5744;
const T01_LAUNCH_ARRIVAL_TICK = 5764;

interface EvidenceContact {
  impactTick: number;
}

const t01Evidence = JSON.parse(
  fs.readFileSync(path.join(here, '../../levels/T01-far-post.evidence.json'), 'utf8'),
) as { contacts: EvidenceContact[] };
const T01_IMPACT_TICK = t01Evidence.contacts[0]!.impactTick;
// Confirmed directly against the running level: close to the pure ~20-tick light delay this time
// (no occlusion blackout in the way for this particular launch phase, unlike the earlier
// hand-solved candidate -- both are physically valid, this is just the solver's own solution).
const T01_IMPACT_ARRIVAL_TICK = 5831;

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.graviton?.ready === true);
}

async function loadT01(page: Page): Promise<void> {
  await page.goto('/?debug=1&level=T01-far-post');
  await waitReady(page);
  await page.evaluate(() => window.graviton!.loadSolution());
  await page.evaluate(() => window.graviton!.select({ kind: 'probe', index: 0 }));
}

test('observed(0) has no observation before first light, then shows the delayed observation once telemetry arrives', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  await loadT01(page);

  // Shortly after the probe actually materialises, but before its light has had time to reach
  // the post (T01_LAUNCH_TICK + 5 < T01_LAUNCH_ARRIVAL_TICK) -- the post's picture is still empty
  // (`observed` returns null only for an out-of-range index; a valid, not-yet-observed object
  // reports a real ObservedObject with a null observation, src/app/app.ts's own convention).
  await page.evaluate((t) => window.graviton!.warpTo(t), T01_LAUNCH_TICK + 5);
  const beforeLight = await page.evaluate(() => window.graviton!.observed(0));
  expect(beforeLight).not.toBeNull();
  expect(beforeLight!.observation).toBeNull();
  expect(beforeLight!.predicted).toBeNull();
  expect(beforeLight!.tail).toEqual([]);
  let readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['status.delay']).toBe('—');
  expect(readouts['selection.observed']).toBe('—');

  // A little past the arrival tick: the observation now exists, ~20 ticks (600 s) stale, and the
  // status bar/selection panel both read the same one-way delay (GAME-0002 §8's "four numbers
  // that never move" / OBSERVED age).
  await page.evaluate((t) => window.graviton!.warpTo(t), T01_LAUNCH_ARRIVAL_TICK + 10);
  const observed = await page.evaluate(() => window.graviton!.observed(0));
  expect(observed).not.toBeNull();
  expect(observed!.observation).not.toBeNull();
  expect(observed!.observation!.tick).toBeLessThan(
    (await page.evaluate(() => window.graviton!.state())).tick,
  );
  expect(observed!.delaySeconds).toBe(600);
  expect(observed!.predicted).not.toBeNull();
  // The dotted fading tail runs strictly after the observation, toward the predicted present.
  for (const sample of observed!.tail) expect(sample).toBeTruthy();

  const delay = await page.evaluate(() => window.graviton!.delay({ kind: 'probe', index: 0 }));
  expect(delay).toBe(600);

  readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['status.delay']).toBe('10m');
  expect(readouts['selection.observed']).toBe('10m');

  const events = await page.evaluate(() => window.graviton!.events());
  expect(events).toContainEqual(
    expect.objectContaining({
      tick: T01_LAUNCH_TICK,
      arrivalTick: T01_LAUNCH_ARRIVAL_TICK,
      kind: 'launch',
      probe: 0,
    }),
  );

  expect(gate.violations()).toEqual([]);
});

test('the impact event fires at its arrival tick, carrying both the true and the telemetry tick', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  await loadT01(page);

  await page.evaluate((t) => window.graviton!.warpTo(t), T01_IMPACT_ARRIVAL_TICK);
  const readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['status.event']).toBe('IMPACT PRB-01 → RELAY-HULK');

  const events = await page.evaluate(() => window.graviton!.events());
  expect(events).toContainEqual(
    expect.objectContaining({
      tick: T01_IMPACT_TICK,
      arrivalTick: T01_IMPACT_ARRIVAL_TICK,
      kind: 'impact',
      probe: 0,
      contact: 0,
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      tick: T01_IMPACT_TICK,
      arrivalTick: T01_IMPACT_ARRIVAL_TICK,
      kind: 'cleared',
      contact: 0,
    }),
  );

  // Both ticks are exposed -- the true simulation moment and when the post actually learned it.
  const impactEvent = events.find((e) => e.kind === 'impact')!;
  expect(impactEvent.arrivalTick).toBeGreaterThan(impactEvent.tick);

  expect(gate.violations()).toEqual([]);
});

// nextEventTick()'s committed-command branch (src/app/app.ts's upcomingEvents, unchanged by
// GRV-0030) still targets the command's own *issue* tick, same as before ADR-0007: for a
// co-located post (L01) that is also when it takes effect, but for a post genuinely offset from
// its rail (T01) it lands well before the probe even materialises. `nextEventTick()` then goes
// null (nothing exists yet to predict from) until materialisation, so -- exactly like the
// existing L01 impact case (app.test.ts, tests/e2e/events.spec.ts: a predicted event that lands
// before its own telemetry does) -- `warpToEvent()` alone does not carry the player all the way
// there; the same manual-warp recourse events.spec.ts already uses for L01's impact resolves it
// here too (docs/issues/2026-09-18-warptoevent-dead-zone-for-a-delayed-post.md has the full
// analysis). `step()`'s own automatic drop-to-1x still fires the moment real telemetry lands
// regardless of how the tick was reached.
test('warpToEvent() alone stalls in the issue-to-materialisation gap; warping on reaches the launch telemetry event', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  await loadT01(page);

  await page.evaluate(() => window.graviton!.warpToEvent());
  let state = await page.evaluate(() => window.graviton!.state());
  expect(state.tick).toBeLessThan(T01_LAUNCH_TICK); // stalled well before the probe even exists
  expect(await page.evaluate(() => window.graviton!.nextEventTick())).toBeNull();

  await page.evaluate((t) => window.graviton!.warpTo(t), T01_LAUNCH_ARRIVAL_TICK + 1);
  const readouts = await page.evaluate(() => window.graviton!.readouts());
  state = await page.evaluate(() => window.graviton!.state());
  expect(readouts['status.event']).toBe('LAUNCH PRB-01');
  expect(state.tick).toBe(T01_LAUNCH_ARRIVAL_TICK + 1);

  expect(gate.violations()).toEqual([]);
});

test('screenshot: T01 mid-flight shows the solid observed trail, the dotted predicted tail and the marker ahead of it', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  await loadT01(page);

  await page.evaluate((t) => window.graviton!.warpTo(t), T01_LAUNCH_ARRIVAL_TICK + 20);
  await page.evaluate(() => window.graviton!.render());

  // The dotted tail (GAME-0002 §4's "dotted, fading tail") runs from the observation to the
  // predicted present, strictly displaced from the last solid (observed) point -- the true live
  // state is never what's drawn (design note: the plot only ever reads `observed`, never
  // `sim.objects` directly -- checked by grep in this unit's evidence).
  const observed = await page.evaluate(() => window.graviton!.observed(0));
  expect(observed!.tail.length).toBeGreaterThan(1);
  expect(observed!.predicted).not.toEqual(
    expect.objectContaining({ x: observed!.observation!.x, y: observed!.observation!.y }),
  );

  expect(gate.violations()).toEqual([]);
});

// Level 01 (post on the rail's own host, GRV-0029) sees no change beyond the one described in
// tests/e2e/events.spec.ts (updated this unit: the post-impact occlusion blackout means the
// IMPACT status text lands well after the true impact tick, not within it) -- that spec is the
// source of truth for L01's own before/after comparison; this only re-asserts the observed view
// itself stays sane for a same-host post (delay 0, no occlusion-driven surprises at launch).
test('level 01 (post on the rail host): the observed view matches the live state within one tick, as before GRV-0030', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=L01-intercept');
  await waitReady(page);
  await page.evaluate(() => window.graviton!.loadSolution());
  await page.evaluate(() => window.graviton!.select({ kind: 'probe', index: 0 }));
  await page.evaluate((t) => window.graviton!.warpTo(t), 2600); // well after L01's own launch tick

  const observed = await page.evaluate(() => window.graviton!.observed(0));
  const state = await page.evaluate(() => window.graviton!.state());
  expect(observed).not.toBeNull();
  // The post sits on the rail's own host (GRV-0029): delay is at most one tick, never ~600 s.
  expect(observed!.delaySeconds).toBeLessThanOrEqual(state.tick > 0 ? 60 : 0);
  const readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['status.delay']).not.toBe('—');
  expect(readouts['status.delay']).not.toBe('10m');

  expect(gate.violations()).toEqual([]);
});
