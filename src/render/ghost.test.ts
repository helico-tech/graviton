// plannerLabels (GRV-0028, docs/issues/2026-09-18-plot-event-labels-overlap-at-impact.md): on a
// direct hit the closest-approach and impact marks land on the same pixel and their labels used to
// render as one garbled string ("impac t118 km"). Pure over a synthetic PlannerFrame, so this stays
// a fast unit test rather than a canvas render (tests/render/plot.test.ts's own convention) --
// drawEvents itself is a thin consumer, covered indirectly through this function.
import { describe, expect, test } from 'vitest';
import { plannerLabels } from './ghost.ts';
import type { PlannerFrame } from './ghost.ts';
import type { View } from './camera.ts';

const VIEW: View = { centreX: 0, centreY: 0, metresPerPixel: 1 };
const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 360;

function frameWithEvents(events: PlannerFrame['events']): PlannerFrame {
  return {
    path: [],
    nodes: [],
    handle: null,
    events,
    launchVector: null,
    lockedUntilTick: null,
    commandHorizonMark: null,
  };
}

function labelsFor(events: PlannerFrame['events']): { x: number; y: number; text: string }[] {
  return plannerLabels({
    frame: frameWithEvents(events),
    view: VIEW,
    canvasWidth: CANVAS_WIDTH,
    canvasHeight: CANVAS_HEIGHT,
  });
}

describe('plannerLabels', () => {
  test('drops the closest-approach label when an impact for the same contact lands within 8 px of it', () => {
    const labels = labelsFor([
      { x: 0, y: 0, kind: 'closestApproach', label: 'miss 118 km', contact: 0 },
      { x: 0, y: 0, kind: 'impact', label: 'impact', contact: 0 },
    ]);

    expect(labels.map((l) => l.text)).toEqual(['impact']);
  });

  test('keeps both labels when the impact is for a different contact, even at the same point', () => {
    const labels = labelsFor([
      { x: 0, y: 0, kind: 'closestApproach', label: 'miss 118 km', contact: 0 },
      { x: 0, y: 0, kind: 'impact', label: 'impact', contact: 1 },
    ]);

    expect(labels.map((l) => l.text)).toEqual(['miss 118 km', 'impact']);
  });

  test('keeps both labels when the same-contact impact sits well outside the suppression radius', () => {
    const farAwayPx = 100; // world metres == screen px at metresPerPixel 1, well past 8 px
    const labels = labelsFor([
      { x: 0, y: 0, kind: 'closestApproach', label: 'miss 118 km', contact: 0 },
      { x: farAwayPx, y: 0, kind: 'impact', label: 'impact', contact: 0 },
    ]);

    expect(labels.map((l) => l.text)).toEqual(['miss 118 km', 'impact']);
  });

  test('a body-hit label (no contact) is never suppressed', () => {
    const labels = labelsFor([
      { x: 0, y: 0, kind: 'bodyHit', label: 'body hit' },
      { x: 0, y: 0, kind: 'impact', label: 'impact', contact: 0 },
    ]);

    expect(labels.map((l) => l.text)).toEqual(['body hit', 'impact']);
  });

  test('label positions are the screen-projected event position', () => {
    const labels = labelsFor([{ x: 10, y: 0, kind: 'impact', label: 'impact', contact: 0 }]);

    expect(labels).toEqual([{ x: CANVAS_WIDTH / 2 + 10, y: CANVAS_HEIGHT / 2, text: 'impact' }]);
  });
});
