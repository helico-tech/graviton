// App bootstrap (GRV-0021, GRV-0022): builds the four-region shell (GAME-0002 §8), loads the level
// named in the URL, wires the warp ladder to the keyboard and the plot's camera to wheel/drag,
// and drives the fixed-step loop outside debug mode. `?debug=1` installs window.graviton instead
// of animating (ADR-0004 §1).
import './styles.css';
import { createApp } from './app.ts';
import type { App } from './app.ts';
import { installDebugApi } from './debug-api.ts';
import type { DebugApiDriver } from './debug-api.ts';
import { effectiveTicksThisFrame, warpEaseFrame } from './loop.ts';
import { parseSelectionParam, pickAt } from './selection.ts';
import { ticksPerFrame } from './warp.ts';
import {
  clearPlot,
  createPlotController,
  createPlotRegion,
  hideBrief,
  hidePlotError,
  showBrief,
  showPlotError,
} from '../ui/plot.ts';
import type { PlotController } from '../ui/plot.ts';
import { createPlannerPanel, renderPlanner } from '../ui/planner.ts';
import { createSelectionPanel, renderSelection } from '../ui/selection.ts';
import { createSolutionPanel, renderSolution } from '../ui/solution.ts';
import { createStatusBar, renderStatus } from '../ui/status.ts';
import { attachTimelineScrub, createTimelineStrip, renderTimeline } from '../ui/timeline.ts';
import { buildPlannerFrame } from '../render/ghost.ts';
import type { PlannerFrame } from '../render/ghost.ts';

declare const __BUILD_SHA__: string;

// Generous relative to the ~4-8 px markers themselves (GRV-0022's marker radii): a click needs to
// land near a thing, not exactly on its centre pixel.
const SELECT_RADIUS_PX = 12;

// Planner pick radii (GRV-0026 design note): a rail marker and a ghost node both get the same
// generous radius selection already uses; a handle's own grab target is slightly smaller (it sits
// right next to its node, GRV-0022's marker-radii reasoning again); the ghost path itself uses the
// design note's own literal "within 4 px".
const RAIL_DRAG_PICK_RADIUS_PX = 12;
const NODE_PICK_RADIUS_PX = 8;
const HANDLE_PICK_RADIUS_PX = 8;
const PATH_PICK_RADIUS_PX = 4;

const params = new URLSearchParams(window.location.search);
const debug = params.get('debug') === '1';
const levelId = params.get('level') ?? 'L01-intercept';
const tickParam = params.get('tick');
const warpParam = params.get('warp');
const widthParam = params.get('w');
const heightParam = params.get('h');
const zoomParam = params.get('zoom');
const cxParam = params.get('cx');
const cyParam = params.get('cy');
const solutionParam = params.get('solution');
const selectParam = params.get('select');

const root = document.getElementById('app');
if (!root) throw new Error('main: #app is missing from index.html');
root.replaceChildren();
root.className = 'shell';

const status = createStatusBar({ buildSha: __BUILD_SHA__ });
const plot = createPlotRegion();
const selectionPanel = createSelectionPanel();
const plannerPanel = createPlannerPanel();
const solutionPanel = createSolutionPanel();
const timelineStrip = createTimelineStrip();

// SELECTION, PLAN and SOLUTION all stack in the shell's right column (GAME-0002 §8's own mockup
// order); `.right-column` alone carries `grid-area: selection`, so the three panels themselves
// stay plain, unpositioned blocks (src/app/styles.css).
const rightColumn = document.createElement('div');
rightColumn.className = 'right-column';
rightColumn.append(selectionPanel.element, plannerPanel.element, solutionPanel.element);

root.append(status.element, plot.element, rightColumn, timelineStrip.element);

let showingError = false;

function renderSelectionAndTimeline(): void {
  renderSelection(selectionPanel, {
    hasSelection: app.selection() !== null,
    name: app.selectionName(),
    rows: app.selectionReadouts(),
  });
  // app.frame() throws with nothing loaded (the unknown-level error state, shell.spec.ts) -- the
  // PLAN/SOLUTION panels have nothing to show there anyway, same as the plot itself.
  if (!showingError) {
    const plan = app.plan();
    const dt = app.frame().dt; // Frame.dt is the level's own scenario.dt, no separate App getter
    renderPlanner(plannerPanel, {
      plan,
      railName: (plan && app.frame().rails[plan.rail]?.name) || '',
      dt,
      issues: app.planIssues(),
    });
    renderSolution(solutionPanel, { readout: app.planSolution(), dt });
  }
  const timeline = app.timelineData();
  if (timeline) renderTimeline(timelineStrip, timeline);
}

