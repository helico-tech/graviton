// confirmedContactState/confirmedProbeState (GRV-0032): pure over a `SimEvent[]` (plus, for a
// probe, its `ObservedObject`) -- no `Sim`, so these tests never construct one.
import { describe, expect, test } from 'vitest';
import { confirmedContactState, confirmedProbeState } from './confirmed.ts';
import type { ConfirmedContactState, ConfirmedProbeState } from './confirmed.ts';
import type { SimEvent } from './events.ts';
import type { ObservedObject } from './observed.ts';

function fakeObserved(overrides: Partial<ObservedObject> = {}): ObservedObject {
  return {
    observation: { tick: 0, x: 0, y: 0, vx: 0, vy: 0 },
    predicted: { x: 0, y: 0, vx: 0, vy: 0 },
    tail: [],
    delaySeconds: 0,
    expended: false,
    burning: false,
    hitBody: -1,
    hitContact: -1,
    contactCleared: false,
    contactImpactTick: -1,
    contactImpactSpeed: 0,
    contactImpactEnergy: 0,
    presentMass: 1000,
    dryMass: 400,
    exhaustVelocity: 3000,
    ...overrides,
  };
}

describe('confirmedContactState', () => {
  test('no confirmed impact at all: uncleared', () => {
    expect(confirmedContactState({ eventLog: [], contact: 0 })).toBe('uncleared');
  });

  test('a different contact’s events never leak in', () => {
    const eventLog: SimEvent[] = [
      {
        tick: 5,
        arrivalTick: 8,
        kind: 'impact',
        probe: 0,
        contact: 1,
        closingSpeed: 1,
        impactEnergy: 1,
      },
      { tick: 5, arrivalTick: 8, kind: 'cleared', contact: 1 },
    ];
    expect(confirmedContactState({ eventLog, contact: 0 })).toBe('uncleared');
  });

  test('a confirmed impact below the clearing threshold: cleared false, closing/energy still readable', () => {
    const eventLog: SimEvent[] = [
      {
        tick: 5,
        arrivalTick: 8,
        kind: 'impact',
        probe: 0,
        contact: 0,
        closingSpeed: 900,
        impactEnergy: 5e9,
      },
    ];
    const result = confirmedContactState({ eventLog, contact: 0 }) as Exclude<
      ConfirmedContactState,
      'uncleared'
    >;
    expect(result.cleared).toBe(false);
    expect(result.impactTick).toBe(5);
    expect(result.arrivalTick).toBe(8);
    expect(result.closingSpeed).toBe(900);
    expect(result.impactEnergy).toBe(5e9);
  });

  test('a confirmed impact that clears the contact: cleared true', () => {
    const eventLog: SimEvent[] = [
      {
        tick: 5,
        arrivalTick: 8,
        kind: 'impact',
        probe: 0,
        contact: 0,
        closingSpeed: 15_000,
        impactEnergy: 2e10,
      },
      { tick: 5, arrivalTick: 8, kind: 'cleared', contact: 0 },
    ];
    const result = confirmedContactState({ eventLog, contact: 0 }) as Exclude<
      ConfirmedContactState,
      'uncleared'
    >;
    expect(result.cleared).toBe(true);
    expect(result.impactTick).toBe(5);
  });

  test('two impacts on the same contact: the last one wins (GRV-0015, contacts.ts’s own "last impact only")', () => {
    const eventLog: SimEvent[] = [
      {
        tick: 5,
        arrivalTick: 8,
        kind: 'impact',
        probe: 0,
        contact: 0,
        closingSpeed: 900,
        impactEnergy: 5e9,
      },
      {
        tick: 40,
        arrivalTick: 43,
        kind: 'impact',
        probe: 1,
        contact: 0,
        closingSpeed: 20_000,
        impactEnergy: 3e10,
      },
      { tick: 40, arrivalTick: 43, kind: 'cleared', contact: 0 },
    ];
    const result = confirmedContactState({ eventLog, contact: 0 }) as Exclude<
      ConfirmedContactState,
      'uncleared'
    >;
    expect(result.impactTick).toBe(40);
    expect(result.closingSpeed).toBe(20_000);
    expect(result.cleared).toBe(true);
  });
});

describe('confirmedProbeState', () => {
  test('no observation yet: unobserved', () => {
    const observed = fakeObserved({ observation: null });
    const state = confirmedProbeState({ eventLog: [], observed, probe: 0 });
    expect(state).toBe('unobserved');
  });

  test('a null observed view (the probe has never launched): unobserved', () => {
    const state = confirmedProbeState({ eventLog: [], observed: null, probe: 0 });
    expect(state).toBe('unobserved');
  });

  test('observed, no confirmed impact/bodyHit event: flying', () => {
    const observed = fakeObserved();
    const state = confirmedProbeState({ eventLog: [], observed, probe: 0 });
    expect(state).toBe('flying');
  });

  test('another probe’s confirmed impact never leaks in', () => {
    const observed = fakeObserved();
    const eventLog: SimEvent[] = [
      {
        tick: 5,
        arrivalTick: 8,
        kind: 'impact',
        probe: 1,
        contact: 0,
        closingSpeed: 1,
        impactEnergy: 1,
      },
    ];
    expect(confirmedProbeState({ eventLog, observed, probe: 0 })).toBe('flying');
  });

  test('a confirmed impact on a contact: expended at the event tick, confirmed at the arrival tick', () => {
    const observed = fakeObserved();
    const eventLog: SimEvent[] = [
      {
        tick: 12,
        arrivalTick: 17,
        kind: 'impact',
        probe: 0,
        contact: 0,
        closingSpeed: 1,
        impactEnergy: 1,
      },
    ];
    const state = confirmedProbeState({ eventLog, observed, probe: 0 }) as Exclude<
      ConfirmedProbeState,
      'unobserved' | 'flying'
    >;
    expect(state.expendedTick).toBe(12);
    expect(state.confirmedTick).toBe(17);
  });

  test('a confirmed body hit: expended at the event tick, confirmed at the arrival tick (bodyHit now carries both, unlike the pre-GRV-0032 "no recorded tick" gap)', () => {
    const observed = fakeObserved();
    const eventLog: SimEvent[] = [
      { tick: 12, arrivalTick: 13, kind: 'bodyHit', probe: 0, body: 1 },
    ];
    const state = confirmedProbeState({ eventLog, observed, probe: 0 }) as Exclude<
      ConfirmedProbeState,
      'unobserved' | 'flying'
    >;
    expect(state.expendedTick).toBe(12);
    expect(state.confirmedTick).toBe(13);
  });
});
