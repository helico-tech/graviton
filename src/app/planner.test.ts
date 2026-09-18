// Planner state transitions (docs/work/GRV-0026-planner-overlay.md). A small hand-built level (one
// primary, one rail, no contacts) mirrors src/app/app.test.ts's own `scenario()` fixture rather
// than a bundled level, so heading/speed/handle arithmetic can be checked against numbers computed
// independently in the test itself.
import { describe, expect, test } from 'vitest';
import {
  addNode,
  beginLaunchDrag,
  beginNodeDrag,
  createPlannerState,
  discardDraft,
  endDrag,
  reintegrate,
  removeNode,
  selectNode,
  setHorizon,
  setPlan,
  updateLaunchDrag,
  updateNodeDrag,
} from './planner.ts';
import type { PlannerState } from './planner.ts';
import { getLevel } from './levels.ts';
import type { CompiledLevel } from './levels.ts';
import type { Command } from '../sim/sim.ts';
import type { FlightPlan } from '../planner/plan.ts';
import { HEADING_TURN } from '../sim/commands.ts';

const DT = 60;
const MU = 3.986004418e14;
const RADIUS = 6.371e6;
const MUZZLE_MIN = 1000;
const MUZZLE_MAX = 100000;
const CONE = Math.PI / 6; // 30 deg half-angle, so due "east" of the rail is well inside it

function level(overrides: Partial<CompiledLevel['scenario']> = {}): CompiledLevel {
  return {
    schema: 1,
    id: 'test',
    name: 'test',
    brief: '',
    debrief: '',
    seed: 1,
    names: { bodies: [], rails: [], contacts: [] },
    bodyIds: [],
    railIds: [],
    contactIds: [],
    bodyClasses: [],
    scenario: {
      dt: DT,
      capacity: 4,
      burnNodeCapacity: 8, // nodeBudget 2 (8 / 4)
      // rotationPeriod astronomically large so the rail's own spin never measurably perturbs the
      // hand-computed heading/speed numbers these tests check the drag arithmetic against -- the
      // rotation itself (GAME-0001 §4.2) is exercised by the launch-tick snapping tests below,
      // which only check tick numbers, never exact angles.
      bodies: [{ parent: -1, mu: MU, radius: RADIUS, rotationPeriod: 1e20, axialPhaseAtEpoch: 0 }],
      rails: [
        {
          host: 0,
          longitude: 0, // rail sits at world (RADIUS, 0); local vertical is +x
          muzzleSpeedMin: MUZZLE_MIN,
          muzzleSpeedMax: MUZZLE_MAX,
          headingCone: CONE,
          reloadTicks: 0,
        },
      ],
      contacts: [],
      probe: { dryMass: 500, propellantMass: 500, exhaustVelocity: 3000, thrust: 400 },
      streams: [],
      ...overrides,
    },
  };
}

describe('createPlannerState', () => {
  test('starts empty', () => {
    expect(createPlannerState()).toEqual({
      draft: null,
      drag: null,
      horizon: null,
      ghost: null,
      cache: undefined,
      selectedNode: null,
      issues: [],
    });
  });
});

