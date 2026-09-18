// The selection panel (GAME-0002 §8, §11): header, then the selected thing's id/name at emphasis
// size, then its label/value rows -- `NO SELECTION` when nothing is picked. DOM assembly only; the
// actual field values come from src/app/selection.ts's `describeSelection`, never computed here
// (rule 11: every displayed number comes from the simulation). Untestable in this repo's
// Node-environment Vitest (no DOM, ADR-0002) -- covered by tests/e2e/selection.spec.ts instead,
// matching src/ui/status.ts and the rest of src/ui's DOM-building modules.
import type { ReadoutRow } from '../app/selection.ts';

export interface SelectionRefs {
  element: HTMLElement;
  name: HTMLElement;
  body: HTMLElement;
}

export function createSelectionPanel(): SelectionRefs {
  const element = document.createElement('aside');
  element.className = 'selection-panel';
  const header = document.createElement('h2');
  header.className = 'panel-header';
  header.textContent = 'Selection';
  const name = document.createElement('p');
  name.className = 'selection-name';
  name.dataset.readout = 'selection.name';
  const body = document.createElement('div');
  body.className = 'selection-rows';
  element.append(header, name, body);
  return { element, name, body };
}

function renderRow(row: ReadoutRow): HTMLElement {
  const field = document.createElement('div');
  field.className = 'selection-field';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = row.label;
  const value = document.createElement('span');
  value.className = 'value';
  value.dataset.readout = `selection.${row.key}`;
  value.textContent = row.value;
  field.append(label, value);
  return field;
}

/** Instant swap, no animation (GAME-0002 §9): every call rebuilds the row list from scratch rather
 *  than diffing, since a selection's whole field set can change kind to kind. */
export function renderSelection(
  refs: SelectionRefs,
  {
    hasSelection,
    name,
    rows,
  }: { hasSelection: boolean; name: string; rows: readonly ReadoutRow[] },
): void {
  refs.body.replaceChildren();
  if (!hasSelection) {
    refs.name.hidden = true;
    refs.name.textContent = '';
    const placeholder = document.createElement('p');
    placeholder.className = 'placeholder';
    placeholder.textContent = 'NO SELECTION';
    refs.body.append(placeholder);
    return;
  }
  refs.name.hidden = false;
  refs.name.textContent = name;
  for (const row of rows) refs.body.append(renderRow(row));
}
