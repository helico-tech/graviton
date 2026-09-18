// Selection state, picking and readouts (GRV-0023): `pickAt` is pure geometry over a `Frame` and
// a `View` (no `Sim`, so it's testable with a hand-built frame); `describeSelection` reads a live
// `Sim`'s static tables and the compiled level's names, independently of the renderer (docs/
// domain/simulation-determinism.md rule 11) -- a contact's/probe's own dynamic state comes from
// `eventLog`/`observed` instead (GRV-0032), never `sim.contactState`/`sim.objects`; the contact
// and probe test blocks below build those directly (a fake `ObservedObject`, a hand-built
// `SimEvent[]`) rather than driving a real `Sim` forward, so they can assert the *delayed*
// behaviour directly: the true state already shows an outcome, but describeSelection must not
// show it until a matching, arrived telemetry event says so. Math.* is fine here -- tests are
// exempt from src/sim's determinism lint and used deliberately as an independent oracle against
// the sim's own `dlog`; units are built with src/ui/format.ts's own (separately table-tested)
// formatters, so what's under test here is the underlying formula and field selection, not string
// formatting twice over.
import { describe, expect, test } from 'vitest';
import { contactPoint } from '../sim/contacts.ts';
import { evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import { createSim } from '../sim/sim.ts';
import type { Scenario } from '../sim/sim.ts';
import type { Frame, FrameLevelNames } from '../render/frame.ts';
import type { View } from '../render/camera.ts';
import {
  formatDegrees,
  formatDuration,
  formatJoules,
  formatKilograms,
  formatKilometres,
  formatKilometresPerSecond,
} from '../ui/format.ts';
import type { SimEvent } from './events.ts';
import type { ObservedObject } from './observed.ts';
import { formatSimTime } from './time.ts';
import { describeSelection, parseSelectionParam, pickAt, selectionName } from './selection.ts';
import type { Selection } from './selection.ts';

const DASH = '—';

function frameBody(overrides: Partial<Frame['bodies'][number]> = {}): Frame['bodies'][number] {
  return {
    id: 'b',
    name: 'B',
    klass: 'rock',
    x: 0,
    y: 0,
    radius: 1,
    surfacePhase: 0,
    directionToPrimaryX: 0,
    directionToPrimaryY: 0,
    orbit: null,
    ...overrides,
  };
}

function baseFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    tick: 0,
    dt: 1,
    bodies: [],
    rails: [],
    contacts: [],
    objects: [],
    systemExtent: 1000,
    ...overrides,
  };
}

const IDENTITY_VIEW: View = { centreX: 0, centreY: 0, metresPerPixel: 1 };
const CANVAS = { canvasWidth: 400, canvasHeight: 400 };
// worldToScreen puts world (0,0) at the canvas centre and 1 world metre = 1 screen px at this view.
const CENTRE = { x: CANVAS.canvasWidth / 2, y: CANVAS.canvasHeight / 2 };

