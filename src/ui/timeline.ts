// The timeline strip (GAME-0002 §8, GRV-0023): a horizontal axis over `[0, rangeTicks]` with a
// mark per launch command, a mark per contact's recorded impact tick once it happens, and a
// present-time cursor. Rebuilt on every render rather than diffed -- panels snap, they don't tween
// (GAME-0002 §9), and this strip carries at most a handful of marks. The build tag used to live at
// this strip's right end and collided with the cursor label there (docs/issues/2026-09-18-
// timeline-label-collides-with-build-tag.md); it moved to the status bar (GRV-0024), so this strip
// keeps only its own content.
//
// Uplink availability band (GRV-0031, GAME-0001 §4.6 "occlusion windows along the plan, predicted
// from the ephemeris, drawn on the timeline"): `computeUplinkWindows` is the pure geometry --
// `segmentBlocked` (sim/lightcone.ts) against the post and a predicted path, one tick at a time --
// `renderUplinkBand` draws its own result as a dim strip along the axis, with a `timeline.uplink`
// text twin (GAME-0002 §11 "every reading on the plot is also available as text"). `src/ui`
// importing `src/sim` directly is an established pattern here already (this file's own `Sim`
// import, src/ui/planner.ts's `HEADING_TURN`) -- `segmentBlocked` needs the real thing, and a live
// `Sim` reaching main.ts (the only caller) still comes from debug-api.ts's own new session method,
// never held outside it (mirrors captureFrame's boundary -- app.ts never touches `Sim` directly).
import { segmentBlocked } from '../sim/lightcone.ts';
import { postPositionAtTime } from '../sim/post.ts';
import type { Sim } from '../sim/sim.ts';
import { formatSimTime } from '../app/time.ts';

export interface UplinkWindow {
  readonly startTick: number;
  readonly endTick: number;
}

/** Occlusion windows along `path` (GRV-0031): `segmentBlocked` between the post's own position and
 *  each sample, one call per tick -- a single-snapshot check, matching `segmentBlocked`'s own
 *  contract (both endpoints evaluated at the same instant, never the signal's own separate emission/
 *  reception times, module header of lightcone.ts). Consecutive blocked ticks merge into one
 *  window; `path` need not start at tick 0 or be contiguous from there, only internally
 *  tick-ordered (the drafted/amended ghost's own samples, or `predictProbePath`'s). */
export function computeUplinkWindows({
  sim,
  path,
}: {
  sim: Sim;
  path: readonly { tick: number; x: number; y: number }[];
}): UplinkWindow[] {
  const windows: UplinkWindow[] = [];
  let openAt: number | null = null;
  let lastTick: number | null = null;

  for (const point of path) {
    const post = postPositionAtTime({ sim, t: point.tick * sim.scenario.dt });
    const blocked = segmentBlocked({
      sim,
      ax: post.x,
      ay: post.y,
      bx: point.x,
      by: point.y,
      tick: point.tick,
    });
    if (blocked && openAt === null) openAt = point.tick;
    else if (!blocked && openAt !== null) {
      windows.push({ startTick: openAt, endTick: lastTick! });
      openAt = null;
    }
    lastTick = point.tick;
  }
  if (openAt !== null) windows.push({ startTick: openAt, endTick: lastTick! });

  return windows;
}

export interface TimelineRefs {
  element: HTMLElement;
  axis: HTMLElement;
}

export interface TimelineMark {
  readonly key: string;
  readonly tick: number;
  readonly label: string;
  /** Set only on the unified `event.<n>` marks (GRV-0027): `true` for a real, already-landed event
   *  (drawn full via `.timeline-mark--past`), `false` for a predicted upcoming one (the plain,
   *  already-dim default). `undefined` on every pre-existing mark (launch/impact/ghost.*), which
   *  keeps its own unmarked look. */
  readonly past?: boolean;
}

export function createTimelineStrip(): TimelineRefs {
  const element = document.createElement('footer');
  element.className = 'timeline-strip';
  const header = document.createElement('h2');
  header.className = 'panel-header';
  header.textContent = 'Timeline';
  const axis = document.createElement('div');
  axis.className = 'timeline-axis';
  element.append(header, axis);
  return { element, axis };
}

/** A tick's position along `[0, rangeTicks]` as a fraction of the axis, clamped to the visible
 *  range (a mark can't otherwise overflow the strip). `rangeTicks <= 0` (nothing loaded yet) reads
 *  as the axis start rather than dividing by zero. */
export function markFraction({ tick, rangeTicks }: { tick: number; rangeTicks: number }): number {
  if (rangeTicks <= 0) return 0;
  return Math.min(1, Math.max(0, tick / rangeTicks));
}

