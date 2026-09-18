// The PLAN panel (GAME-0002 §8, GRV-0026): the draft's own rail, launch time, heading, speed and
// burn nodes, plus Commit/Discard -- disabled with a reason (app.planIssues(), from validatePlan
// and checkLaunch) when the draft cannot yet be committed. DOM assembly only; every field value is
// computed by src/app/src/planner (rule 11: every displayed number comes from the simulation),
// never here. Untestable in this repo's Node-environment Vitest (no DOM, ADR-0002) -- covered by
// tests/e2e/planner.spec.ts instead, matching src/ui/selection.ts's own convention.
import { formatDegrees, formatKilometresPerSecond } from './format.ts';
import { formatSimTime } from '../app/time.ts';
import { HEADING_TURN } from '../sim/commands.ts';
import type { FlightPlan } from '../planner/plan.ts';

const DASH = '—';
const TWO_PI = Math.PI * 2;

export interface PlannerRefs {
  element: HTMLElement;
  body: HTMLElement;
  issue: HTMLElement;
  commit: HTMLButtonElement;
  discard: HTMLButtonElement;
}

export function createPlannerPanel(): PlannerRefs {
  const element = document.createElement('section');
  element.className = 'planner-panel';
  const header = document.createElement('h2');
  header.className = 'panel-header';
  header.textContent = 'Plan';
  const body = document.createElement('div');
  body.className = 'selection-rows';
  const issue = document.createElement('p');
  issue.className = 'plan-issue';
  issue.dataset.readout = 'plan.issue';
  issue.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'planner-actions';
  const commit = document.createElement('button');
  commit.type = 'button';
  commit.className = 'instrument-key';
  commit.textContent = 'COMMIT';
  commit.dataset.action = 'plan.commit';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'instrument-key';
  discard.textContent = 'DISCARD';
  discard.dataset.action = 'plan.discard';
  actions.append(commit, discard);

  element.append(header, body, issue, actions);
  return { element, body, issue, commit, discard };
}

function row(label: string, key: string, value: string): HTMLElement {
  const field = document.createElement('div');
  field.className = 'selection-field';
  const labelEl = document.createElement('span');
  labelEl.className = 'field-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'value';
  valueEl.dataset.readout = `plan.${key}`;
  valueEl.textContent = value;
  field.append(labelEl, valueEl);
  return field;
}

/** Instant swap, no animation (GAME-0002 §9): rebuilds the row list from scratch, matching
 *  src/ui/selection.ts's own convention -- a draft's node count changes from render to render. */
export function renderPlanner(
  refs: PlannerRefs,
  {
    plan,
    railName,
    dt,
    issues,
  }: {
    plan: FlightPlan | null;
    railName: string;
    dt: number;
    issues: readonly string[];
  },
): void {
  refs.body.replaceChildren();

  if (!plan) {
    const placeholder = document.createElement('p');
    // Its own class, not `.placeholder` (src/ui/selection.ts's): that class name is asserted as a
    // *singular* match by tests/e2e/selection.spec.ts's "clicking empty space clears the
    // selection", which would break the moment a second panel's own empty state used it too.
    placeholder.className = 'plan-empty';
    placeholder.textContent = 'NO DRAFT';
    refs.body.append(placeholder);
    refs.issue.hidden = true;
    refs.issue.textContent = '';
    refs.commit.disabled = true;
    refs.discard.disabled = true;
    return;
  }

  refs.body.append(
    row('RAIL', 'rail', railName || DASH),
    row('LAUNCH', 'launchTime', formatSimTime({ tick: plan.launchTick, dt })),
    row('HEADING', 'heading', formatDegrees((plan.heading * TWO_PI) / HEADING_TURN)),
    row('SPEED', 'speed', formatKilometresPerSecond(plan.speed / 1000)),
  );
  plan.nodes.forEach((node, index) => {
    const n = index + 1;
    refs.body.append(
      row(`NODE ${n} T`, `node.${index}.time`, formatSimTime({ tick: node.atTick, dt })),
      row(
        `NODE ${n} PRO`,
        `node.${index}.prograde`,
        formatKilometresPerSecond(node.prograde / 1000),
      ),
      row(`NODE ${n} LAT`, `node.${index}.lateral`, formatKilometresPerSecond(node.lateral / 1000)),
    );
  });

  const disabled = issues.length > 0;
  refs.issue.hidden = !disabled;
  refs.issue.textContent = disabled ? issues[0]! : '';
  refs.commit.disabled = disabled;
  refs.discard.disabled = false;
}