describe('pickAt', () => {
  test('returns null when nothing is loaded', () => {
    expect(
      pickAt({
        frame: baseFrame(),
        view: IDENTITY_VIEW,
        ...CANVAS,
        screenX: 0,
        screenY: 0,
        radiusPx: 10,
      }),
    ).toBeNull();
  });

  test('picks the sole candidate within radius', () => {
    const frame = baseFrame({ bodies: [frameBody({ x: 0, y: 0 })] });
    const result = pickAt({
      frame,
      view: IDENTITY_VIEW,
      ...CANVAS,
      screenX: CENTRE.x,
      screenY: CENTRE.y,
      radiusPx: 5,
    });
    expect(result).toEqual({ kind: 'body', index: 0 });
  });

  test('returns null when the nearest candidate is outside the radius', () => {
    const frame = baseFrame({ bodies: [frameBody({ x: 50, y: 0 })] });
    const result = pickAt({
      frame,
      view: IDENTITY_VIEW,
      ...CANVAS,
      screenX: CENTRE.x,
      screenY: CENTRE.y,
      radiusPx: 5,
    });
    expect(result).toBeNull();
  });

  test('the radius boundary is inclusive', () => {
    const frame = baseFrame({ bodies: [frameBody({ x: 5, y: 0 })] });
    const atBoundary = pickAt({
      frame,
      view: IDENTITY_VIEW,
      ...CANVAS,
      screenX: CENTRE.x,
      screenY: CENTRE.y,
      radiusPx: 5,
    });
    expect(atBoundary).toEqual({ kind: 'body', index: 0 });
  });

  test('picks the nearest candidate among different kinds', () => {
    const frame = baseFrame({
      bodies: [frameBody({ x: 0, y: 0 })],
      contacts: [{ id: 'c', name: 'C', x: 30, y: 0, cleared: false }],
    });
    const result = pickAt({
      frame,
      view: IDENTITY_VIEW,
      ...CANVAS,
      screenX: CENTRE.x + 30,
      screenY: CENTRE.y,
      radiusPx: 40,
    });
    expect(result).toEqual({ kind: 'contact', index: 0 });
  });

  test('exact ties break probe > contact > rail > body', () => {
    const frame = baseFrame({
      bodies: [frameBody({ x: 10, y: 0 })],
      rails: [{ id: 'r', name: 'R', x: 10, y: 0, ux: 1, uy: 0 }],
      contacts: [{ id: 'c', name: 'C', x: 10, y: 0, cleared: false }],
      objects: [{ x: 10, y: 0, vx: 0, vy: 0, expended: false, observed: true }],
    });
    const result = pickAt({
      frame,
      view: IDENTITY_VIEW,
      ...CANVAS,
      screenX: CENTRE.x + 10,
      screenY: CENTRE.y,
      radiusPx: 20,
    });
    expect(result).toEqual({ kind: 'probe', index: 0 });
  });

  test('a near-tie within 1 px still favours the higher-priority kind', () => {
    const frame = baseFrame({
      rails: [{ id: 'r', name: 'R', x: 10, y: 0, ux: 1, uy: 0 }],
      objects: [{ x: 10.5, y: 0, vx: 0, vy: 0, expended: false, observed: true }], // 0.5 px farther than the rail
    });
    const result = pickAt({
      frame,
      view: IDENTITY_VIEW,
      ...CANVAS,
      screenX: CENTRE.x + 10,
      screenY: CENTRE.y,
      radiusPx: 20,
    });
    expect(result).toEqual({ kind: 'probe', index: 0 });
  });

  test('outside the 1 px tie band, the strictly nearer candidate wins regardless of priority', () => {
    const frame = baseFrame({
      rails: [{ id: 'r', name: 'R', x: 10, y: 0, ux: 1, uy: 0 }],
      objects: [{ x: 15, y: 0, vx: 0, vy: 0, expended: false, observed: true }], // 5 px farther than the rail
    });
    const result = pickAt({
      frame,
      view: IDENTITY_VIEW,
      ...CANVAS,
      screenX: CENTRE.x + 10,
      screenY: CENTRE.y,
      radiusPx: 20,
    });
    expect(result).toEqual({ kind: 'rail', index: 0 });
  });
});

const PRIMARY_MU = 1.327e20;
const HOST_MU = 3.986e14;
const A = 1e9;
const E = 0.05;

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    dt: 30,
    capacity: 4,
    burnNodeCapacity: 4,
    bodies: [
      { parent: -1, mu: PRIMARY_MU, radius: 5e6, rotationPeriod: 1e5, axialPhaseAtEpoch: 0 },
      {
        parent: 0,
        mu: HOST_MU,
        radius: 1e6,
        a: A,
        e: E,
        argPeriapsis: 0,
        meanAnomaly0: 0,
        rotationPeriod: 5e4,
        axialPhaseAtEpoch: 0,
      },
    ],
    rails: [
      {
        host: 1,
        longitude: 0,
        muzzleSpeedMin: 1000,
        muzzleSpeedMax: 200_000,
        headingCone: Math.PI / 3,
        reloadTicks: 100,
      },
    ],
    contacts: [{ host: 1, longitude: 0, captureRadius: 20_000, minimumImpactEnergy: 1e10 }],
    post: { host: 1, longitude: 0 },
    historyTicks: 4096,
    probe: { dryMass: 400, propellantMass: 600, exhaustVelocity: 3000, thrust: 500 },
    streams: [],
    ...overrides,
  };
}

