// Command horizon, locked nodes and amendments (GRV-0031, GAME-0001 §4.4/§4.6, GAME-0002 §4/§7/
// §8/§11, ADR-0007 §2-3): a draft's own PLAN-panel readouts, warpToEvent()'s dead zone finally
// closed end to end, and amending a flying probe's plan through the real page -- a locked node the
// simulation itself refuses, a new one past the horizon that commits and replays exactly like the
// ghost showed. Console gate with failOnAnyConsoleMessage, matching every other spec in this
// directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Command, Scenario } from '../../src/sim/sim.ts';
import { attachConsoleGate } from './console-gate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadJson<T>(...parts: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(here, '../..', ...parts), 'utf8')) as T;
}

interface LaunchCommand {
  tick: number;
  kind: 'launch';
  rail: number;
  heading: number;
  speed: number;
}

const t01Solution = loadJson<{ log: Command[] }>('levels', 'T01-far-post.solution.json');
const t01Launch = t01Solution.log[0] as LaunchCommand;
// docs/evidence/GRV-0030/README.md's own derivation, reused by tests/e2e/telemetry.spec.ts: issued
// at 5724, materialises (arrives) at 5744 -- ~20 ticks (10 light-minutes / 30 s dt) each way.
const T01_ISSUE_TICK = 5724;
const T01_MATERIALISE_TICK = 5744;
const t01Evidence = loadJson<{ contacts: { impactTick: number }[] }>(
  'levels',
  'T01-far-post.evidence.json',
);
const T01_IMPACT_TICK = t01Evidence.contacts[0]!.impactTick;

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.graviton?.ready === true);
}

test('draft command horizon: the PLAN panel shows issue/arrival ticks ~20 apart, matching the sim’s own delay (T01)', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=T01-far-post');
  await waitReady(page);

  // The committed solution's own launch, redrafted rather than loaded (setPlan, not
  // loadSolution()) -- issueTickFor/uplinkArrival re-derive the identical 5724/5744 pair
  // (planToCommands's own solve, GRV-0029), proving the PLAN panel's readouts and the debug API's
  // own horizon() agree with what the real committed solution already uses.
  await page.evaluate(
    ({ launch, launchTick }) =>
      window.graviton!.setPlan({
        rail: launch.rail,
        launchTick,
        heading: launch.heading,
        speed: launch.speed,
        nodes: [],
      }),
    { launch: t01Launch, launchTick: T01_MATERIALISE_TICK },
  );

  const horizon = await page.evaluate(() => window.graviton!.horizon());
  expect(horizon).toEqual({
    issueTick: T01_ISSUE_TICK,
    arrivalTick: T01_MATERIALISE_TICK,
    commandHorizonTick: T01_MATERIALISE_TICK,
  });
  expect(horizon!.arrivalTick - horizon!.issueTick).toBeGreaterThanOrEqual(19);
  expect(horizon!.arrivalTick - horizon!.issueTick).toBeLessThanOrEqual(21);

  const readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['plan.issueTick']).toContain('T+');
  expect(readouts['plan.arrivalTick']).toContain('T+');
  expect(readouts['plan.commandHorizonTick']).toContain('T+');
  expect(readouts['plan.issueTick']).not.toBe(readouts['plan.arrivalTick']);

  expect(gate.violations()).toEqual([]);
});

