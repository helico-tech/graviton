// Selection state, picking and readouts (GRV-0023): `pickAt` is pure geometry over a `Frame` and
// a `View` (no `Sim`, so it's testable with a hand-built frame); `describeSelection` reads a live
// `Sim` and the compiled level's names, independently of the renderer (docs/domain/
// simulation-determinism.md rule 11). Math.* is fine here -- tests are exempt from src/sim's
// determinism lint and used deliberately as an independent oracle against the sim's own `dlog`;
// units are built with src/ui/format.ts's own (separately table-tested) formatters, so what's
// under test here is the underlying formula and field selection, not string formatting twice over.
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
      objects: [{ x: 10, y: 0, vx: 0, vy: 0, expended: false }],
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
      objects: [{ x: 10.5, y: 0, vx: 0, vy: 0, expended: false }], // 0.5 px farther than the rail
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
      objects: [{ x: 15, y: 0, vx: 0, vy: 0, expended: false }], // 5 px farther than the rail
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

describe('describeSelection: null selection', () => {
  test('returns no rows', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    expect(describeSelection({ sim, level, selection: null })).toEqual([]);
  });
});

describe('describeSelection: body', () => {
  test('the primary: no orbital period, zero distance', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const rows = describeSelection({ sim, level, selection: { kind: 'body', index: 0 } });

    expect(rowValue(rows, 'class')).toBe('Star');
    expect(rowValue(rows, 'radius')).toBe(formatKilometres(5e6));
    expect(rowValue(rows, 'period')).toBe(DASH);
    expect(rowValue(rows, 'distance')).toBe(formatKilometres(0));
    expect(rowValue(rows, 'phase')).toBe(formatDegrees(0));
  });

  test('an orbiting body: period matches 2*pi*sqrt(a^3/mu), distance matches periapsis at t=0', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const rows = describeSelection({ sim, level, selection: { kind: 'body', index: 1 } });

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
    const rows = describeSelection({ sim, level, selection: { kind: 'rail', index: 0 } });

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
    expect(
      rowValue(describeSelection({ sim, level, selection: { kind: 'rail', index: 0 } }), 'reload'),
    ).toBe(formatDuration(70 * 30));

    sim.tick = 100;
    expect(
      rowValue(describeSelection({ sim, level, selection: { kind: 'rail', index: 0 } }), 'reload'),
    ).toBe('READY');
  });
});

describe('describeSelection: contact', () => {
  test('uncleared: state, closing speed and energy are all unreadable', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    const rows = describeSelection({ sim, level, selection: { kind: 'contact', index: 0 } });

    expect(rowValue(rows, 'host')).toBe('Host');
    expect(rowValue(rows, 'capture')).toBe(formatKilometres(20_000));
    expect(rowValue(rows, 'minEnergy')).toBe(formatJoules(1e10));
    expect(rowValue(rows, 'state')).toBe('UNCLEARED');
    expect(rowValue(rows, 'closing')).toBe(DASH);
    expect(rowValue(rows, 'energy')).toBe(DASH);
  });

  test('cleared: state carries the impact time, closing speed and energy are readable', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    sim.contactState.cleared[0] = 1;
    sim.contactState.impactTick[0] = 50;
    sim.contactState.impactSpeed[0] = 15_000;
    sim.contactState.impactEnergy[0] = 2e10;
    const rows = describeSelection({ sim, level, selection: { kind: 'contact', index: 0 } });

    expect(rowValue(rows, 'state')).toBe(`CLEARED AT ${formatSimTime({ tick: 50, dt: 30 })}`);
    expect(rowValue(rows, 'closing')).toBe(formatKilometresPerSecond(15_000));
    expect(rowValue(rows, 'energy')).toBe(formatJoules(2e10));
  });
});

describe('describeSelection: probe', () => {
  function launchOneProbe(sim: ReturnType<typeof createSim>): void {
    sim.objects.count = 1;
    sim.objects.x[0] = 2e8;
    sim.objects.y[0] = 0;
    sim.objects.vx[0] = 0;
    sim.objects.vy[0] = 25_000;
    sim.objects.mass[0] = 1000;
    sim.objects.dryMass[0] = 400;
    sim.objects.thrust[0] = 500;
    sim.objects.exhaustVelocity[0] = 3000;
    sim.objects.hitBody[0] = -1;
    sim.objects.hitContact[0] = -1;
    sim.objects.burning[0] = 0;
  }

  test('flying: mass, propellant, delta-v (independent Math.log oracle), speed and range', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    launchOneProbe(sim);
    const rows = describeSelection({ sim, level, selection: { kind: 'probe', index: 0 } });

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
  });

  test('burning', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    launchOneProbe(sim);
    sim.objects.burning[0] = 1;
    expect(
      rowValue(describeSelection({ sim, level, selection: { kind: 'probe', index: 0 } }), 'state'),
    ).toBe('BURNING');
  });

  test('expended on a fixed contact: state carries the recorded impact time', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    launchOneProbe(sim);
    sim.objects.hitContact[0] = 0;
    sim.contactState.impactTick[0] = 12;
    expect(
      rowValue(describeSelection({ sim, level, selection: { kind: 'probe', index: 0 } }), 'state'),
    ).toBe(`EXPENDED AT ${formatSimTime({ tick: 12, dt: 30 })}`);
  });

  test('expended on a body surface: no recorded tick, so the state is bare', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    launchOneProbe(sim);
    sim.objects.hitBody[0] = 1;
    expect(
      rowValue(describeSelection({ sim, level, selection: { kind: 'probe', index: 0 } }), 'state'),
    ).toBe('EXPENDED');
  });

  test('range is unreadable once every contact is cleared', () => {
    const sim = createSim({ scenario: scenario(), seed: 1 });
    launchOneProbe(sim);
    sim.contactState.cleared[0] = 1;
    expect(
      rowValue(describeSelection({ sim, level, selection: { kind: 'probe', index: 0 } }), 'range'),
    ).toBe(DASH);
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
