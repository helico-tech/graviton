// The planner overlay through the real page (GRV-0026, docs/work/GRV-0026-planner-overlay.md's
// own acceptance list, ADR-0004 §1-2): setPlan reproduces a committed solution's own recorded
// outcome through solution(); a real mouse drag off a rail sets the draft's heading/speed; a real
// click on the ghost path places a node and a real drag on its handle changes its prograde;
// commit + warpTo(impact) matches the ghost invariant the same way selection.spec.ts's own
// solution-replay test does; the horizon scrub changes what the plot draws and reverts. Console
// gate with failOnAnyConsoleMessage, matching every other spec in this directory.
//
// Independent verification throughout reuses the simulation directly (createSim/advance/
// railGeometry), exactly as tests/e2e/plot.spec.ts's own contactHostAtEpoch does -- never a second
// model of the geometry or the physics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { advance, createSim } from '../../src/sim/sim.ts';
import type { Command } from '../../src/sim/sim.ts';
import { evaluateEphemeris } from '../../src/sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../../src/sim/ephemeris/bodies.ts';
import { railGeometry } from '../../src/sim/rails.ts';
import { quantizeHeading, quantizeSpeed } from '../../src/levels/solve.ts';
import { worldToScreen } from '../../src/render/camera.ts';
import type { CompiledLevel } from '../../src/levels/compile.ts';
import { attachConsoleGate } from './console-gate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadJson<T>(...parts: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(here, '../..', ...parts), 'utf8')) as T;
}

const l01Solution = loadJson<{ log: Command[] }>('levels', 'L01-intercept.solution.json');
const l01Evidence = loadJson<{ contacts: { impactTick: number }[] }>(
  'levels',
  'L01-intercept.evidence.json',
);
const l01Launch = l01Solution.log[0] as {
  tick: number;
  kind: 'launch';
  rail: number;
  heading: number;
  speed: number;
};

const t00 = loadJson<CompiledLevel>('levels', 'T00-compiler-fixture.level.json');

function makeEph(count: number): EphemerisOut {
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
  };
}

/** A rail's own surface point/velocity at `tick`, computed the same way railGeometry always is --
 *  independent of the debug API, which has no direct rail-geometry accessor. */
function railStateAtTick(
  level: CompiledLevel,
  rail: number,
  tick: number,
): { x: number; y: number; ux: number; uy: number } {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  const eph = makeEph(sim.bodies.count);
  const t = tick * level.scenario.dt;
  evaluateEphemeris(sim.bodies, t, eph);
  const geometry = railGeometry({ bodies: sim.bodies, rails: sim.rails, rail, t, eph });
  return { x: geometry.x, y: geometry.y, ux: geometry.ux, uy: geometry.uy };
}

/** The exact probe state a ghost integrating `plan` would show at `tick` -- a live reference
 *  simulation advanced with the plan's own launch command, matching src/planner/ghost.test.ts's
 *  own "Ghost invariant" proof: the planner's forward integration is the live simulation's code
 *  path, so this and the drawn ghost are bit-identical. */
function referenceProbeAt(
  level: CompiledLevel,
  plan: { rail: number; launchTick: number; heading: number; speed: number },
  tick: number,
): { x: number; y: number; vx: number; vy: number } {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  const log: Command[] = [
    {
      tick: plan.launchTick,
      kind: 'launch',
      rail: plan.rail,
      heading: plan.heading,
      speed: plan.speed,
    },
  ];
  advance({ sim, log, ticks: tick });
  const probeIndex = sim.objects.count - 1;
  return {
    x: sim.objects.x[probeIndex]!,
    y: sim.objects.y[probeIndex]!,
    vx: sim.objects.vx[probeIndex]!,
    vy: sim.objects.vy[probeIndex]!,
  };
}

/** Canvas-local CSS-pixel screen coordinates of a world point, matching
 *  tests/e2e/selection.spec.ts's own clickWorldPoint conversion. */
async function toScreenPoint(
  page: Page,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
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
  return { x: box.x + screen.x / dpr, y: box.y + screen.y / dpr };
}

async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test('setPlan with level 01s committed solution reproduces its own recorded outcome', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.evaluate((plan) => window.graviton!.setPlan(plan), {
    rail: l01Launch.rail,
    launchTick: l01Launch.tick,
    heading: l01Launch.heading,
    speed: l01Launch.speed,
    nodes: [],
  });

  const readout = await page.evaluate(() => window.graviton!.solution());
  expect(readout).not.toBeNull();
  expect(readout!.contacts[0]!.cleared).toBe(true);
  expect(readout!.contacts[0]!.impactTick).toBe(l01Evidence.contacts[0]!.impactTick);

  expect(gate.violations()).toEqual([]);
});

test('commit appends the plan to the log; warping to impact clears the contact and expends the probe', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.evaluate((plan) => window.graviton!.setPlan(plan), {
    rail: l01Launch.rail,
    launchTick: l01Launch.tick,
    heading: l01Launch.heading,
    speed: l01Launch.speed,
    nodes: [],
  });
  await page.evaluate(() => window.graviton!.commitPlan());
  expect(await page.evaluate(() => window.graviton!.plan())).toBeNull();

  const impactTick = l01Evidence.contacts[0]!.impactTick;
  await page.evaluate((tick) => window.graviton!.warpTo(tick + 1), impactTick);

  const state = await page.evaluate(() => window.graviton!.state());
  expect(state.contacts[0]!.cleared).toBe(1);
  expect(state.contacts[0]!.impactTick).toBe(impactTick);
  expect(state.objects[0]!.hitContact).toBe(0);

  expect(gate.violations()).toEqual([]);
});

