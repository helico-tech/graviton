// App bootstrap (GRV-0021): builds the four-region shell (GAME-0002 §8), loads the level named in
// the URL, wires the warp ladder to the keyboard, and drives the fixed-step loop outside debug
// mode. `?debug=1` installs window.graviton instead of animating (ADR-0004 §1).
import './styles.css';
import { createApp } from './app.ts';
import { installDebugApi } from './debug-api.ts';
import { WARP_EASE_MS, easedWarpValue, effectiveTicksThisFrame } from './loop.ts';
import { ticksPerFrame } from './warp.ts';
import {
  clearPlot,
  createPlotRegion,
  hideBrief,
  hidePlotError,
  showBrief,
  showPlotError,
} from '../ui/plot.ts';
import { createSelectionPanel, createTimelineStrip } from '../ui/panels.ts';
import { createStatusBar, renderStatus } from '../ui/status.ts';

declare const __BUILD_SHA__: string;

const params = new URLSearchParams(window.location.search);
const debug = params.get('debug') === '1';
const levelId = params.get('level') ?? 'L01-intercept';
const tickParam = params.get('tick');
const warpParam = params.get('warp');

const root = document.getElementById('app');
if (!root) throw new Error('main: #app is missing from index.html');
root.replaceChildren();
root.className = 'shell';

const status = createStatusBar();
const plot = createPlotRegion();
const selection = createSelectionPanel();
const timeline = createTimelineStrip({ buildSha: __BUILD_SHA__ });
root.append(status.element, plot.element, selection, timeline);

const app = createApp({
  onChange: ({ status: values, plotError, brief }) => {
    renderStatus(status, values);
    if (plotError) {
      showPlotError(plot, plotError);
    } else {
      hidePlotError(plot);
      clearPlot(plot);
    }
    if (brief) showBrief(plot, brief);
    else hideBrief(plot);
  },
});

app.loadLevel(levelId);
// ?tick=<n> reproduces a shot at a given moment, then pauses; ?warp=<rung> sets the rung for the
// shot directly, overriding the pause a bare ?tick would otherwise leave behind (ADR-0004 §1).
if (tickParam !== null) app.warpTo(Number(tickParam));
if (warpParam !== null) app.setWarp(Number(warpParam));
else if (tickParam !== null) app.setWarp(0);

window.addEventListener('resize', () => clearPlot(plot));

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
    if (ticks > 0) app.step(ticks);

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

installDebugApi(app);