// `onChange` references `plotController`, declared below -- fine, since `onChange` only ever
// runs once `app.loadLevel`/`step` are called further down this file, well after
// `plotController` is assigned.
const app: App = createApp({
  onChange: ({ status: values, plotError, brief, justLoaded }) => {
    renderStatus(status, values);
    if (justLoaded) plotController.resetView();
    showingError = plotError !== null;
    if (plotError) {
      showPlotError(plot, plotError);
      clearPlot(plot);
    } else {
      hidePlotError(plot);
      plotController.render();
    }
    if (brief) showBrief(plot, brief);
    else hideBrief(plot);
    renderSelectionAndTimeline();
  },
});

// Referenced by `onSelect` before it's assigned -- safe for the same reason `onChange` above can
// reference `plotController`: nothing calls it until user input or the debug API fires, well after
// this module finishes evaluating.
function onCanvasSelect({ screenX, screenY }: { screenX: number; screenY: number }): void {
  const result = pickAt({
    frame: app.frame(),
    view: plotController.getView(),
    canvasWidth: plot.canvas.width,
    canvasHeight: plot.canvas.height,
    screenX,
    screenY,
    radiusPx: SELECT_RADIUS_PX,
  });
  app.select(result);
}

plannerPanel.commit.addEventListener('click', () => app.commitPlan());
plannerPanel.discard.addEventListener('click', () => app.discardDraft());

// The planner overlay's own render data (src/render/ghost.ts), rebuilt on demand from the app's
// plan/ghost/selection state -- read both by plotController's render() (below) and by the
// pointer-down hit test, so the two never see different geometry for the same frame.
function getPlannerFrame(): PlannerFrame | null {
  const plan = app.plan();
  if (!plan) return null;
  const drag = app.drag();
  let launchOrigin: { x: number; y: number } | null = null;
  if (drag?.kind === 'launch') {
    const rail = app.frame().rails[plan.rail];
    if (rail) launchOrigin = { x: rail.x, y: rail.y };
  }
  return buildPlannerFrame({
    plan,
    ghost: app.ghost(),
    selectedNode: app.selectedNode(),
    launchOrigin,
    view: plotController.getView(),
  });
}

// Priority order mirrors the design note literally: a selected node's own handle first (the most
// specific target), then a rail marker (always starts a launch drag -- rails are no longer
// selectable by click once the planner overlay is live), then any ghost node, then the ghost path
// itself; falling through to `false` lets plot.ts run its ordinary select-or-pan flow.
function onPlannerPointerDown({ worldX, worldY }: { worldX: number; worldY: number }): boolean {
  const metresPerPixel = plotController.getView().metresPerPixel;
  const worldRadius = (px: number): number => px * metresPerPixel;
  const within = (x: number, y: number, px: number): boolean =>
    Math.hypot(worldX - x, worldY - y) <= worldRadius(px);

  const frame = getPlannerFrame();
  const selected = app.selectedNode();
  if (frame?.handle && selected !== null) {
    const handle = frame.handle;
    if (within(handle.progradeX, handle.progradeY, HANDLE_PICK_RADIUS_PX)) {
      app.beginNodeDrag({ index: selected, handle: 'prograde', worldX, worldY });
      return true;
    }
    if (within(handle.lateralX, handle.lateralY, HANDLE_PICK_RADIUS_PX)) {
      app.beginNodeDrag({ index: selected, handle: 'lateral', worldX, worldY });
      return true;
    }
  }

  const rails = app.frame().rails;
  for (let i = 0; i < rails.length; i++) {
    const rail = rails[i]!;
    if (within(rail.x, rail.y, RAIL_DRAG_PICK_RADIUS_PX)) {
      app.beginLaunchDrag({ rail: i, worldX, worldY });
      return true;
    }
  }

  if (frame) {
    for (const node of frame.nodes) {
      if (within(node.x, node.y, NODE_PICK_RADIUS_PX)) {
        app.selectNode(node.index);
        app.beginNodeDrag({ index: node.index, handle: 'prograde', worldX, worldY });
        return true;
      }
    }

    let nearest: { distance: number; tick: number } | null = null;
    for (const point of frame.path) {
      const distance = Math.hypot(worldX - point.x, worldY - point.y);
      if (nearest === null || distance < nearest.distance) nearest = { distance, tick: point.tick };
    }
    if (nearest && nearest.distance <= worldRadius(PATH_PICK_RADIUS_PX)) {
      app.addNode({ tick: nearest.tick });
      return true;
    }
  }

  return false;
}