// GRV-0031's own resolution of docs/issues/2026-09-18-warptoevent-dead-zone-for-a-delayed-post.md
// (tests/e2e/telemetry.spec.ts has the exhaustive tick-by-tick version): after committing, three
// warpToEvent() presses in a row make real progress every time -- nextEventTick() is never null in
// between -- reaching issue, then materialisation, then the predicted impact's own downlink
// confirmation, exactly the sequence this unit was asked to prove.
test('commit, then warpToEvent(): the dead zone between issue and materialisation is gone (T01)', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=T01-far-post');
  await waitReady(page);
  await page.evaluate(() => window.graviton!.loadSolution()); // commits planToCommands's own output

  const ticks: number[] = [];
  for (let i = 0; i < 3; i++) {
    const next = await page.evaluate(() => window.graviton!.nextEventTick());
    expect(next).not.toBeNull(); // the dead zone: this used to go null on the second iteration
    await page.evaluate(() => window.graviton!.warpToEvent());
    ticks.push((await page.evaluate(() => window.graviton!.state())).tick);
  }

  expect(ticks[0]).toBe(T01_ISSUE_TICK + 1);
  expect(ticks[1]).toBe(T01_MATERIALISE_TICK + 1);
  expect(ticks[2]).toBeGreaterThan(T01_MATERIALISE_TICK + 1);
  expect(ticks[2]).toBeLessThanOrEqual(T01_IMPACT_TICK + 40); // well inside the confirmation window

  expect(gate.violations()).toEqual([]);
});

