// Selection state, picking and readouts (GRV-0023, GAME-0002 §8, §11). `pickAt` is pure geometry
// over a `Frame`/`View` (the same world->screen camera the renderer uses, camera.ts's
// `worldToScreen`) -- it never touches a live `Sim`. `describeSelection` is the opposite cut:
// every value on the panel is read from `sim`, the ephemeris, the event log and the observed view
// -- never a live object's/contact's true state (GRV-0032, ADR-0007 §6: a contact's/probe's own
// STATE/CLOSING/ENERGY come from `src/app/confirmed.ts`, sourced from the telemetry event log;
// a probe's MASS/PROPELLANT/DELTA-V/SPEED/RANGE come from its observed view, `src/app/observed.ts`
// -- neither `sim.objects` nor `sim.contactState` is read here any more, `src/app/premise.test.ts`
// asserts it) -- `src/app/debug-api.ts` is the only caller, since a live `Sim` never leaves that
// module (mirrors `captureFrame`'s own boundary).
import { contactPoint } from '../sim/contacts.ts';
import { evaluateEphemeris, surfacePhase } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { C, uplinkArrival } from '../sim/lightcone.ts';
import { dlog } from '../sim/math/kernels.ts';
import { postPositionAtTime } from '../sim/post.ts';
import { NEVER_LAUNCHED, railGeometry } from '../sim/rails.ts';
import type { Sim } from '../sim/sim.ts';
import { observedState } from '../sim/telemetry.ts';
import { worldToScreen } from '../render/camera.ts';
import type { View } from '../render/camera.ts';
import type { Frame, FrameLevelNames } from '../render/frame.ts';
import {
  formatDegrees,
  formatDuration,
  formatJoules,
  formatKilograms,
  formatKilometres,
  formatKilometresPerSecond,
} from '../ui/format.ts';
import { confirmedContactState, confirmedProbeState } from './confirmed.ts';
import type { SimEvent } from './events.ts';
import type { ObservedObject } from './observed.ts';
import { formatSimTime } from './time.ts';

export type SelectionKind = 'body' | 'rail' | 'contact' | 'probe';

export interface SelectionTarget {
  readonly kind: SelectionKind;
  readonly index: number;
}

export type Selection = SelectionTarget | null;

export interface ReadoutRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

const DASH = '—';
// Distance-comparison priority, low wins: a probe sits on a rail or a contact more often than
// not, so the thing the player is most likely reaching for wins a near-tie (GRV-0023 acceptance).
const PRIORITY: Record<SelectionKind, number> = { probe: 0, contact: 1, rail: 2, body: 3 };
const TIE_EPSILON_PX = 1;

interface Candidate {
  kind: SelectionKind;
  index: number;
  distance: number;
}

/** The nearest marker to a screen point, within `radiusPx`, using the exact camera the renderer
 *  projects with -- `null` when nothing is close enough (a click on empty space clears). Ties
 *  within `TIE_EPSILON_PX` break toward the higher-priority kind rather than whichever happened
 *  to be nearest to the pixel. */
export function pickAt({
  frame,
  view,
  canvasWidth,
  canvasHeight,
  screenX,
  screenY,
  radiusPx,
}: {
  frame: Frame;
  view: View;
  canvasWidth: number;
  canvasHeight: number;
  screenX: number;
  screenY: number;
  radiusPx: number;
}): Selection {
  const candidates: Candidate[] = [];
  const consider = (kind: SelectionKind, index: number, x: number, y: number): void => {
    const p = worldToScreen({ view, canvasWidth, canvasHeight, x, y });
    const distance = Math.hypot(p.x - screenX, p.y - screenY);
    if (distance <= radiusPx) candidates.push({ kind, index, distance });
  };
  frame.bodies.forEach((body, index) => consider('body', index, body.x, body.y));
  frame.rails.forEach((rail, index) => consider('rail', index, rail.x, rail.y));
  frame.contacts.forEach((contact, index) => consider('contact', index, contact.x, contact.y));
  frame.objects.forEach((object, index) => {
    // Nothing is drawn for an unobserved object (GRV-0030, frame.ts's own doc) -- there is
    // nothing on the plot at (0, 0) for that index to click.
    if (object.observed) consider('probe', index, object.x, object.y);
  });
  if (candidates.length === 0) return null;

  let nearest = candidates[0]!;
  for (const c of candidates) if (c.distance < nearest.distance) nearest = c;

  let winner = nearest;
  for (const c of candidates) {
    if (
      c.distance <= nearest.distance + TIE_EPSILON_PX &&
      PRIORITY[c.kind] < PRIORITY[winner.kind]
    ) {
      winner = c;
    }
  }
  return { kind: winner.kind, index: winner.index };
}