const level: FrameLevelNames = {
  bodyIds: ['primary', 'host'],
  railIds: ['host-rail'],
  contactIds: ['hulk'],
  bodyClasses: ['star', 'rock'],
  names: { bodies: ['Primary', 'Host'], rails: ['Host Rail'], contacts: ['Hulk'] },
};

function rowValue(
  rows: readonly { key: string; label: string; value: string }[],
  key: string,
): string {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row for key ${key}`);
  return row.value;
}

const NO_EVENTS: SimEvent[] = [];
const NO_OBSERVED: ObservedObject[] = [];

/** A ready-to-use `ObservedObject` (GRV-0032): every field defaults to "observed, flying,
 *  untouched by any telemetry event", so a test only overrides what it's actually exercising. */
function fakeObserved(overrides: Partial<ObservedObject> = {}): ObservedObject {
  return {
    observation: { tick: 0, x: 0, y: 0, vx: 0, vy: 0 },
    predicted: { x: 2e8, y: 0, vx: 0, vy: 25_000 },
    tail: [],
    delaySeconds: 30,
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

describe('describeSelection: null selection', () => {
  test('returns no rows', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    expect(
      describeSelection({
        sim,
        level,
        selection: null,
        eventLog: NO_EVENTS,
        observed: NO_OBSERVED,
      }),
    ).toEqual([]);
  });
});

describe('describeSelection: body', () => {
  test('the primary: no orbital period, zero distance', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const rows = describeSelection({
      sim,
      level,
      selection: { kind: 'body', index: 0 },
      eventLog: NO_EVENTS,
      observed: NO_OBSERVED,
    });

    expect(rowValue(rows, 'class')).toBe('Star');
    expect(rowValue(rows, 'radius')).toBe(formatKilometres(5e6));
    expect(rowValue(rows, 'period')).toBe(DASH);
    expect(rowValue(rows, 'distance')).toBe(formatKilometres(0));
    expect(rowValue(rows, 'phase')).toBe(formatDegrees(0));
  });

  test('an orbiting body: period matches 2*pi*sqrt(a^3/mu), distance matches periapsis at t=0', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const rows = describeSelection({
      sim,
      level,
      selection: { kind: 'body', index: 1 },
      eventLog: NO_EVENTS,
      observed: NO_OBSERVED,
    });

    const expectedPeriodSeconds = 2 * Math.PI * Math.sqrt((A * A * A) / PRIMARY_MU);
    expect(rowValue(rows, 'class')).toBe('Rock');
    expect(rowValue(rows, 'radius')).toBe(formatKilometres(1e6));
    expect(rowValue(rows, 'period')).toBe(formatDuration(expectedPeriodSeconds));
    expect(rowValue(rows, 'distance')).toBe(formatKilometres(A * (1 - E))); // meanAnomaly0=0 -> periapsis
    expect(rowValue(rows, 'phase')).toBe(formatDegrees(0));
  });
});

describe('describeSelection: rail', () => {
  test('never launched reads ready', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const rows = describeSelection({
      sim,
      level,
      selection: { kind: 'rail', index: 0 },
      eventLog: NO_EVENTS,
      observed: NO_OBSERVED,
    });

    expect(rowValue(rows, 'host')).toBe('Host');
    expect(rowValue(rows, 'angle')).toBe(formatDegrees(0));
    expect(rowValue(rows, 'muzzle')).toBe(
      `${formatKilometresPerSecond(1000)} – ${formatKilometresPerSecond(200_000)}`,
    );
    expect(rowValue(rows, 'cone')).toBe(formatDegrees(Math.PI / 3));
    expect(rowValue(rows, 'reload')).toBe('READY');
  });

  test('mid-reload reads the remaining time, ticks over to ready', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    sim.railLastLaunchTick[0] = 0;
    sim.tick = 30; // 30 of 100 reloadTicks elapsed -> 70 * 30s dt remaining
    const railSelection = { kind: 'rail', index: 0 } as const;
    expect(
      rowValue(
        describeSelection({
          sim,
          level,
          selection: railSelection,
          eventLog: NO_EVENTS,
          observed: NO_OBSERVED,
        }),
        'reload',
      ),
    ).toBe(formatDuration(70 * 30));

    sim.tick = 100;
    expect(
      rowValue(
        describeSelection({
          sim,
          level,
          selection: railSelection,
          eventLog: NO_EVENTS,
          observed: NO_OBSERVED,
        }),
        'reload',
      ),
    ).toBe('READY');
  });
});

const CONTACT_SELECTION = { kind: 'contact', index: 0 } as const;

function describeContactRows(
  sim: ReturnType<typeof createSim>,
  eventLog: readonly SimEvent[],
): ReturnType<typeof describeSelection> {
  return describeSelection({
    sim,
    level,
    selection: CONTACT_SELECTION,
    eventLog,
    observed: NO_OBSERVED,
  });
}

describe('describeSelection: contact', () => {
  test('uncleared: state, closing speed and energy are all unreadable', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const rows = describeContactRows(sim, NO_EVENTS);

    expect(rowValue(rows, 'host')).toBe('Host');
    expect(rowValue(rows, 'capture')).toBe(formatKilometres(20_000));
    expect(rowValue(rows, 'minEnergy')).toBe(formatJoules(1e10));
    expect(rowValue(rows, 'state')).toBe('UNCLEARED');
    expect(rowValue(rows, 'closing')).toBe(DASH);
    expect(rowValue(rows, 'energy')).toBe(DASH);
  });

  // GRV-0032: the true state already clears -- but with no telemetry event in the log, the panel
  // must still read UNCLEARED. This is the leak the unit closes, asserted directly.
  test('the true state already reads cleared, but telemetry has not confirmed it: still reads UNCLEARED', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    sim.contactState.cleared[0] = 1;
    sim.contactState.impactTick[0] = 50;
    sim.contactState.impactSpeed[0] = 15_000;
    sim.contactState.impactEnergy[0] = 2e10;
    const rows = describeContactRows(sim, NO_EVENTS);

    expect(rowValue(rows, 'state')).toBe('UNCLEARED');
    expect(rowValue(rows, 'closing')).toBe(DASH);
    expect(rowValue(rows, 'energy')).toBe(DASH);
  });

  test('confirmed by telemetry: state carries the impact time and a confirmation time, closing speed and energy are readable', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 }); // true state stays untouched --
    // everything the panel shows comes from the event log alone.
    const eventLog: SimEvent[] = [
      {
        tick: 50,
        arrivalTick: 53,
        kind: 'impact',
        probe: 0,
        contact: 0,
        closingSpeed: 15_000,
        impactEnergy: 2e10,
      },
      { tick: 50, arrivalTick: 53, kind: 'cleared', contact: 0 },
    ];
    const rows = describeContactRows(sim, eventLog);

    expect(rowValue(rows, 'state')).toBe(
      `CLEARED AT ${formatSimTime({ tick: 50, dt: 30 })} (confirmed ${formatSimTime({ tick: 53, dt: 30 })})`,
    );
    expect(rowValue(rows, 'closing')).toBe(formatKilometresPerSecond(15_000));
    expect(rowValue(rows, 'energy')).toBe(formatJoules(2e10));
  });

  test('a confirmed impact below the clearing threshold: closing/energy readable, state stays UNCLEARED', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const eventLog: SimEvent[] = [
      {
        tick: 50,
        arrivalTick: 53,
        kind: 'impact',
        probe: 0,
        contact: 0,
        closingSpeed: 900,
        impactEnergy: 5e9,
      },
    ];
    const rows = describeContactRows(sim, eventLog);

    expect(rowValue(rows, 'state')).toBe('UNCLEARED');
    expect(rowValue(rows, 'closing')).toBe(formatKilometresPerSecond(900));
    expect(rowValue(rows, 'energy')).toBe(formatJoules(5e9));
  });
});

const PROBE_SELECTION = { kind: 'probe', index: 0 } as const;

function describeProbeRows({
  sim = createSim({ scenario: scenario(), seed: 1 }),
  eventLog = NO_EVENTS,
  observed,
}: {
  sim?: ReturnType<typeof createSim>;
  eventLog?: readonly SimEvent[];
  observed: ObservedObject | null;
}): ReturnType<typeof describeSelection> {
  return describeSelection({
    sim,
    level,
    selection: PROBE_SELECTION,
    eventLog,
    observed: observed ? [observed] : [],
  });
}

describe('describeSelection: probe', () => {
  test('unlaunched (no entry in the observed view at all): no rows', () => {
    expect(describeProbeRows({ observed: null })).toEqual([]);
  });

  // GRV-0032: materialised (the observed view has an entry) but no telemetry has arrived yet --
  // every field reads DASH, never the true, live state (there is none of that leaking in here:
  // describeProbe never receives a `Sim.objects` in the first place).
  test('observed view entry exists but has no observation yet: every field is unreadable', () => {
    const observed = fakeObserved({
      observation: null,
      predicted: null,
      delaySeconds: NaN,
      presentMass: null,
      dryMass: null,
      exhaustVelocity: null,
    });
    const rows = describeProbeRows({ observed });
    for (const key of ['mass', 'propellant', 'deltaV', 'speed', 'range', 'state', 'observed']) {
      expect(rowValue(rows, key)).toBe(DASH);
    }
  });

  test('flying: mass, propellant, delta-v (independent Math.log oracle), speed, range and observed age all come from the observed view', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const observed = fakeObserved({
      predicted: { x: 2e8, y: 0, vx: 0, vy: 25_000 },
      presentMass: 1000,
      dryMass: 400,
      exhaustVelocity: 3000,
      delaySeconds: 45,
    });
    const rows = describeProbeRows({ sim, observed });

    expect(rowValue(rows, 'mass')).toBe(formatKilograms(1000));
    expect(rowValue(rows, 'propellant')).toBe(formatKilograms(600));
    // Math.log as the independent oracle for the code's own dlog -- any difference is many orders
    // of magnitude below the 2-decimal km/s rounding this shares with the production formatter.
    expect(rowValue(rows, 'deltaV')).toBe(formatKilometresPerSecond(3000 * Math.log(1000 / 400)));
    expect(rowValue(rows, 'speed')).toBe(formatKilometresPerSecond(25_000));

    const eph = {
      x: new Float64Array(sim.bodies.count),
      y: new Float64Array(sim.bodies.count),
      vx: new Float64Array(sim.bodies.count),
      vy: new Float64Array(sim.bodies.count),
    };
    evaluateEphemeris(sim.bodies, 0, eph);
    const contact = contactPoint({
      bodies: sim.bodies,
      contacts: sim.contacts,
      contact: 0,
      t: 0,
      eph,
    });
    const expectedRange = Math.hypot(2e8 - contact.x, 0 - contact.y);
    expect(rowValue(rows, 'range')).toBe(formatKilometres(expectedRange));

    expect(rowValue(rows, 'state')).toBe('FLYING');
    expect(rowValue(rows, 'observed')).toBe(formatDuration(45));
  });

  test('burning (observed.burning, itself already gated by the observation)', () => {
    const observed = fakeObserved({ burning: true });
    expect(rowValue(describeProbeRows({ observed }), 'state')).toBe('BURNING');
  });

  // GRV-0032: the true state already shows the object expended -- but with no matching telemetry
  // event in the log, the panel must still read FLYING (or BURNING). This is the leak the unit
  // closes for STATE, asserted directly (describeProbe never sees `sim.objects.hitContact` at all).
  test('the true state already shows expended, but telemetry has not confirmed it: still reads FLYING', () => {
    const observed = fakeObserved();
    expect(rowValue(describeProbeRows({ observed, eventLog: NO_EVENTS }), 'state')).toBe('FLYING');
  });

  test('confirmed expended on a fixed contact: state carries the event tick and a confirmation time', () => {
    const observed = fakeObserved();
    const eventLog: SimEvent[] = [
      {
        tick: 12,
        arrivalTick: 15,
        kind: 'impact',
        probe: 0,
        contact: 0,
        closingSpeed: 15_000,
        impactEnergy: 2e10,
      },
    ];
    const rows = describeProbeRows({ observed, eventLog });
    expect(rowValue(rows, 'state')).toBe(
      `EXPENDED AT ${formatSimTime({ tick: 12, dt: 30 })} (confirmed ${formatSimTime({ tick: 15, dt: 30 })})`,
    );
  });

  // Unlike before GRV-0032 ("no recorded tick anywhere in Sim, so the state read bare EXPENDED"),
  // a body hit is now a telemetry event too (events.ts), so it carries a tick the same way.
  test('confirmed expended on a body: state carries the event tick and a confirmation time', () => {
    const observed = fakeObserved();
    const eventLog: SimEvent[] = [
      { tick: 12, arrivalTick: 13, kind: 'bodyHit', probe: 0, body: 1 },
    ];
    const rows = describeProbeRows({ observed, eventLog });
    expect(rowValue(rows, 'state')).toBe(
      `EXPENDED AT ${formatSimTime({ tick: 12, dt: 30 })} (confirmed ${formatSimTime({ tick: 13, dt: 30 })})`,
    );
  });

  test('range excludes a confirmed-cleared contact', () => {
    const observed = fakeObserved();
    const eventLog: SimEvent[] = [
      {
        tick: 10,
        arrivalTick: 12,
        kind: 'impact',
        probe: 1,
        contact: 0,
        closingSpeed: 1,
        impactEnergy: 1,
      },
      { tick: 10, arrivalTick: 12, kind: 'cleared', contact: 0 },
    ];
    expect(rowValue(describeProbeRows({ observed, eventLog }), 'range')).toBe(DASH);
  });

  // GRV-0032: the true state already shows the contact cleared -- but with no telemetry event in
  // the log, RANGE must still measure against it (the leak the unit closes for RANGE).
  test('the true state already shows the contact cleared, but telemetry has not confirmed it: range still measures against it', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    sim.contactState.cleared[0] = 1;
    const observed = fakeObserved();
    expect(rowValue(describeProbeRows({ sim, observed, eventLog: NO_EVENTS }), 'range')).not.toBe(
      DASH,
    );
  });
});

describe('selectionName', () => {
  test.each([
    [{ kind: 'body', index: 0 } satisfies Selection, 'Primary'],
    [{ kind: 'body', index: 1 } satisfies Selection, 'Host'],
    [{ kind: 'rail', index: 0 } satisfies Selection, 'Host Rail'],
    [{ kind: 'contact', index: 0 } satisfies Selection, 'Hulk'],
    [{ kind: 'probe', index: 0 } satisfies Selection, 'PRB-01'],
    [{ kind: 'probe', index: 9 } satisfies Selection, 'PRB-10'],
  ])('%j -> %s', (selection, expected) => {
    expect(selectionName({ level, selection: selection as Selection })).toBe(expected);
  });
});

describe('parseSelectionParam', () => {
  test('parses "kind:index"', () => {
    expect(parseSelectionParam('probe:0')).toEqual({ kind: 'probe', index: 0 });
    expect(parseSelectionParam('body:3')).toEqual({ kind: 'body', index: 3 });
  });

  test.each(['nope:0', 'probe:x', 'probe:-1', 'probe', 'probe:0:1'])('rejects %s', (raw) => {
    expect(() => parseSelectionParam(raw)).toThrow();
  });
});