// A post genuinely offset from its rail, mirroring src/app/planner.test.ts's/app.test.ts's own
// farLevel/farScenario fixture exactly (their own comments carry the full derivation) -- built by
// hand here, not loaded from a level, so a command horizon of a clean, wide ~20 ticks is available
// immediately rather than searching a bundled level for one (flyby-burn's own real geometry turns
// out to carry only ~1 tick of delay throughout, too narrow to demonstrate a locked node cleanly).
// Launched at tick 0, the probe materialises at tick 21; at tick 100 an order sent right now
// arrives at tick 120 -- confirmed directly, and by src/app/app.test.ts's own identical fixture.
function farScenario(): Scenario {
  const C = 299792458;
  return {
    dt: 30,
    capacity: 4,
    burnNodeCapacity: 8,
    bodies: [
      {
        parent: -1,
        mu: 3.986004418e14,
        radius: 6.371e6,
        rotationPeriod: 1e20,
        axialPhaseAtEpoch: 0,
      },
      {
        parent: 0,
        mu: 1,
        radius: 1e6,
        rotationPeriod: 1e20,
        axialPhaseAtEpoch: 0,
        a: 10 * 60 * C,
        e: 0,
        argPeriapsis: 0,
        meanAnomaly0: 0,
      },
    ],
    rails: [
      {
        host: 1,
        longitude: Math.PI,
        muzzleSpeedMin: 1000,
        muzzleSpeedMax: 100000,
        headingCone: Math.PI / 6,
        reloadTicks: 0,
      },
    ],
    contacts: [],
    post: { host: 0, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
    streams: [],
  };
}

// heading = quantizeHeading(Math.PI), speed = quantizeSpeed(50000) -- src/levels/solve.ts's own
// quantisers, pre-computed here so the spec stays free of a src/levels import.
const FAR_LAUNCH: LaunchCommand = {
  tick: 0,
  kind: 'launch',
  rail: 0,
  heading: 2147483648,
  speed: 50000000,
};
const FAR_NOW_TICK = 100;
const FAR_COMMAND_HORIZON_TICK = 120;
const FAR_EXISTING_NODE = { atTick: 110, prograde: 2000000, lateral: 0 };

test('amendment: a locked node refuses commitPlan(); a new node past the horizon commits and the live replay matches exactly', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await waitReady(page);
  await page.evaluate((scenario) => window.graviton!.load({ scenario, seed: 1 }), farScenario());
  await page.evaluate((launch) => window.graviton!.command(launch), FAR_LAUNCH);
  await page.evaluate(
    (node) => window.graviton!.command({ tick: 0, kind: 'burn', probe: 0, ...node }),
    FAR_EXISTING_NODE,
  );
  await page.evaluate((t) => window.graviton!.warpTo(t), FAR_NOW_TICK);

  const began = await page.evaluate(() => window.graviton!.amend(0));
  expect(began).toBe(true);
  const horizon = await page.evaluate(() => window.graviton!.horizon());
  expect(horizon!.commandHorizonTick).toBe(FAR_COMMAND_HORIZON_TICK);

  const plan = await page.evaluate(() => window.graviton!.plan());
  expect(plan!.nodes).toEqual([FAR_EXISTING_NODE]); // the existing, still-ahead node -- locked

  // "commitPlan() refuses to move it": setPlan is mode-preserving (GRV-0031, src/app/planner.ts),
  // so this stays in amend mode while tampering with the locked node's own values -- checkBurn
  // (sim/commands.ts, the simulation's own last line of defence) rejects it as 'locked' the moment
  // commitPlan actually tries to send it, exactly as it would a live command issued too late.
  await page.evaluate(
    (node) => window.graviton!.setPlan({ ...window.graviton!.plan()!, nodes: [node] }),
    { ...FAR_EXISTING_NODE, prograde: FAR_EXISTING_NODE.prograde + 1 },
  );
  const refused = await page.evaluate(() => window.graviton!.commitPlan());
  expect(refused.committed).toBe(false);
  if (!refused.committed) expect(refused.issues[0]).toContain('locked');
  expect(await page.evaluate(() => window.graviton!.plan())).not.toBeNull(); // kept, not discarded

  // Re-open amendment (the failed commit above never touched the log) and add a genuinely new
  // node past the horizon instead.
  await page.evaluate(() => window.graviton!.amend(0));
  const newNode = { atTick: 140, prograde: 3000000, lateral: -500000 };
  await page.evaluate(
    (node) =>
      window.graviton!.setPlan({
        ...window.graviton!.plan()!,
        nodes: [...window.graviton!.plan()!.nodes, node],
      }),
    newNode,
  );
  const readoutsBeforeCommit = await page.evaluate(() => window.graviton!.readouts());
  expect(readoutsBeforeCommit['plan.issue']).toBe(''); // no shape/launch issue blocking commit

  const committed = await page.evaluate(() => window.graviton!.commitPlan());
  expect(committed).toEqual({ committed: true });
  expect(await page.evaluate(() => window.graviton!.plan())).toBeNull();

  await page.evaluate((t) => window.graviton!.warpTo(t), 150);
  const state = await page.evaluate(() => window.graviton!.state());

  // Independent reference: the exact same three commands (launch, the original node, the
  // amendment's own new node issued at FAR_NOW_TICK) replayed on a fresh Sim -- never a second
  // model of the physics, the same cross-check style tests/e2e/planner.spec.ts's own
  // referenceProbeAt uses.
  const reference = await page.evaluate(
    ({ scenario, log, ticks }) => window.graviton!.run({ scenario, seed: 1, log, ticks }),
    {
      scenario: farScenario(),
      log: [
        FAR_LAUNCH,
        { tick: 0, kind: 'burn' as const, probe: 0, ...FAR_EXISTING_NODE },
        { tick: FAR_NOW_TICK, kind: 'burn' as const, probe: 0, ...newNode },
      ],
      ticks: 150,
    },
  );
  const liveHash = await page.evaluate(() => window.graviton!.hash());
  expect(state.tick).toBe(150);
  expect(liveHash).toBe(reference.hash);

  expect(gate.violations()).toEqual([]);
});

// docs/evidence/GRV-0031/*.png: real PNGs, saved directly by these two tests rather than a
// separate `pnpm screenshot` pass -- that tool only ever visits a URL, and reaching amend mode
// (there is no `?amend=` param, and none of the bundled levels have room to demonstrate both a
// locked and an editable node under their own committed solutions) or a raw-scenario selection
// (no bundled level carries flyby-burn's own real occlusion geometry) both need the debug API
// calls these specs already make. Both are still gated by the same console-gate every other
// screenshot in this repo uses (ADR-0004 §4).
const EVIDENCE_DIR = path.join(here, '../../docs/evidence/GRV-0031');

