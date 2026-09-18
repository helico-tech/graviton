// diffEvents table-driven per kind (GRV-0027 acceptance), plus closest-approach detection on a
// synthetic range series -- min-then-rise reports once, a monotone approach reports nothing.
import { describe, expect, test } from 'vitest';
import { diffEvents, sampleClosestApproach } from './events.ts';
import type { EventSnapshot, RangeTrend } from './events.ts';

function snapshot({
  tick,
  objects = [],
  contacts = [],
}: {
  tick: number;
  objects?: { burning?: boolean; hitContact?: number; hitBody?: number }[];
  contacts?: { cleared?: boolean; impactTick?: number }[];
}): EventSnapshot {
  return {
    tick,
    objects: objects.map((o) => ({
      burning: o.burning ?? false,
      hitContact: o.hitContact ?? -1,
      hitBody: o.hitBody ?? -1,
    })),
    contacts: contacts.map((c) => ({
      cleared: c.cleared ?? false,
      impactTick: c.impactTick ?? -1,
    })),
  };
}

describe('diffEvents', () => {
  test('an object count rise is a launch, tagged at the pre-increment tick', () => {
    const before = snapshot({ tick: 5, objects: [] });
    const after = snapshot({ tick: 6, objects: [{}] });
    expect(diffEvents({ before, after })).toEqual([{ tick: 5, kind: 'launch', probe: 0 }]);
  });

  test('two objects launching the same tick both report', () => {
    const before = snapshot({ tick: 5, objects: [] });
    const after = snapshot({ tick: 6, objects: [{}, {}] });
    expect(diffEvents({ before, after })).toEqual([
      { tick: 5, kind: 'launch', probe: 0 },
      { tick: 5, kind: 'launch', probe: 1 },
    ]);
  });

  test('burning flipping 0->1 is a nodeStart', () => {
    const before = snapshot({ tick: 10, objects: [{ burning: false }] });
    const after = snapshot({ tick: 11, objects: [{ burning: true }] });
    expect(diffEvents({ before, after })).toEqual([{ tick: 10, kind: 'nodeStart', probe: 0 }]);
  });

  test('burning flipping 1->0 is a nodeEnd', () => {
    const before = snapshot({ tick: 10, objects: [{ burning: true }] });
    const after = snapshot({ tick: 11, objects: [{ burning: false }] });
    expect(diffEvents({ before, after })).toEqual([{ tick: 10, kind: 'nodeEnd', probe: 0 }]);
  });

  test('burning unchanged reports nothing', () => {
    const before = snapshot({ tick: 10, objects: [{ burning: true }] });
    const after = snapshot({ tick: 11, objects: [{ burning: true }] });
    expect(diffEvents({ before, after })).toEqual([]);
  });

  test('hitContact newly set is an impact, tagged at the contact’s own recorded impactTick', () => {
    const before = snapshot({
      tick: 10,
      objects: [{ hitContact: -1 }],
      contacts: [{ impactTick: -1 }],
    });
    const after = snapshot({
      tick: 11,
      objects: [{ hitContact: 0 }],
      contacts: [{ impactTick: 10, cleared: true }],
    });
    expect(diffEvents({ before, after })).toEqual([
      { tick: 10, kind: 'impact', probe: 0, contact: 0 },
      { tick: 10, kind: 'cleared', contact: 0 },
    ]);
  });

  test('hitBody newly set is a bodyHit, tagged at the pre-increment tick', () => {
    const before = snapshot({ tick: 10, objects: [{ hitBody: -1 }] });
    const after = snapshot({ tick: 11, objects: [{ hitBody: 2 }] });
    expect(diffEvents({ before, after })).toEqual([
      { tick: 10, kind: 'bodyHit', probe: 0, body: 2 },
    ]);
  });

  test('a contact clearing without a same-tick impact still reports cleared', () => {
    const before = snapshot({ tick: 10, contacts: [{ cleared: false, impactTick: -1 }] });
    const after = snapshot({ tick: 11, contacts: [{ cleared: true, impactTick: 7 }] });
    expect(diffEvents({ before, after })).toEqual([{ tick: 7, kind: 'cleared', contact: 0 }]);
  });

  test('an already-hit object never reports twice', () => {
    const before = snapshot({ tick: 10, objects: [{ hitContact: 0 }] });
    const after = snapshot({ tick: 11, objects: [{ hitContact: 0 }] });
    expect(diffEvents({ before, after })).toEqual([]);
  });

  test('emits every kind at once when several land the same tick', () => {
    const before = snapshot({
      tick: 10,
      objects: [{ burning: true, hitBody: -1 }],
      contacts: [{ cleared: false }],
    });
    const after = snapshot({
      tick: 11,
      objects: [{ burning: true, hitBody: -1 }, {}],
      contacts: [{ cleared: false }],
    });
    expect(diffEvents({ before, after })).toEqual([{ tick: 10, kind: 'launch', probe: 1 }]);
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