function onPlannerPointerDrag({ worldX, worldY }: { worldX: number; worldY: number }): void {
  const metresPerPixel = plotController.getView().metresPerPixel;
  const drag = app.drag();
  if (drag?.kind === 'launch') app.updateLaunchDrag({ worldX, worldY, metresPerPixel });
  else if (drag?.kind === 'node') app.updateNodeDrag({ worldX, worldY, metresPerPixel });
}

function onPlannerPointerRelease(): void {
  app.endDrag();
}

const plotController: PlotController = createPlotController({
  refs: plot,
  getFrame: () => app.frame(),
  getTrails: () => app.trails(),
  getPredictedTails: () => app.predictedTails(),
  getSelection: () => app.selection(),
  getPlanner: getPlannerFrame,
  onSelect: onCanvasSelect,
  onPlannerDown: onPlannerPointerDown,
  onPlannerDrag: onPlannerPointerDrag,
  onPlannerRelease: onPlannerPointerRelease,
});
plotController.attachInput();
attachTimelineScrub(timelineStrip, {
  canScrub: () => app.warpRung() === 0,
  rangeTicks: () => app.timelineData()?.rangeTicks ?? 1,
  onScrub: (tick) => app.setHorizon(tick),
});

// ?w=&h= size the plot canvas directly rather than from its DOM box, so a shot is reproducible
// independent of the browser window (ADR-0004 §1).
if (widthParam !== null && heightParam !== null) {
  plotController.setCanvasSize({ width: Number(widthParam), height: Number(heightParam) });
}

app.loadLevel(levelId);
// ?solution=1 replays the level's committed solution (GRV-0023) -- applied before ?tick=/?warp=
// so a warp past the launch tick actually flies it, the same way loadSolution() + warpTo() does
// from the debug API.
if (solutionParam === '1') app.loadSolution();
// ?tick=<n> reproduces a shot at a given moment, then pauses; ?warp=<rung> sets the rung for the
// shot directly, overriding the pause a bare ?tick would otherwise leave behind (ADR-0004 §1).
if (tickParam !== null) app.warpTo(Number(tickParam));
if (warpParam !== null) app.setWarp(Number(warpParam));
else if (tickParam !== null) app.setWarp(0);

// ?zoom=<metres per pixel>&cx=<>&cy=<> reproduce a specific view; each is independently optional.
if (zoomParam !== null || cxParam !== null || cyParam !== null) {
  plotController.setView({
    ...(zoomParam !== null ? { metresPerPixel: Number(zoomParam) } : {}),
    ...(cxParam !== null ? { centreX: Number(cxParam) } : {}),
    ...(cyParam !== null ? { centreY: Number(cyParam) } : {}),
  });
  if (!showingError) plotController.render();
}

// ?select=<kind>:<index> reproduces a hero frame with something already selected (ADR-0004 §1).
if (selectParam !== null) app.select(parseSelectionParam(selectParam));

window.addEventListener('resize', () => {
  if (showingError) clearPlot(plot);
  else plotController.render();
});

// The warp change ease (GAME-0002 §9): only the displayed WARP label tweens over ~150 ms, driven
// entirely by this rAF loop -- disabled in debug mode simply because that loop never starts
// there, so the label is always exactly correct and synchronous (loop.ts's warpEaseFrame).
let warpAnim: { from: number; to: number; start: number } | null = null;

function changeWarp(mutate: () => void): void {
  const from = ticksPerFrame(app.warpRung());
  mutate(); // sets the final, correct warp text immediately (app's own synchronous render)
  const to = ticksPerFrame(app.warpRung());
  if (!debug && from !== to) warpAnim = { from, to, start: performance.now() };
}

