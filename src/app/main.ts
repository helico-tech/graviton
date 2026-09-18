// App bootstrap (GRV-0021, GRV-0022): builds the four-region shell (GAME-0002 §8), loads the level
// named in the URL, wires the warp ladder to the keyboard and the plot's camera to wheel/drag,
// and drives the fixed-step loop outside debug mode. `?debug=1` installs window.graviton instead
// of animating (ADR-0004 §1).
import './styles.css';
import { createApp } from './app.ts';
import type { App } from './app.ts';
import { installDebugApi } from './debug-api.ts';
import type { DebugApiDriver } from './debug-api.ts';
import { WARP_EASE_MS, easedWarpValue, effectiveTicksThisFrame } from './loop.ts';
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
import { createSelectionPanel, renderSelection } from '../ui/selection.ts';
import { createStatusBar, renderStatus } from '../ui/status.ts';
import { createTimelineStrip, renderTimeline } from '../ui/timeline.ts';

declare const __BUILD_SHA__: string;

// Generous relative to the ~4-8 px markers themselves (GRV-0022's marker radii): a click needs to
// land near a thing, not exactly on its centre pixel.
const SELECT_RADIUS_PX = 12;

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

const status = createStatusBar();
const plot = createPlotRegion();
const selectionPanel = createSelectionPanel();
const timelineStrip = createTimelineStrip({ buildSha: __BUILD_SHA__ });
root.append(status.element, plot.element, selectionPanel.element, timelineStrip.element);

let showingError = false;

function renderSelectionAndTimeline(): void {
  renderSelection(selectionPanel, {
    hasSelection: app.selection() !== null,
    name: app.selectionName(),
    rows: app.selectionReadouts(),
  });
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

const plotController: PlotController = createPlotController({
  refs: plot,
  getFrame: () => app.frame(),
  getTrails: () => app.trails(),
  getSelection: () => app.selection(),
  onSelect: onCanvasSelect,
});
plotController.attachInput();

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
// there, so the label is always exactly correct and synchronous (loop.ts's easedWarpValue).
let warpAnim: { from: number; to: number; start: number } | null = null;

function changeWarp(mutate: () => void): void {
  const from = ticksPerFrame(app.warpRung());
  mutate(); // sets the final, correct warp text immediately (app's own synchronous render)
  const to = ticksPerFrame(app.warpRung());
  if (!debug && from !== to) warpAnim = { from, to, start: performance.now() };
}

window.addEventListener('keydown', (event) => {
  if (event.key === ' ') {
    event.preventDefault();
    changeWarp(() => app.togglePause());
  } else if (event.key === '[') {
    changeWarp(() => app.stepWarpRung(-1));
  } else if (event.key === ']') {
    changeWarp(() => app.stepWarpRung(1));
  }
});

if (!debug) {
  const frame = (now: number): void => {
    const ticks = effectiveTicksThisFrame(app.warpRung());
    if (ticks > 0) app.step(ticks); // step's onChange already re-renders the plot

    if (warpAnim) {
      const elapsed = now - warpAnim.start;
      if (elapsed < WARP_EASE_MS) {
        const value = easedWarpValue({ from: warpAnim.from, to: warpAnim.to, elapsedMs: elapsed });
        status.warp.textContent = `${Math.round(value)}x`;
      } else {
        warpAnim = null; // the target text is already correct from the last render
      }
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
  render: () => plotController.render(),
  frameHash: () => plotController.frameHash(),
  view: () => plotController.getView(),
  setView: (patch) => plotController.setView(patch),
  select: (sel) => app.select(sel),
  selection: () => app.selection(),
  loadSolution: () => app.loadSolution(),
};
installDebugApi(driver);
