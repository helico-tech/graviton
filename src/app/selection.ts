// Selection state, picking and readouts (GRV-0023, GAME-0002 §8, §11). `pickAt` is pure geometry
// over a `Frame`/`View` (the same world->screen camera the renderer uses, camera.ts's
// `worldToScreen`) -- it never touches a live `Sim`. `describeSelection` is the opposite cut:
// every value on the panel is read from `sim` and the ephemeris, never from the renderer or a
// `Frame` (docs/domain/simulation-determinism.md rule 11) -- `src/app/debug-api.ts` is the only
// caller, since a live `Sim` never leaves that module (mirrors `captureFrame`'s own boundary).
import { contactPoint } from '../sim/contacts.ts';
import { evaluateEphemeris, surfacePhase } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { dlog } from '../sim/math/kernels.ts';
import { NEVER_LAUNCHED, railGeometry } from '../sim/rails.ts';
import type { Sim } from '../sim/sim.ts';
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
  frame.objects.forEach((object, index) => consider('probe', index, object.x, object.y));
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

function describeContact({
  sim,
  level,
  index,
}: {
  sim: Sim;
  level: FrameLevelNames;
  index: number;
}): ReadoutRow[] {
  const contacts = sim.contacts;
  const state = sim.contactState;
  const cleared = state.cleared[index] !== 0;
  const impactTick = state.impactTick[index]!;
  const hasImpact = impactTick !== -1;

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
        ? `CLEARED AT ${formatSimTime({ tick: impactTick, dt: sim.scenario.dt })}`
        : 'UNCLEARED',
    },
    {
      key: 'closing',
      label: 'CLOSING',
      value: hasImpact ? formatKilometresPerSecond(state.impactSpeed[index]!) : DASH,
    },
    {
      key: 'energy',
      label: 'ENERGY',
      value: hasImpact ? formatJoules(state.impactEnergy[index]!) : DASH,
    },
  ];
}

/** `state`'s "expended at T+..." reads the *contact's* recorded impact tick when this probe
 *  expended on a fixed contact -- the object record itself carries no tick of its own. A body
 *  surface hit has no tick recorded anywhere in `Sim` (only `hitBody`'s index), so that case reads
 *  bare "EXPENDED": an honest gap in the current state shape, not a renderer estimate, and out of
 *  scope here (YAGNI -- no level in the campaign yet ends a flight against a body). */
function describeProbe({
  sim,
  eph,
  t,
  index,
}: {
  sim: Sim;
  eph: EphemerisOut;
  t: number;
  index: number;
}): ReadoutRow[] {
  const o = sim.objects;
  if (index < 0 || index >= o.count) return [];

  const mass = o.mass[index]!;
  const dryMass = o.dryMass[index]!;
  const deltaV = mass > dryMass ? o.exhaustVelocity[index]! * dlog(mass / dryMass) : 0;

  let nearestRange = Infinity;
  for (let c = 0; c < sim.contacts.count; c++) {
    if (sim.contactState.cleared[c]) continue;
    const point = contactPoint({ bodies: sim.bodies, contacts: sim.contacts, contact: c, t, eph });
    const distance = Math.hypot(o.x[index]! - point.x, o.y[index]! - point.y);
    if (distance < nearestRange) nearestRange = distance;
  }

  const hitContact = o.hitContact[index]!;
  const hitBody = o.hitBody[index]!;
  const state =
    hitContact !== -1
      ? `EXPENDED AT ${formatSimTime({ tick: sim.contactState.impactTick[hitContact]!, dt: sim.scenario.dt })}`
      : hitBody !== -1
        ? 'EXPENDED'
        : o.burning[index]
          ? 'BURNING'
          : 'FLYING';

  return [
    { key: 'mass', label: 'MASS', value: formatKilograms(mass) },
    { key: 'propellant', label: 'PROPELLANT', value: formatKilograms(mass - dryMass) },
    { key: 'deltaV', label: 'DELTA-V', value: formatKilometresPerSecond(deltaV) },
    {
      key: 'speed',
      label: 'SPEED',
      value: formatKilometresPerSecond(Math.hypot(o.vx[index]!, o.vy[index]!)),
    },
    {
      key: 'range',
      label: 'RANGE',
      value: Number.isFinite(nearestRange) ? formatKilometres(nearestRange) : DASH,
    },
    { key: 'state', label: 'STATE', value: state },
  ];
}

/** Every field on the selection panel, computed straight from `sim` (objects, contactState,
 *  railLastLaunchTick, tick, dt), the body/rail/contact tables and the ephemeris -- never from a
 *  `Frame` or the renderer (rule 11). `[]` for a null selection or an out-of-range index (a probe
 *  not yet launched), which the panel reads as "nothing to show" rather than throwing. */
export function describeSelection({
  sim,
  level,
  selection,
}: {
  sim: Sim;
  level: FrameLevelNames;
  selection: Selection;
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
        ? describeContact({ sim, level, index: selection.index })
        : [];
    case 'probe':
      return describeProbe({ sim, eph, t, index: selection.index });
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
