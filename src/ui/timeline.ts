// The timeline strip (GAME-0002 §8, GRV-0023): a horizontal axis over `[0, rangeTicks]` with a
// mark per launch command, a mark per contact's recorded impact tick once it happens, and a
// present-time cursor. Rebuilt on every render rather than diffed -- panels snap, they don't tween
// (GAME-0002 §9), and this strip carries at most a handful of marks. The build tag used to live at
// this strip's right end and collided with the cursor label there (docs/issues/2026-09-18-
// timeline-label-collides-with-build-tag.md); it moved to the status bar (GRV-0024), so this strip
// keeps only its own content.
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

export function renderTimeline(
  refs: TimelineRefs,
  {
    marks,
    cursor,
    rangeTicks,
  }: {
    marks: readonly TimelineMark[];
    cursor: { tick: number; label: string };
    rangeTicks: number;
  },
): void {
  refs.axis.replaceChildren();
  const line = document.createElement('div');
  line.className = 'timeline-line';
  refs.axis.append(line);
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