test('screenshot: amendment shows a locked node and an editable one together', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await waitReady(page);
  await page.evaluate((scenario) => window.graviton!.load({ scenario, seed: 1 }), farScenario());
  await page.evaluate((launch) => window.graviton!.command(launch), FAR_LAUNCH);
  await page.evaluate(
    (node) => window.graviton!.command({ tick: 0, kind: 'burn', probe: 0, ...node }),
    FAR_EXISTING_NODE, // atTick 110 -- locked once nowTick reaches 100 (horizon 120)
  );
  const editableNode = { atTick: 500, prograde: 1000000, lateral: 0 };
  await page.evaluate(
    (node) => window.graviton!.command({ tick: 0, kind: 'burn', probe: 0, ...node }),
    editableNode, // atTick 500 -- well past the horizon, editable
  );
  await page.evaluate((t) => window.graviton!.warpTo(t), FAR_NOW_TICK);
  await page.evaluate(() => window.graviton!.select({ kind: 'probe', index: 0 }));
  await page.evaluate(() => window.graviton!.amend(0));

  const plan = await page.evaluate(() => window.graviton!.plan());
  expect(plan!.nodes).toEqual([FAR_EXISTING_NODE, editableNode]);
  const horizon = await page.evaluate(() => window.graviton!.horizon());
  expect(FAR_EXISTING_NODE.atTick).toBeLessThan(horizon!.commandHorizonTick); // locked
  expect(editableNode.atTick).toBeGreaterThanOrEqual(horizon!.commandHorizonTick); // editable

  // Centred on the ghost path's own span from now (tick 100) to just past the editable node
  // (tick 500) -- confirmed directly against the probe's own true positions at those ticks so the
  // shot actually frames the two nodes rather than an empty stretch of vacuum.
  await page.evaluate((view) => window.graviton!.setView(view), {
    centreX: 1.7944e11,
    centreY: 4e5,
    metresPerPixel: 1e6,
  });
  await page.evaluate(() => window.graviton!.render());
  expect(await page.evaluate(() => window.graviton!.frameHash())).not.toBe('');

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'amendment-locked-editable.png') });

  expect(gate.violations()).toEqual([]);
});

// flyby-burn's real, already-known occlusion stretch (2278-4403 at this scenario's dt=60,
// confirmed directly against segmentBlocked before writing this test), read off the selected (not
// drafted or amended) probe's own predicted flight -- the timeline strip is plain DOM (src/ui/
// timeline.ts), not part of the canvas render()/frameHash(), so a full-page screenshot is what
// actually shows the band, not a canvas-only one.
test('screenshot: the timeline’s uplink band shows a real occlusion window for the selected probe (flyby-burn)', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  const golden = loadJson<{ scenario: Scenario; seed: number; log: Command[] }>(
    'tests',
    'golden',
    'flyby-burn.json',
  );

  await page.goto('/?debug=1');
  await waitReady(page);
  await page.evaluate(
    (args) => window.graviton!.load({ scenario: args.scenario, seed: args.seed }),
    golden,
  );
  for (const command of golden.log) {
    await page.evaluate((cmd) => window.graviton!.command(cmd), command);
  }
  await page.evaluate(() => window.graviton!.select({ kind: 'probe', index: 0 }));

  const windows = await page.evaluate(() => window.graviton!.uplinkWindows());
  expect(windows.length).toBeGreaterThan(0);
  expect(windows.some((w) => w.startTick <= 2278 && w.endTick >= 2278)).toBe(true);

  const readouts = await page.evaluate(() => window.graviton!.readouts());
  expect(readouts['timeline.uplink']).toContain('BLOCKED');

  await page.evaluate(() => window.graviton!.render());
  expect(await page.evaluate(() => window.graviton!.frameHash())).not.toBe('');

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'uplink-band.png'), fullPage: true });

  expect(gate.violations()).toEqual([]);
});
