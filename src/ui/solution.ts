// The SOLUTION panel (GAME-0002 §8, GRV-0026): the ghost's own readout (src/planner/readout.ts)
// -- closest approach, miss distance, arrival speed, time of flight, delta-v remaining, impact
// energy, clears. Reports on the "primary" contact -- the earliest one the ghost impacted, else
// whichever it came closest to -- mirroring readout.ts's own (unexported) primaryContact, since
// every field but arrivalSpeed is per-contact there and this panel shows one line per field
// (EPIC-06's own scope: one fixed contact per level; a wave across several is a later epic).
import {
  formatDuration,
  formatJoules,
  formatKilometres,
  formatKilometresPerSecond,
} from './format.ts';
import { formatSimTime } from '../app/time.ts';
import type { SolutionReadout } from '../planner/readout.ts';

const DASH = '—';

export interface SolutionRefs {
  element: HTMLElement;
  body: HTMLElement;
}

export function createSolutionPanel(): SolutionRefs {
  const element = document.createElement('section');
  element.className = 'solution-panel';
  const header = document.createElement('h2');
  header.className = 'panel-header';
  header.textContent = 'Solution';
  const body = document.createElement('div');
  body.className = 'selection-rows';
  element.append(header, body);
  return { element, body };
}

function row(label: string, key: string, value: string): HTMLElement {
  const field = document.createElement('div');
  field.className = 'selection-field';
  const labelEl = document.createElement('span');
  labelEl.className = 'field-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'value';
  valueEl.dataset.readout = `solution.${key}`;
  valueEl.textContent = value;
  field.append(labelEl, valueEl);
  return field;
}

/** The contact to report on: the earliest one the ghost impacted, else whichever it came closest
 *  to overall -- readout.ts's own primaryContact, restated here since that helper isn't exported
 *  (it stays private to how `arrivalSpeed` itself is computed). */
function primaryContact(readout: SolutionReadout): number | null {
  let bestImpact: { contact: number; tick: number } | null = null;
  for (let i = 0; i < readout.contacts.length; i++) {
    const tick = readout.contacts[i]!.impactTick;
    if (tick !== undefined && (bestImpact === null || tick < bestImpact.tick)) {
      bestImpact = { contact: i, tick };
    }
  }
  if (bestImpact) return bestImpact.contact;

  let best: { contact: number; distance: number } | null = null;
  for (let i = 0; i < readout.contacts.length; i++) {
    const contact = readout.contacts[i]!;
    if (contact.closestTick === -1) continue;
    if (best === null || contact.closestApproach < best.distance) {
      best = { contact: i, distance: contact.closestApproach };
    }
  }
  return best?.contact ?? null;
}

/** Instant swap, no animation (GAME-0002 §9), matching src/ui/planner.ts's own convention. */
export function renderSolution(
  refs: SolutionRefs,
  { readout, dt }: { readout: SolutionReadout | null; dt: number },
): void {
  refs.body.replaceChildren();

  if (!readout) {
    const placeholder = document.createElement('p');
    // Its own class, not `.placeholder` -- see src/ui/planner.ts's own note on why.
    placeholder.className = 'solution-empty';
    placeholder.textContent = 'NO SOLUTION';
    refs.body.append(placeholder);
    return;
  }

  const contactIndex = primaryContact(readout);
  const contact = contactIndex !== null ? readout.contacts[contactIndex]! : null;

  refs.body.append(
    row(
      'PCA',
      'closestApproach',
      contact && contact.closestTick !== -1
        ? formatSimTime({ tick: contact.closestTick, dt })
        : DASH,
    ),
    row(
      'MISS',
      'missDistance',
      contact && Number.isFinite(contact.closestApproach)
        ? formatKilometres(contact.closestApproach)
        : DASH,
    ),
    row('ARRIVAL', 'arrivalSpeed', formatKilometresPerSecond(readout.arrivalSpeed)),
    row('T.O.F.', 'timeOfFlight', formatDuration(readout.timeOfFlight)),
    row('DELTA-V', 'deltaVRemaining', formatKilometresPerSecond(readout.deltaVRemaining)),
    row(
      'IMPACT E',
      'impactEnergy',
      contact?.impactEnergy !== undefined ? formatJoules(contact.impactEnergy) : DASH,
    ),
    row('CLEARS', 'clears', contact ? (contact.cleared ? 'YES' : 'NO') : DASH),
  );
}