// Automatic drop to 1x (GRV-0027, GAME-0002 §9): a single inverted status-bar frame, never a
// transition -- `app.takePendingInvert()` is true exactly once per landed drop, so calling this
// once per rendered frame (the real rAF loop below, and the debug API's own `render()`) adds the
// class for exactly the frame right after the drop and removes it on the very next one. Returns
// whether a drop just landed, so the rAF loop below can cancel any in-flight *manual* warp ease --
// an automatic drop is never eased, and without this an old ease already chasing a stale target
// (say, the top rung after `.`) would keep overwriting the label with its own stale intermediate
// value for the rest of its 150 ms, fighting the drop's already-correct synchronous write.
function applyInvertToggle(): boolean {
  const dropped = app.takePendingInvert();
  if (dropped) status.element.classList.add('status-bar--invert');
  else status.element.classList.remove('status-bar--invert');
  return dropped;
}

window.addEventListener('keydown', (event) => {
  if (event.key === ' ') {
    event.preventDefault();
    changeWarp(() => app.togglePause());
  } else if (event.key === '[') {
    changeWarp(() => app.stepWarpRung(-1));
  } else if (event.key === ']') {
    changeWarp(() => app.stepWarpRung(1));
  } else if (event.key === '.') {
    // Jumps to the top rung immediately (eased, like the manual warp keys above); the arrival
    // itself is announced by the automatic drop's own inverted frame, not eased (GRV-0027).
    changeWarp(() => app.warpToEvent());
  } else if (event.key === 'Delete') {
    const selected = app.selectedNode();
    if (selected !== null) app.removeNode({ index: selected });
  } else if (event.key === 'Enter') {
    if (app.plan() && app.planIssues().length === 0) app.commitPlan();
  } else if (event.key === 'Escape') {
    if (app.plan()) app.discardDraft();
  }
});

if (!debug) {
  const frame = (now: number): void => {
    const ticks = effectiveTicksThisFrame(app.warpRung());
    if (ticks > 0) app.step(ticks); // step's onChange already re-renders the plot
    if (applyInvertToggle()) warpAnim = null; // the drop's own write wins, not a stale ease

    if (warpAnim) {
      // docs/issues/2026-09-18-warp-label-sticks-on-eased-value.md: write every animated frame,
      // including the one that finishes the ease -- real frame spacing never guarantees one lands
      // inside the eased window, and warpEaseFrame's `finished` is only ever true alongside the
      // exact target value, never a stale rounded fraction.
      const elapsed = now - warpAnim.start;
      const frame = warpEaseFrame({ from: warpAnim.from, to: warpAnim.to, elapsedMs: elapsed });
      status.warp.textContent = `${Math.round(frame.value)}x`;
      if (frame.finished) warpAnim = null;
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const driver: DebugApiDriver = {
  loadLevel: (id) => app.loadLevel(id),
  load: (args) => app.load(args),
  command: (cmd) => app.command(cmd),
  step: (ticks) => app.step(ticks),
  warpTo: (tick) => app.warpTo(tick),
  setWarp: (rung) => app.setWarp(rung),
  hash: () => app.hash(),
  state: () => app.state(),
  run: (args) => app.run(args),
  events: () => app.events(),
  nextEventTick: () => app.nextEventTick(),
  // Synchronous (design note: "advances to the target in one call -- that is fine there"): debug
  // mode never starts the rAF loop above, so nothing else would drain an armed warpToEvent target
  // a frame's own budget at a time -- this loop does that itself, all within one call.
  warpToEvent: () => {
    app.warpToEvent();
    let guard = 0;
    while (app.warpTargetTick() !== null) {
      app.step(effectiveTicksThisFrame(app.warpRung()));
      if (++guard > 100_000) throw new Error('debug warpToEvent: exceeded guard iterations');
    }
  },
  render: () => {
    plotController.render();
    applyInvertToggle();
  },
  frameHash: () => plotController.frameHash(),
  view: () => plotController.getView(),
  setView: (patch) => plotController.setView(patch),
  select: (sel) => app.select(sel),
  selection: () => app.selection(),
  loadSolution: () => app.loadSolution(),
  plan: () => app.plan(),
  setPlan: (plan) => app.setPlan(plan),
  commitPlan: () => app.commitPlan(),
  setHorizon: (tick) => app.setHorizon(tick),
  planSolution: () => app.planSolution(),
  observed: (index) => app.observed(index),
  delay: (selection) => app.delay(selection),
};
installDebugApi(driver);