describe('launch drag', () => {
  const lvl = level();

  test('maps drag length logarithmically across the muzzle band, clamped past the reference length', () => {
    let state = createPlannerState();
    state = beginLaunchDrag({ state, rail: 0, worldX: RADIUS, worldY: 0 });

    // Due "east" of the rail (local vertical), at 80 world-px worth of metresPerPixel=1: half the
    // 160px reference length -> the geometric mean of the band.
    state = updateLaunchDrag({
      state,
      level: lvl,
      worldX: RADIUS + 80,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    expect(state.draft!.speed / 1000).toBeCloseTo(Math.sqrt(MUZZLE_MIN * MUZZLE_MAX), 0);

    // At the origin (zero-length drag): the band's floor.
    state = updateLaunchDrag({
      state,
      level: lvl,
      worldX: RADIUS,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    expect(state.draft!.speed).toBe(MUZZLE_MIN * 1000);

    // Past the 160px reference length: clamped at the band's ceiling, never above it.
    state = updateLaunchDrag({
      state,
      level: lvl,
      worldX: RADIUS + 10000,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    expect(state.draft!.speed).toBe(MUZZLE_MAX * 1000);
  });

  test('heading is the quantised absolute angle from the rail, and every field is an integer', () => {
    let state = createPlannerState();
    state = beginLaunchDrag({ state, rail: 0, worldX: RADIUS, worldY: 0 });
    // Straight "north" from the rail's own muzzle point.
    state = updateLaunchDrag({
      state,
      level: lvl,
      worldX: RADIUS,
      worldY: 1000,
      tick: 0,
      metresPerPixel: 1,
    });

    const draft = state.draft!;
    expect(Number.isInteger(draft.heading)).toBe(true);
    expect(Number.isInteger(draft.speed)).toBe(true);
    expect(draft.heading).toBe(Math.round(HEADING_TURN / 4)); // 90 deg
    expect(draft.launchTick).toBe(1); // tick 0 -> launches next tick
  });

  test('a re-drag on the same rail keeps existing nodes; a different rail starts fresh', () => {
    const twoRails = level({
      rails: [...level().scenario.rails, { ...level().scenario.rails[0]!, longitude: Math.PI }],
    });
    let state = createPlannerState();
    state = beginLaunchDrag({ state, rail: 0, worldX: RADIUS, worldY: 0 });
    state = updateLaunchDrag({
      state,
      level: twoRails,
      worldX: RADIUS + 80,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    state = addNode({ state, level: twoRails, tick: 500 });
    expect(state.draft!.nodes).toHaveLength(1);

    state = beginLaunchDrag({ state, rail: 0, worldX: RADIUS, worldY: 0 });
    state = updateLaunchDrag({
      state,
      level: twoRails,
      worldX: RADIUS + 50,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    expect(state.draft!.nodes).toHaveLength(1); // same rail: kept

    state = beginLaunchDrag({ state, rail: 1, worldX: -RADIUS, worldY: 0 });
    state = updateLaunchDrag({
      state,
      level: twoRails,
      worldX: -RADIUS - 50,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    expect(state.draft!.nodes).toHaveLength(0); // different rail: reset
  });

  test('updateLaunchDrag is a no-op without an active launch drag', () => {
    const state = createPlannerState();
    const after = updateLaunchDrag({
      state,
      level: lvl,
      worldX: 0,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    expect(after).toBe(state);
  });

  test('endDrag clears the drag but keeps the draft', () => {
    let state = createPlannerState();
    state = beginLaunchDrag({ state, rail: 0, worldX: RADIUS, worldY: 0 });
    state = updateLaunchDrag({
      state,
      level: lvl,
      worldX: RADIUS + 80,
      worldY: 0,
      tick: 0,
      metresPerPixel: 1,
    });
    const draft = state.draft;
    state = endDrag(state);
    expect(state.drag).toBeNull();
    expect(state.draft).toBe(draft);
  });
});

describe('reintegrate: launch-tick snapping and the ghost invariant', () => {
  const lvl = level();
  const log: Command[] = [];

  function eastPlan(): FlightPlan {
    return { rail: 0, launchTick: 5, heading: 0, speed: 50000 * 1000, nodes: [] };
  }

  test('a plan whose launch tick has not yet arrived launches unchanged', () => {
    let state = createPlannerState();
    state = setPlan({ state, plan: eastPlan() });
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 200 });
    expect(state.draft!.launchTick).toBe(5);
    expect(state.ghost).not.toBeNull();
    expect(state.issues).toEqual([]);
  });

  test('a plan whose launch tick has passed snaps to nowTick + 1', () => {
    let state = createPlannerState();
    state = setPlan({ state, plan: eastPlan() });
    state = reintegrate({ state, level: lvl, log, nowTick: 10, horizonTick: 200 });
    expect(state.draft!.launchTick).toBe(11);
  });

  test('checkLaunch rejects a heading outside the rail cone: no ghost, the reason surfaces', () => {
    let state = createPlannerState();
    // Straight "north" (90 deg) is well outside a 30 deg half-angle cone about "east".
    state = setPlan({
      state,
      plan: {
        rail: 0,
        launchTick: 1,
        heading: Math.round(HEADING_TURN / 4),
        speed: 50000 * 1000,
        nodes: [],
      },
    });
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 200 });
    expect(state.ghost).toBeNull();
    expect(state.issues).toEqual(['launch rejected: cone']);
  });

  test('a null draft reintegrates to a null ghost', () => {
    const state = reintegrate({
      state: createPlannerState(),
      level: lvl,
      log,
      nowTick: 0,
      horizonTick: 200,
    });
    expect(state.ghost).toBeNull();
    expect(state.issues).toEqual([]);
  });

  test('cache reuse: an unrelated second reintegrate of the same plan does no further work', () => {
    let state = createPlannerState();
    state = setPlan({ state, plan: eastPlan() });
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 200 });
    expect(state.ghost!.ticksIntegrated).toBeGreaterThan(0);

    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 200 });
    expect(state.ghost!.ticksIntegrated).toBe(0);
  });

  test('editing a later node resumes from its checkpoint rather than recomputing from launch', () => {
    let state = createPlannerState();
    const plan: FlightPlan = {
      ...eastPlan(),
      nodes: [
        { atTick: 40, prograde: 100, lateral: 0 },
        { atTick: 140, prograde: 100, lateral: 0 },
      ],
    };
    state = setPlan({ state, plan });
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 200 });
    const fullRun = state.ghost!.ticksIntegrated;

    const edited = { ...plan, nodes: [plan.nodes[0]!, { ...plan.nodes[1]!, prograde: 200 }] };
    state = setPlan({ state, plan: edited });
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 200 });

    expect(state.ghost!.ticksIntegrated).toBeGreaterThan(0);
    expect(state.ghost!.ticksIntegrated).toBeLessThan(fullRun);
  });

  test('a draft over the level node budget yields issues and no ghost, never throws (docs/issues/2026-09-18-reintegrate-skips-validate-plan.md)', () => {
    // L01-intercept's own scenario has burnNodeCapacity 0 (capacity 2 -> nodeBudget 0): the exact
    // level the filed bug reproduced against ("pending burn queue capacity 0 exceeded").
    const l01 = getLevel('L01-intercept')!;
    const rail = l01.scenario.rails[0]!;
    let state = createPlannerState();
    state = setPlan({
      state,
      plan: {
        rail: 0,
        launchTick: 1,
        heading: 0,
        speed: rail.muzzleSpeedMin * 1000,
        nodes: [{ atTick: 100, prograde: 1, lateral: 0 }],
      },
    });

    expect(() => {
      state = reintegrate({ state, level: l01, log: [], nowTick: 0, horizonTick: 200 });
    }).not.toThrow();

    expect(state.ghost).toBeNull();
    expect(state.issues).toEqual(['plan has 1 node(s), budget is 0']);
  });

  test('re-dragging the launch past an existing node reports it as an issue instead of silently dropping it (docs/issues/2026-09-18-reintegrate-skips-validate-plan.md)', () => {
    let state = createPlannerState();
    state = setPlan({
      state,
      plan: { ...eastPlan(), nodes: [{ atTick: 50, prograde: 100, lateral: 0 }] },
    });
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 200 });
    expect(state.ghost).not.toBeNull();
    expect(state.issues).toEqual([]);

    // Time passes tick 100, well past the node's own atTick (50); re-dragging the launch snaps it
    // to tick 101, past the node.
    state = beginLaunchDrag({ state, rail: 0, worldX: RADIUS, worldY: 0 });
    state = updateLaunchDrag({
      state,
      level: lvl,
      worldX: RADIUS + 80,
      worldY: 0,
      tick: 100,
      metresPerPixel: 1,
    });
    state = reintegrate({ state, level: lvl, log, nowTick: 100, horizonTick: 200 });

    expect(state.draft!.launchTick).toBe(101);
    expect(state.ghost).toBeNull();
    expect(state.issues).toEqual(['node 0: atTick (50) must be later than launchTick (101)']);
  });
});