function markElement({
  tick,
  rangeTicks,
  className,
  readoutKey,
  label,
}: {
  tick: number;
  rangeTicks: number;
  className: string;
  readoutKey: string;
  label: string;
}): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.style.left = `${markFraction({ tick, rangeTicks }) * 100}%`;
  const text = document.createElement('span');
  text.className = 'timeline-mark-label';
  text.dataset.readout = readoutKey;
  text.textContent = label;
  el.append(text);
  return el;
}

/** Uplink windows as dim bands along the axis (GRV-0031, GAME-0001 §4.6), plus their own
 *  `timeline.uplink` text twin (GAME-0002 §11) -- one `BLOCKED T+… – T+…` entry per window,
 *  `—` when the path is entirely clear. Built into `renderTimeline`'s own single pass (below)
 *  rather than a separate call, since that function rebuilds the whole axis from scratch every
 *  render (`replaceChildren`) and would otherwise wipe out a band appended by an earlier call. */
function appendUplinkBand(
  refs: TimelineRefs,
  { windows, rangeTicks, dt }: { windows: readonly UplinkWindow[]; rangeTicks: number; dt: number },
): void {
  for (const w of windows) {
    const band = document.createElement('div');
    band.className = 'timeline-uplink-band';
    const left = markFraction({ tick: w.startTick, rangeTicks }) * 100;
    const right = markFraction({ tick: w.endTick, rangeTicks }) * 100;
    band.style.left = `${left}%`;
    band.style.width = `${Math.max(0, right - left)}%`;
    refs.axis.append(band);
  }
  const readout = document.createElement('span');
  readout.className = 'timeline-uplink-readout';
  readout.dataset.readout = 'timeline.uplink';
  readout.textContent =
    windows.length === 0
      ? '—'
      : windows
          .map(
            (w) =>
              `BLOCKED ${formatSimTime({ tick: w.startTick, dt })} – ${formatSimTime({ tick: w.endTick, dt })}`,
          )
          .join(', ');
  refs.axis.append(readout);
}

export function renderTimeline(
  refs: TimelineRefs,
  {
    marks,
    cursor,
    rangeTicks,
    uplinkWindows,
    dt,
  }: {
    marks: readonly TimelineMark[];
    cursor: { tick: number; label: string };
    rangeTicks: number;
    /** GRV-0031's own uplink availability band -- `[]`/omitted draws none, just the `—` readout. */
    uplinkWindows?: readonly UplinkWindow[];
    dt?: number;
  },
): void {
  refs.axis.replaceChildren();
  const line = document.createElement('div');
  line.className = 'timeline-line';
  refs.axis.append(line);
  appendUplinkBand(refs, { windows: uplinkWindows ?? [], rangeTicks, dt: dt ?? 1 });
  for (const mark of marks) {
    refs.axis.append(
      markElement({
        tick: mark.tick,
        rangeTicks,
        className: mark.past ? 'timeline-mark timeline-mark--past' : 'timeline-mark',
        readoutKey: `timeline.${mark.key}`,
        label: mark.label,
      }),
    );
  }
  refs.axis.append(
    markElement({
      tick: cursor.tick,
      rangeTicks,
      className: 'timeline-cursor',
      readoutKey: 'timeline.cursor',
      label: cursor.label,
    }),
  );
}

/** Horizon scrub (GAME-0001 §4.6 "dragging a horizon time"): pressing on the cursor itself and
 *  dragging along the axis reports a tick; releasing reports `null` ("the present"). Gated by
 *  `canScrub` (main.ts: paused only, GRV-0026 acceptance) rather than here, so this stays a plain
 *  pointer-to-tick mapping with no simulation-state opinion of its own. */
export function attachTimelineScrub(
  refs: TimelineRefs,
  {
    canScrub,
    rangeTicks,
    onScrub,
  }: {
    canScrub: () => boolean;
    rangeTicks: () => number;
    onScrub: (tick: number | null) => void;
  },
): void {
  let dragging = false;

  const tickAt = (clientX: number): number => {
    const rect = refs.axis.getBoundingClientRect();
    const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.round(Math.min(1, Math.max(0, fraction)) * rangeTicks());
  };

  refs.axis.addEventListener('pointerdown', (event) => {
    if (!canScrub()) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest('.timeline-cursor')) return;
    dragging = true;
    refs.axis.setPointerCapture(event.pointerId);
    onScrub(tickAt(event.clientX));
  });
  refs.axis.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    onScrub(tickAt(event.clientX));
  });
  const release = (): void => {
    if (!dragging) return;
    dragging = false;
    onScrub(null);
  };
  refs.axis.addEventListener('pointerup', release);
  refs.axis.addEventListener('pointercancel', release);
}