/** The emphasis-size id/name line under the panel header (GAME-0002 §8) -- pure over `level` and
 *  the selection alone, no `Sim` needed: a body/rail/contact's name is the compiled level's own,
 *  a probe has none, so it gets a synthetic `PRB-NN` tag (docs/research/2026-09-03-05's own
 *  convention). */
export function selectionName({
  level,
  selection,
}: {
  level: FrameLevelNames;
  selection: Selection;
}): string {
  if (!selection) return '';
  switch (selection.kind) {
    case 'body':
      return level.names.bodies[selection.index] ?? `body-${selection.index}`;
    case 'rail':
      return level.names.rails[selection.index] ?? `rail-${selection.index}`;
    case 'contact':
      return level.names.contacts[selection.index] ?? `contact-${selection.index}`;
    case 'probe':
      return `PRB-${String(selection.index + 1).padStart(2, '0')}`;
  }
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

function makeEph(count: number): EphemerisOut {
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
  };
}

function describeBody({
  sim,
  level,
  eph,
  t,
  index,
}: {
  sim: Sim;
  level: FrameLevelNames;
  eph: EphemerisOut;
  t: number;
  index: number;
}): ReadoutRow[] {
  const bodies = sim.bodies;
  const isPrimary = bodies.parent[index]! === -1;
  const distance = Math.hypot(eph.x[index]!, eph.y[index]!);
  return [
    { key: 'class', label: 'CLASS', value: capitalize(level.bodyClasses[index] ?? 'rock') },
    { key: 'radius', label: 'RADIUS', value: formatKilometres(bodies.radius[index]!) },
    {
      key: 'period',
      label: 'PERIOD',
      value: isPrimary ? DASH : formatDuration((2 * Math.PI) / bodies.meanMotion[index]!),
    },
    { key: 'distance', label: 'DISTANCE', value: formatKilometres(distance) },
    { key: 'phase', label: 'PHASE', value: formatDegrees(surfacePhase(bodies, index, t)) },
  ];
}

function describeRail({
  sim,
  level,
  eph,
  t,
  index,
}: {
  sim: Sim;
  level: FrameLevelNames;
  eph: EphemerisOut;
  t: number;
  index: number;
}): ReadoutRow[] {
  const rails = sim.rails;
  const geometry = railGeometry({ bodies: sim.bodies, rails, rail: index, t, eph });
  const last = sim.railLastLaunchTick[index]!;
  const remainingTicks =
    last === NEVER_LAUNCHED ? 0 : rails.reloadTicks[index]! - (sim.tick - last);
  const reload = remainingTicks > 0 ? formatDuration(remainingTicks * sim.scenario.dt) : 'READY';

  return [
    { key: 'host', label: 'HOST', value: level.names.bodies[rails.host[index]!] ?? DASH },
    { key: 'angle', label: 'ANGLE', value: formatDegrees(Math.atan2(geometry.uy, geometry.ux)) },
    {
      key: 'muzzle',
      label: 'MUZZLE',
      value: `${formatKilometresPerSecond(rails.muzzleSpeedMin[index]!)} – ${formatKilometresPerSecond(rails.muzzleSpeedMax[index]!)}`,
    },
    { key: 'cone', label: 'CONE', value: formatDegrees(rails.headingCone[index]!) },
    { key: 'reload', label: 'RELOAD', value: reload },
  ];
}

/** STATE/CLOSING/ENERGY read `confirmedContactState` (GRV-0032, `src/app/confirmed.ts`) --
 *  HOST/CAPTURE/MIN ENERGY stay level-compiled constants read straight off `sim.contacts` (the
 *  static `ContactTable`, never delayed -- ADR-0007 rule 12 only covers dynamic state), the one
 *  read of `sim` this function still makes. */
function describeContact({
  sim,
  level,
  eventLog,
  index,
}: {
  sim: Sim;
  level: FrameLevelNames;
  eventLog: readonly SimEvent[];
  index: number;
}): ReadoutRow[] {
  const contacts = sim.contacts;
  const confirmed = confirmedContactState({ eventLog, contact: index });
  const hasImpact = confirmed !== 'uncleared';
  const cleared = hasImpact && confirmed.cleared;

  return [
    { key: 'host', label: 'HOST', value: level.names.bodies[contacts.host[index]!] ?? DASH },
    { key: 'capture', label: 'CAPTURE', value: formatKilometres(contacts.captureRadius[index]!) },
    {
      key: 'minEnergy',
      label: 'MIN ENERGY',
      value: formatJoules(contacts.minimumImpactEnergy[index]!),
    },
    {
      key: 'state',
      label: 'STATE',
      value: cleared
        ? `CLEARED AT ${formatSimTime({ tick: confirmed.impactTick, dt: sim.scenario.dt })} (confirmed ${formatSimTime({ tick: confirmed.arrivalTick, dt: sim.scenario.dt })})`
        : 'UNCLEARED',
    },
    {
      key: 'closing',
      label: 'CLOSING',
      value: hasImpact ? formatKilometresPerSecond(confirmed.closingSpeed) : DASH,
    },
    {
      key: 'energy',
      label: 'ENERGY',
      value: hasImpact ? formatJoules(confirmed.impactEnergy) : DASH,
    },
  ];
}

