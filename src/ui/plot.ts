// The plot region (GAME-0002 §8): the canvas, its DPR-aware sizing, the camera (pan/zoom input,
// GRV-0022 acceptance), the scale bar and zoom `data-readout`s (ADR-0004 §2), and `render`/
// `frameHash` for the debug API (ADR-0004 §1). `createPlotController` is the one place that
// bridges the DOM-free `renderPlot` (src/render/plot.ts) to a real canvas; it never reaches into
// the simulation itself -- it only ever sees the `Frame`/trails its caller (main.ts, backed by
// src/app/app.ts) hands it (docs/domain/simulation-determinism.md rule 10).
import {
  defaultView,
  formatMetres,
  pan,
  pickScaleBar,
  zoomAt,
  zoomBounds,
} from '../render/camera.ts';
import type { View } from '../render/camera.ts';
import { hashCanvasPixels, renderPlot } from '../render/plot.ts';
import type { Frame } from '../render/frame.ts';
import type { Ctx2D } from '../render/ctx2d.ts';

const GROUND = '#05070a';
const ZOOM_SENSITIVITY = 0.001; // ~10% per wheel notch (deltaY ~= 100)

export interface PlotRefs {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  error: HTMLElement;
  brief: HTMLElement;
  scale: HTMLElement;
  zoom: HTMLElement;
}

export function createPlotRegion(): PlotRefs {
  const element = document.createElement('section');
  element.className = 'plot-region';
  const canvas = document.createElement('canvas');
  const error = document.createElement('div');
  error.className = 'plot-error';
  error.hidden = true;
  const brief = document.createElement('div');
  brief.className = 'plot-brief';
  brief.hidden = true;

  const readouts = document.createElement('div');
  readouts.className = 'plot-readouts';
  const { field: scaleField, value: scale } = readoutField('SCALE', 'plot.scale');
  const { field: zoomField, value: zoom } = readoutField('ZOOM', 'plot.zoom');
  readouts.append(scaleField, zoomField);

  element.append(canvas, error, brief, readouts);
  return { element, canvas, error, brief, scale, zoom };
}

function readoutField(label: string, readout: string): { field: HTMLElement; value: HTMLElement } {
  const field = document.createElement('div');
  field.className = 'plot-readout';
  const labelEl = document.createElement('span');
  labelEl.className = 'field-label';
  labelEl.textContent = label;
  const value = document.createElement('span');
  value.className = 'value';
  value.dataset.readout = readout;
  field.append(labelEl, value);
  return { field, value };
}

/** Backs the canvas at devicePixelRatio so 1 px lines stay crisp (GAME-0002 §3's "digits never
 *  jitter" spirit applied to line work); resizes only when the box actually changed size, so a
 *  resize observer firing every layout pass doesn't thrash the backing store. `override` sizes
 *  the backing store directly instead, for URL `w`/`h` (ADR-0004 §1's reproducible shots). */
export function resizePlot(refs: PlotRefs, override?: { width: number; height: number }): void {
  const { width, height } = override ?? autoSize(refs.element);
  if (refs.canvas.width !== width) refs.canvas.width = width;
  if (refs.canvas.height !== height) refs.canvas.height = height;
}

function autoSize(element: HTMLElement): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  const rect = element.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(rect.width * dpr)),
    height: Math.max(1, Math.round(rect.height * dpr)),
  };
}

export function clearPlot(refs: PlotRefs): void {
  resizePlot(refs);
  // `willReadFrequently` must be set on the context's first creation (later `getContext('2d')`
  // calls on the same canvas just return the cached context) -- frameHash() (below) reads pixels
  // back on every call, and Chrome logs a console warning without this, which the console gate
  // (ADR-0004 §4) treats as a failure.
  const ctx = refs.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, refs.canvas.width, refs.canvas.height);
}

export function showPlotError(
  refs: PlotRefs,
  { id, knownIds }: { id: string; knownIds: string[] },
): void {
  refs.error.hidden = false;
  refs.error.replaceChildren();
  const title = document.createElement('p');
  title.className = 'plot-error-title';
  title.textContent = `No such level ${id}`;
  const list = document.createElement('p');
  list.className = 'plot-error-list';
  list.textContent = knownIds.length ? `Known: ${knownIds.join(', ')}` : 'No levels bundled';
  refs.error.append(title, list);
}

export function hidePlotError(refs: PlotRefs): void {
  refs.error.hidden = true;
}

/** The brief (GAME-0001 §3's "one paragraph" step of the core loop), shown as body text
 *  (GAME-0002 §3) over a corner of the plot region -- there is no fifth region for it in §8's
 *  layout, and the plot is otherwise empty until GRV-0022's renderer. */
export function showBrief(refs: PlotRefs, { name, text }: { name: string; text: string }): void {
  refs.brief.hidden = false;
  refs.brief.replaceChildren();
  const heading = document.createElement('p');
  heading.className = 'plot-brief-name';
  heading.textContent = name;
  const body = document.createElement('p');
  body.className = 'plot-brief-text';
  body.textContent = text;
  refs.brief.append(heading, body);
}

export function hideBrief(refs: PlotRefs): void {
  refs.brief.hidden = true;
}