test('dragging the launch vector off a rail sets the draft heading and speed within the muzzle band', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=T00-compiler-fixture');
  await page.waitForFunction(() => window.graviton?.ready === true);

  // The rail marker itself is drawn at the *current* tick (captureFrame reads sim.tick, never a
  // future one) -- T00's own host spins fast enough (its own compiler-fixture values, not tuned
  // for pacing) that the launch tick's own geometry (nowTick + 1, used internally by
  // updateLaunchDrag) can sit ~1 Mm away from what's actually on screen right now, so the click
  // itself must target tick 0's position, not the drag's own future launch tick.
  const railNow = railStateAtTick(t00, 0, 0);
  await page.evaluate((view) => window.graviton!.setView(view), {
    centreX: railNow.x,
    centreY: railNow.y,
    metresPerPixel: 2000,
  });
  await page.evaluate(() => window.graviton!.render());

  const from = await toScreenPoint(page, railNow);
  const to = { x: from.x + 120, y: from.y - 40 };
  await dragMouse(page, from, to);

  const plan = await page.evaluate(() => window.graviton!.plan());
  expect(plan).not.toBeNull();
  const rail = t00.scenario.rails[0]!;
  expect(plan!.speed).toBeGreaterThanOrEqual(rail.muzzleSpeedMin * 1000);
  expect(plan!.speed).toBeLessThanOrEqual(rail.muzzleSpeedMax * 1000);
  expect(Number.isInteger(plan!.heading)).toBe(true);
  expect(plan!.heading).toBeGreaterThanOrEqual(0);

  expect(gate.violations()).toEqual([]);
});

test('clicking the ghost path places a node; dragging its handle changes its prograde component', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=T00-compiler-fixture');
  await page.waitForFunction(() => window.graviton?.ready === true);

  const launchTick = 1;
  const railState = railStateAtTick(t00, 0, launchTick);
  const headingRad = Math.atan2(railState.uy, railState.ux); // straight along local vertical: well inside any cone
  const rail = t00.scenario.rails[0]!;
  const plan = {
    rail: 0,
    launchTick,
    heading: quantizeHeading(headingRad),
    speed: quantizeSpeed((rail.muzzleSpeedMin + rail.muzzleSpeedMax) / 2),
    nodes: [] as never[],
  };
  await page.evaluate((p) => window.graviton!.setPlan(p), plan);

  const nodeTick = launchTick + 20;
  const sample = referenceProbeAt(t00, plan, nodeTick);
  const metresPerPixel = 500;
  await page.evaluate((view) => window.graviton!.setView(view), {
    centreX: sample.x,
    centreY: sample.y,
    metresPerPixel,
  });
  await page.evaluate(() => window.graviton!.render());

  const nodeScreen = await toScreenPoint(page, sample);
  await page.mouse.click(nodeScreen.x, nodeScreen.y);

  let plan2 = await page.evaluate(() => window.graviton!.plan());
  expect(plan2!.nodes).toHaveLength(1);
  expect(plan2!.nodes[0]!.atTick).toBe(nodeTick);
  expect(plan2!.nodes[0]!.prograde).toBe(1); // addNode's own default, not yet dragged

  const speed = Math.hypot(sample.vx, sample.vy);
  const ux = sample.vx / speed;
  const uy = sample.vy / speed;
  const handleStemPx = 40; // src/render/ghost.ts's own HANDLE_STEM_LENGTH_PX
  const handleWorld = {
    x: sample.x + ux * handleStemPx * metresPerPixel,
    y: sample.y + uy * handleStemPx * metresPerPixel,
  };
  const dragTarget = { x: sample.x + ux * 6000, y: sample.y + uy * 6000 }; // further out, same direction

  const handleScreen = await toScreenPoint(page, handleWorld);
  const targetScreen = await toScreenPoint(page, dragTarget);
  await dragMouse(page, handleScreen, targetScreen);

  plan2 = await page.evaluate(() => window.graviton!.plan());
  expect(plan2!.nodes).toHaveLength(1);
  expect(plan2!.nodes[0]!.prograde).toBeGreaterThan(1);
  expect(plan2!.nodes[0]!.lateral).toBe(0);

  expect(gate.violations()).toEqual([]);
});

test('horizon scrub changes the drawn frame and releasing returns to the present', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/?debug=1&level=T00-compiler-fixture');
  await page.waitForFunction(() => window.graviton?.ready === true);

  await page.evaluate(() => window.graviton!.step(3000)); // enough orbital/rotational motion to differ visually
  await page.evaluate(() => window.graviton!.render());
  const atPresent = await page.evaluate(() => window.graviton!.frameHash());

  await page.evaluate(() => window.graviton!.setHorizon(0));
  await page.evaluate(() => window.graviton!.render());
  const atHorizon = await page.evaluate(() => window.graviton!.frameHash());
  expect(atHorizon).not.toBe(atPresent);

  await page.evaluate(() => window.graviton!.setHorizon(null));
  await page.evaluate(() => window.graviton!.render());
  const backToPresent = await page.evaluate(() => window.graviton!.frameHash());
  expect(backToPresent).toBe(atPresent);

  expect(gate.violations()).toEqual([]);
});
