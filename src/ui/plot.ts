// The plot region (GAME-0002 §8): a canvas cleared to ground colour this unit -- GRV-0022 owns
// the renderer -- plus an error overlay for an unknown level id. The overlay is text, not a
// number, so it carries no data-readout (docs/domain/simulation-determinism.md rule 11 is about
// numbers the player reads as telemetry, not an error label).
const GROUND = '#05070a';

export interface PlotRefs {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  error: HTMLElement;
  brief: HTMLElement;
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
  element.append(canvas, error, brief);
  return { element, canvas, error, brief };
}

/** Backs the canvas at devicePixelRatio so 1 px lines stay crisp (GAME-0002 §3's "digits never
 *  jitter" spirit applied to line work); resizes only when the box actually changed size, so a
 *  resize observer firing every layout pass doesn't thrash the backing store. */
export function resizePlot(refs: PlotRefs): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = refs.element.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (refs.canvas.width !== width) refs.canvas.width = width;
  if (refs.canvas.height !== height) refs.canvas.height = height;
}

export function clearPlot(refs: PlotRefs): void {
  resizePlot(refs);
  const ctx = refs.canvas.getContext('2d');
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
