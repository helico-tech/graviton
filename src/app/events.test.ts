// diffObservedEvents table-driven per kind (GRV-0027 acceptance, reworked for GRV-0030's telemetry
// events -- each carries both the simulation tick and the arrival tick), plus closest-approach
// detection on a synthetic range series -- min-then-rise reports once, a monotone approach reports
// nothing (unchanged: closest approach stays a prediction event, not a telemetry one).
import { describe, expect, test } from 'vitest';
import { diffObservedEvents, sampleClosestApproach } from './events.ts';
import type { ObservedEventObject, RangeTrend } from './events.ts';

function observed({
  tick,
  burning = false,
  hitContact = -1,
  hitBody = -1,
  contactCleared = false,
  contactImpactTick = -1,
}: {
  tick: number | null;
  burning?: boolean;
  hitContact?: number;
  hitBody?: number;
  contactCleared?: boolean;
  contactImpactTick?: number;
}): ObservedEventObject {
  return {
    observation: tick === null ? null : { tick },
    burning,
    hitContact,
    hitBody,
    contactCleared,
    contactImpactTick,
  };
}

const NONE: ObservedEventObject = observed({ tick: null });

describe('diffObservedEvents', () => {
  test('an object newly observed at all is a launch, tagged at the observation’s own tick (history records a launch at its own creation instant)', () => {
    const events = diffObservedEvents({
      before: [NONE],
      after: [observed({ tick: 6 })],
      atTick: 20,
    });
    expect(events).toEqual([{ tick: 6, arrivalTick: 20, kind: 'launch', probe: 0 }]);
  });

  test('two objects newly observed the same tick both report', () => {
    const events = diffObservedEvents({
      before: [NONE, NONE],
      after: [observed({ tick: 6 }), observed({ tick: 6 })],
      atTick: 20,
    });
    expect(events).toEqual([
      { tick: 6, arrivalTick: 20, kind: 'launch', probe: 0 },
      { tick: 6, arrivalTick: 20, kind: 'launch', probe: 1 },
    ]);
  });

  test('burning flipping 0->1 is a nodeStart', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, burning: false })],
      after: [observed({ tick: 11, burning: true })],
      atTick: 30,
    });
    expect(events).toEqual([{ tick: 10, arrivalTick: 30, kind: 'nodeStart', probe: 0 }]);
  });

  test('burning flipping 1->0 is a nodeEnd', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, burning: true })],
      after: [observed({ tick: 11, burning: false })],
      atTick: 30,
    });
    expect(events).toEqual([{ tick: 10, arrivalTick: 30, kind: 'nodeEnd', probe: 0 }]);
  });

  test('burning unchanged reports nothing', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, burning: true })],
      after: [observed({ tick: 11, burning: true })],
      atTick: 30,
    });
    expect(events).toEqual([]);
  });

  test('hitContact newly set is an impact, tagged at the sim’s own recorded impact tick (not the observation’s); a same-observation clear reports too', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, hitContact: -1 })],
      after: [observed({ tick: 11, hitContact: 0, contactCleared: true, contactImpactTick: 7 })],
      atTick: 30,
    });
    expect(events).toEqual([
      { tick: 7, arrivalTick: 30, kind: 'impact', probe: 0, contact: 0 },
      { tick: 7, arrivalTick: 30, kind: 'cleared', contact: 0 },
    ]);
  });

  test('hitContact newly set without clearing the threshold reports only the impact', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, hitContact: -1 })],
      after: [observed({ tick: 11, hitContact: 0, contactCleared: false, contactImpactTick: 7 })],
      atTick: 30,
    });
    expect(events).toEqual([{ tick: 7, arrivalTick: 30, kind: 'impact', probe: 0, contact: 0 }]);
  });

  test('an impact revealed long after an occlusion blackout still reports the true impact tick', () => {
    // The observation jumps from tick 100 (no hit yet) straight to tick 900 (hit) -- a long
    // blackout, not consecutive ticks -- yet the true impact happened at tick 130.
    const events = diffObservedEvents({
      before: [observed({ tick: 100, hitContact: -1 })],
      after: [
        observed({ tick: 900, hitContact: 0, contactCleared: false, contactImpactTick: 130 }),
      ],
      atTick: 950,
    });
    expect(events).toEqual([{ tick: 130, arrivalTick: 950, kind: 'impact', probe: 0, contact: 0 }]);
  });

  test('hitBody newly set is a bodyHit', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, hitBody: -1 })],
      after: [observed({ tick: 11, hitBody: 2 })],
      atTick: 30,
    });
    expect(events).toEqual([{ tick: 10, arrivalTick: 30, kind: 'bodyHit', probe: 0, body: 2 }]);
  });

  test('an already-hit object never reports twice', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, hitContact: 0 })],
      after: [observed({ tick: 11, hitContact: 0 })],
      atTick: 30,
    });
    expect(events).toEqual([]);
  });

  test('an object with no observation yet in `after` reports nothing', () => {
    const events = diffObservedEvents({ before: [NONE], after: [NONE], atTick: 30 });
    expect(events).toEqual([]);
  });

  test('emits every kind at once when several land the same tick', () => {
    const events = diffObservedEvents({
      before: [observed({ tick: 10, burning: true }), NONE],
      after: [observed({ tick: 11, burning: true }), observed({ tick: 11 })],
      atTick: 30,
    });
    expect(events).toEqual([{ tick: 11, arrivalTick: 30, kind: 'launch', probe: 1 }]);
  });
});

describe('sampleClosestApproach', () => {
  function runSeries(samples: number[]): ReturnType<typeof sampleClosestApproach>['event'][] {
    let trend: RangeTrend | null = null;
    const events: ReturnType<typeof sampleClosestApproach>['event'][] = [];
    samples.forEach((range, i) => {
      const result = sampleClosestApproach({ prior: trend, tick: i, probe: 0, contact: 0, range });
      trend = result.trend;
      events.push(result.event);
    });
    return events;
  }

  test('a monotone approach (never turns) reports nothing', () => {
    const events = runSeries([100, 80, 60, 40, 20]);
    expect(events.every((e) => e === null)).toBe(true);
  });

  test('a monotone recession (never closed in) reports nothing', () => {
    const events = runSeries([20, 40, 60, 80, 100]);
    expect(events.every((e) => e === null)).toBe(true);
  });

  test('a minimum turning into a rise reports once, at the minimum’s own tick', () => {
    const events = runSeries([100, 60, 30, 45, 90]);
    // falls to tick 2 (range 30), rises at tick 3 -> reported when the rise is observed.
    const fired = events.filter((e): e is NonNullable<typeof e> => e !== null);
    expect(fired).toEqual([{ tick: 2, kind: 'closestApproach', probe: 0, contact: 0 }]);
  });

  test('a flyby then a second closer pass reports both minima', () => {
    const events = runSeries([50, 30, 40, 60, 20, 25]);
    const fired = events.filter((e): e is NonNullable<typeof e> => e !== null);
    expect(fired).toEqual([
      { tick: 1, kind: 'closestApproach', probe: 0, contact: 0 },
      { tick: 4, kind: 'closestApproach', probe: 0, contact: 0 },
    ]);
  });

  test('the very first sample never itself reports', () => {
    const result = sampleClosestApproach({ prior: null, tick: 0, probe: 0, contact: 0, range: 10 });
    expect(result.event).toBeNull();
  });
});