describe('nodes', () => {
  const lvl = level();
  const log: Command[] = [];

  function planWithGhost(): PlannerState {
    let state = createPlannerState();
    state = setPlan({
      state,
      plan: { rail: 0, launchTick: 1, heading: 0, speed: 50000 * 1000, nodes: [] },
    });
    return reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 400 });
  }

  test('addNode inserts sorted and selects the new node', () => {
    let state = planWithGhost();
    state = addNode({ state, level: lvl, tick: 200 });
    state = addNode({ state, level: lvl, tick: 100 });
    expect(state.draft!.nodes.map((n) => n.atTick)).toEqual([100, 200]);
    expect(state.selectedNode).toBe(0); // the second add (tick 100) sorts ahead of the first
  });

  test('addNode is a no-op at or before the launch tick', () => {
    const state = planWithGhost();
    const after = addNode({ state, level: lvl, tick: 1 });
    expect(after.draft!.nodes).toHaveLength(0);
  });

  test('addNode respects the level node budget (2, from burnNodeCapacity 8 / capacity 4)', () => {
    let state = planWithGhost();
    state = addNode({ state, level: lvl, tick: 100 });
    state = addNode({ state, level: lvl, tick: 200 });
    state = addNode({ state, level: lvl, tick: 300 });
    expect(state.draft!.nodes).toHaveLength(2);
  });

  test('a prograde handle drag sets prograde in mm/s from the projected drag vector, lateral untouched', () => {
    let state = planWithGhost();
    state = addNode({ state, level: lvl, tick: 200 });
    // Re-integrate so the ghost actually carries a sample at tick 200 (addNode alone only edits
    // the draft; nothing re-ran the integration yet).
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 400 });

    const index = state.draft!.nodes.findIndex((n) => n.atTick === 200);
    const sample = 200 - state.ghost!.fromTick;
    const vx = state.ghost!.samples.vx[sample]!;
    const vy = state.ghost!.samples.vy[sample]!;
    const speed = Math.hypot(vx, vy);
    const ux = vx / speed;
    const uy = vy / speed;
    const nodeX = state.ghost!.samples.x[sample]!;
    const nodeY = state.ghost!.samples.y[sample]!;

    state = beginNodeDrag({ state, index, handle: 'prograde', worldX: nodeX, worldY: nodeY });
    // 60 world-px along the ghost's own velocity direction, metresPerPixel 1 -> 60 world metres of
    // projection; the handle's own reference is 120px per 200 m/s, so 60 world metres -> 100 m/s.
    state = updateNodeDrag({
      state,
      worldX: nodeX + ux * 60,
      worldY: nodeY + uy * 60,
      metresPerPixel: 1,
    });

    const node = state.draft!.nodes[index]!;
    expect(node.prograde).toBe(100 * 1000);
    expect(node.lateral).toBe(0);
  });

  test('dragging a handle exactly to the node position never leaves a (0, 0) burn', () => {
    let state = planWithGhost();
    state = addNode({ state, level: lvl, tick: 200 });
    state = reintegrate({ state, level: lvl, log, nowTick: 0, horizonTick: 400 });

    const index = state.draft!.nodes.findIndex((n) => n.atTick === 200);
    const sample = 200 - state.ghost!.fromTick;
    const nodeX = state.ghost!.samples.x[sample]!;
    const nodeY = state.ghost!.samples.y[sample]!;

    state = beginNodeDrag({ state, index, handle: 'prograde', worldX: nodeX, worldY: nodeY });
    state = updateNodeDrag({ state, worldX: nodeX, worldY: nodeY, metresPerPixel: 1 });

    const node = state.draft!.nodes[index]!;
    expect(node.prograde === 0 && node.lateral === 0).toBe(false);
  });

  test('updateNodeDrag without a ghost sample at the node tick is a no-op', () => {
    // No reintegrate call at all: state.ghost stays null, so there is nothing to project the drag
    // vector onto yet.
    let state = createPlannerState();
    state = setPlan({
      state,
      plan: { rail: 0, launchTick: 1, heading: 0, speed: 50000 * 1000, nodes: [] },
    });
    state = addNode({ state, level: lvl, tick: 200 });
    const index = state.draft!.nodes.findIndex((n) => n.atTick === 200);
    state = beginNodeDrag({ state, index, handle: 'prograde', worldX: 0, worldY: 0 });
    const before = state.draft;
    state = updateNodeDrag({ state, worldX: 10, worldY: 10, metresPerPixel: 1 });
    expect(state.draft).toBe(before);
  });

  test('removeNode drops the node and shifts a later selection/drag index down', () => {
    let state = planWithGhost();
    state = addNode({ state, level: lvl, tick: 100 });
    state = addNode({ state, level: lvl, tick: 200 });
    state = selectNode({ state, index: 1 }); // the tick-200 node

    state = removeNode({ state, index: 0 }); // remove the tick-100 node
    expect(state.draft!.nodes.map((n) => n.atTick)).toEqual([200]);
    expect(state.selectedNode).toBe(0);
  });

  test('removeNode of the selected node clears the selection', () => {
    let state = planWithGhost();
    state = addNode({ state, level: lvl, tick: 100 }); // selects index 0
    state = removeNode({ state, index: 0 });
    expect(state.draft!.nodes).toHaveLength(0);
    expect(state.selectedNode).toBeNull();
  });
});

describe('setHorizon and discardDraft', () => {
  test('setHorizon round-trips, including back to null', () => {
    let state = createPlannerState();
    state = setHorizon({ state, tick: 42 });
    expect(state.horizon).toBe(42);
    state = setHorizon({ state, tick: null });
    expect(state.horizon).toBeNull();
  });

  test('discardDraft clears everything the draft touched, not the horizon', () => {
    let state = createPlannerState();
    state = setHorizon({ state, tick: 7 });
    state = setPlan({
      state,
      plan: { rail: 0, launchTick: 1, heading: 0, speed: 1000, nodes: [] },
    });
    state = discardDraft(state);
    expect(state).toEqual({
      draft: null,
      drag: null,
      horizon: 7,
      ghost: null,
      cache: undefined,
      selectedNode: null,
      issues: [],
    });
  });
});