const UNOBSERVED_PROBE_ROWS: ReadoutRow[] = [
  { key: 'mass', label: 'MASS', value: DASH },
  { key: 'propellant', label: 'PROPELLANT', value: DASH },
  { key: 'deltaV', label: 'DELTA-V', value: DASH },
  { key: 'speed', label: 'SPEED', value: DASH },
  { key: 'range', label: 'RANGE', value: DASH },
  { key: 'state', label: 'STATE', value: DASH },
  { key: 'observed', label: 'OBSERVED', value: DASH },
];

/** Every field here is the post's own picture, never the live probe (GRV-0032, ADR-0007 §5-6):
 *  MASS/PROPELLANT/DELTA-V/SPEED come from `observed`'s own predicted present (`src/app/
 *  observed.ts`), RANGE from the same predicted position against every contact `confirmedContact
 *  State` doesn't yet show cleared, and STATE from `confirmedProbeState` (`src/app/confirmed.ts`)
 *  layering BURNING on top from `observed.burning` -- already gated the same delayed way. `sim` is
 *  read only for the static `bodies`/`contacts` tables (ephemeris, contact geometry) and `dt`,
 *  never `sim.objects`/`sim.contactState`. `index` not existing in `observed` at all (never
 *  launched) draws nothing, matching the old out-of-range-index contract. */
function describeProbe({
  sim,
  eph,
  t,
  eventLog,
  observed,
  index,
}: {
  sim: Sim;
  eph: EphemerisOut;
  t: number;
  eventLog: readonly SimEvent[];
  observed: ObservedObject | null;
  index: number;
}): ReadoutRow[] {
  if (!observed) return [];
  if (!observed.observation) return UNOBSERVED_PROBE_ROWS;

  const mass = observed.presentMass!;
  const dryMass = observed.dryMass!;
  const exhaustVelocity = observed.exhaustVelocity!;
  const deltaV = mass > dryMass ? exhaustVelocity * dlog(mass / dryMass) : 0;
  const predicted = observed.predicted!;

  let nearestRange = Infinity;
  for (let c = 0; c < sim.contacts.count; c++) {
    const confirmed = confirmedContactState({ eventLog, contact: c });
    if (confirmed !== 'uncleared' && confirmed.cleared) continue;
    const point = contactPoint({ bodies: sim.bodies, contacts: sim.contacts, contact: c, t, eph });
    const distance = Math.hypot(predicted.x - point.x, predicted.y - point.y);
    if (distance < nearestRange) nearestRange = distance;
  }

  const dt = sim.scenario.dt;
  const confirmedProbe = confirmedProbeState({ eventLog, observed, probe: index });
  const state =
    confirmedProbe === 'unobserved'
      ? DASH
      : confirmedProbe === 'flying'
        ? observed.burning
          ? 'BURNING'
          : 'FLYING'
        : `EXPENDED AT ${formatSimTime({ tick: confirmedProbe.expendedTick, dt })} (confirmed ${formatSimTime({ tick: confirmedProbe.confirmedTick, dt })})`;

  return [
    { key: 'mass', label: 'MASS', value: formatKilograms(mass) },
    { key: 'propellant', label: 'PROPELLANT', value: formatKilograms(mass - dryMass) },
    { key: 'deltaV', label: 'DELTA-V', value: formatKilometresPerSecond(deltaV) },
    {
      key: 'speed',
      label: 'SPEED',
      value: formatKilometresPerSecond(Math.hypot(predicted.vx, predicted.vy)),
    },
    {
      key: 'range',
      label: 'RANGE',
      value: Number.isFinite(nearestRange) ? formatKilometres(nearestRange) : DASH,
    },
    { key: 'state', label: 'STATE', value: state },
    { key: 'observed', label: 'OBSERVED', value: formatDuration(observed.delaySeconds) },
  ];
}