export interface PlotController {
  /** Draws one synchronous frame of the plot (ADR-0004 §1's `render()`). */
  render(): void;
  /** FNV-1a over the plot canvas's RGBA bytes (ADR-0004 §1's `frameHash()`). */
  frameHash(): string;
  /** A copy of the camera's current state. */
  getView(): View;
  /** Merges `patch` over the current view (or, before any view exists, over the level's default
   *  view) -- each of URL `zoom`/`cx`/`cy` can be set independently. */
  setView(patch: Partial<View>): void;
  /** `null` reverts to automatic DPR sizing; a size overrides the backing store directly (URL
   *  `w`/`h`). Takes effect on the next `render()`. */
  setCanvasSize(size: { width: number; height: number } | null): void;
  /** Drops the current view so the next `render()` recomputes the level's default framing --
   *  main.ts calls this whenever a fresh level or scenario loads. */
  resetView(): void;
  /** Wires wheel-to-zoom (about the cursor) and drag-to-pan to the canvas. */
  attachInput(): void;
}

export function createPlotController({
  refs,
  getFrame,
  getTrails,
}: {
  refs: PlotRefs;
  getFrame: () => Frame;
  getTrails: () => ReadonlyMap<number, readonly { x: number; y: number }[]>;
}): PlotController {
  let view: View | null = null;
  let sizeOverride: { width: number; height: number } | null = null;

  function rawCtx(): CanvasRenderingContext2D {
    const context = refs.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('plot: 2d context unavailable');
    return context;
  }

  // `CanvasRenderingContext2D.fillStyle`/`strokeStyle` are typed `string | CanvasGradient |
  // CanvasPattern`, wider than `Ctx2D`'s deliberately `string`-only contract (this renderer never
  // uses a gradient or a pattern -- GAME-0002 §5 "no smooth gradients"); the browser context is a
  // structural superset of `Ctx2D` in every method actually called (ctx2d.ts), so this narrowing
  // is the one cast the DOM boundary needs.
  function ctx(): Ctx2D {
    return rawCtx() as unknown as Ctx2D;
  }

  function ensureSized(): void {
    resizePlot(refs, sizeOverride ?? undefined);
  }

  function currentView(frame: Frame): View {
    if (!view) {
      ensureSized();
      view = defaultView({
        largestOrbitRadius: frame.systemExtent,
        canvasWidth: refs.canvas.width,
        canvasHeight: refs.canvas.height,
      });
    }
    return view;
  }

  function updateReadouts(activeView: View): void {
    const bar = pickScaleBar({
      metresPerPixel: activeView.metresPerPixel,
      canvasWidth: refs.canvas.width,
    });
    refs.scale.textContent = bar.label;
    refs.zoom.textContent = `${formatMetres(activeView.metresPerPixel)}/px`;
  }

  function render(): void {
    ensureSized();
    const frame = getFrame();
    const activeView = currentView(frame);
    renderPlot({
      ctx: ctx(),
      view: activeView,
      frame,
      trails: getTrails(),
      canvasWidth: refs.canvas.width,
      canvasHeight: refs.canvas.height,
    });
    updateReadouts(activeView);
  }

  function frameHash(): string {
    return hashCanvasPixels(rawCtx(), refs.canvas.width, refs.canvas.height);
  }

  function getView(): View {
    return currentView(getFrame());
  }

  function setView(patch: Partial<View>): void {
    view = { ...currentView(getFrame()), ...patch };
  }

  function setCanvasSize(size: { width: number; height: number } | null): void {
    sizeOverride = size;
  }

  function resetView(): void {
    view = null;
  }

  function attachInput(): void {
    refs.canvas.addEventListener(
      'wheel',
      (event) => {
        if (!view) return;
        event.preventDefault();
        const dpr = window.devicePixelRatio || 1;
        const rect = refs.canvas.getBoundingClientRect();
        const screenX = (event.clientX - rect.left) * dpr;
        const screenY = (event.clientY - rect.top) * dpr;
        const factor = Math.exp(event.deltaY * ZOOM_SENSITIVITY);
        view = zoomAt({
          view,
          canvasWidth: refs.canvas.width,
          canvasHeight: refs.canvas.height,
          screenX,
          screenY,
          factor,
          bounds: zoomBounds({ largestOrbitRadius: getFrame().systemExtent }),
        });
        render();
      },
      { passive: false },
    );

    let dragFrom: { x: number; y: number } | null = null;
    refs.canvas.addEventListener('pointerdown', (event) => {
      if (!view) return;
      refs.canvas.setPointerCapture(event.pointerId);
      dragFrom = { x: event.clientX, y: event.clientY };
    });
    refs.canvas.addEventListener('pointermove', (event) => {
      if (!view || !dragFrom) return;
      const dpr = window.devicePixelRatio || 1;
      const dxPixels = (event.clientX - dragFrom.x) * dpr;
      const dyPixels = (event.clientY - dragFrom.y) * dpr;
      dragFrom = { x: event.clientX, y: event.clientY };
      view = pan({ view, dxPixels, dyPixels });
      render();
    });
    const endDrag = (): void => {
      dragFrom = null;
    };
    refs.canvas.addEventListener('pointerup', endDrag);
    refs.canvas.addEventListener('pointercancel', endDrag);
  }

  return { render, frameHash, getView, setView, setCanvasSize, resetView, attachInput };
}
