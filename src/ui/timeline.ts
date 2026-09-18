// The timeline strip (GAME-0002 §8, GRV-0023): a horizontal axis over `[0, rangeTicks]` with a
// mark per launch command, a mark per contact's recorded impact tick once it happens, and a
// present-time cursor. Rebuilt on every render rather than diffed -- panels snap, they don't tween
// (GAME-0002 §9), and this strip carries at most a handful of marks.
export interface TimelineRefs {
  element: HTMLElement;
  axis: HTMLElement;
  buildTag: HTMLElement;
}

export interface TimelineMark {
  readonly key: string;
  readonly tick: number;
  readonly label: string;
}

export function createTimelineStrip({ buildSha }: { buildSha: string }): TimelineRefs {
  const element = document.createElement('footer');
  element.className = 'timeline-strip';
  const header = document.createElement('h2');
  header.className = 'panel-header';
  header.textContent = 'Timeline';
  const axis = document.createElement('div');
  axis.className = 'timeline-axis';
  const buildTag = document.createElement('span');
  buildTag.className = 'build-tag';
  buildTag.textContent = `GRAVITON build ${buildSha}`;
  element.append(header, axis, buildTag);
  return { element, axis, buildTag };
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
        className: 'timeline-mark',
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