/** One-way delay to `selection`, in seconds (GAME-0002 §8's status bar `DELAY`, "the four numbers
 *  that never move"): a probe's own last observation (telemetry.ts), the uplink delay to a rail's
 *  host (sim/lightcone.ts's own `uplinkArrival`, "an order sent now"), a straight-line geometric
 *  estimate for a contact (ADR-0007 §1's post/rail treatment doesn't cover contacts -- they carry
 *  no history ring to downlink from, and no command is ever *sent* to one, so there is no light-
 *  cone tick to solve for the way there is for a rail; a contact's ephemeris is fully deterministic
 *  the same way a rail's is, so the geometric distance-over-`C` this reduces to is exact to within
 *  the same rounding a Newton-refined solve would give, since -- unlike a probe -- nothing about a
 *  contact needs predicting), or `null` for a body (rule 12: bodies carry no delay at all). */
export function delayToSelection({
  sim,
  selection,
}: {
  sim: Sim;
  selection: Selection;
}): number | null {
  if (!selection) return null;
  const dt = sim.scenario.dt;
  switch (selection.kind) {
    case 'body':
      return null;
    case 'rail': {
      if (selection.index < 0 || selection.index >= sim.rails.count) return null;
      const arrivalTick = uplinkArrival({
        sim,
        target: { kind: 'rail', rail: selection.index },
        issueTick: sim.tick,
      });
      return (arrivalTick - sim.tick) * dt;
    }
    case 'contact': {
      if (selection.index < 0 || selection.index >= sim.contacts.count) return null;
      const t = sim.tick * dt;
      const eph = makeEph(sim.bodies.count);
      evaluateEphemeris(sim.bodies, t, eph);
      const point = contactPoint({
        bodies: sim.bodies,
        contacts: sim.contacts,
        contact: selection.index,
        t,
        eph,
      });
      const post = postPositionAtTime({ sim, t });
      return Math.hypot(point.x - post.x, point.y - post.y) / C;
    }
    case 'probe': {
      const observed = observedState({ sim, object: selection.index, atTick: sim.tick });
      return observed ? observed.delaySeconds : null;
    }
  }
}

/** Every field on the selection panel: body/rail read `sim`'s static/analytic tables and the
 *  ephemeris (never delayed, rule 12); contact/probe STATE (and a contact's CLOSING/ENERGY, a
 *  probe's MASS/PROPELLANT/DELTA-V/SPEED/RANGE) come from `eventLog`/`observed` instead (GRV-0032)
 *  -- never from a `Frame`, the renderer, or a dynamic object's/contact's true state (rule 11).
 *  `[]` for a null selection or an out-of-range index (a probe not yet launched), which the panel
 *  reads as "nothing to show" rather than throwing. */
export function describeSelection({
  sim,
  level,
  selection,
  eventLog,
  observed,
}: {
  sim: Sim;
  level: FrameLevelNames;
  selection: Selection;
  eventLog: readonly SimEvent[];
  observed: readonly ObservedObject[];
}): ReadoutRow[] {
  if (!selection) return [];
  const t = sim.tick * sim.scenario.dt;
  const eph = makeEph(sim.bodies.count);
  evaluateEphemeris(sim.bodies, t, eph);

  switch (selection.kind) {
    case 'body':
      return selection.index >= 0 && selection.index < sim.bodies.count
        ? describeBody({ sim, level, eph, t, index: selection.index })
        : [];
    case 'rail':
      return selection.index >= 0 && selection.index < sim.rails.count
        ? describeRail({ sim, level, eph, t, index: selection.index })
        : [];
    case 'contact':
      return selection.index >= 0 && selection.index < sim.contacts.count
        ? describeContact({ sim, level, eventLog, index: selection.index })
        : [];
    case 'probe':
      return describeProbe({
        sim,
        eph,
        t,
        eventLog,
        observed: observed[selection.index] ?? null,
        index: selection.index,
      });
  }
}

const SELECTION_KINDS: readonly SelectionKind[] = ['body', 'rail', 'contact', 'probe'];

function isSelectionKind(value: string): value is SelectionKind {
  return (SELECTION_KINDS as readonly string[]).includes(value);
}

/** Parses the `?select=<kind>:<index>` URL param and `pnpm render --select <kind>:<index>` flag
 *  -- one format, shared rather than reimplemented per caller. Throws on malformed input, matching
 *  this repo's other flag parsers (e.g. src/headless/render.ts's parseRenderFlags). */
export function parseSelectionParam(raw: string): SelectionTarget {
  const parts = raw.split(':');
  if (parts.length !== 2)
    throw new Error(`parseSelectionParam: expected "kind:index", got "${raw}"`);
  const [kindRaw, indexRaw] = parts as [string, string];
  if (!isSelectionKind(kindRaw)) throw new Error(`parseSelectionParam: unknown kind "${kindRaw}"`);
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0)
    throw new Error(`parseSelectionParam: index must be a non-negative integer, got "${indexRaw}"`);
  return { kind: kindRaw, index };
}
