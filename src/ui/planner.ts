// The PLAN panel (GAME-0002 §8, GRV-0026): the draft's own rail, launch time, heading, speed and
// burn nodes, plus Commit/Discard -- disabled with a reason (app.planIssues(), from validatePlan
// and checkLaunch) when the draft cannot yet be committed. DOM assembly only; every field value is
// computed by src/app/src/planner (rule 11: every displayed number comes from the simulation),
// never here. Untestable in this repo's Node-environment Vitest (no DOM, ADR-0002) -- covered by
// tests/e2e/planner.spec.ts instead, matching src/ui/selection.ts's own convention.
//
// GRV-0031 (GAME-0001 §4.4/§4.6): 'amend' mode drops the RAIL/LAUNCH/HEADING/SPEED rows (there is
// no launch to describe -- the probe already exists) in favour of the ISSUE/ARRIVES/CMD HORIZON
// command-horizon readouts, shown in both modes; each node also gets its own STATUS row (LOCKED,
// with the reason, or EDITABLE) once a command horizon exists to judge it against -- the same
// `atTick < commandHorizonTick` test src/app/planner.ts's own `isNodeLocked` and src/render/
// ghost.ts's node rendering already use (rule 11: one source of truth, never re-derived here).
import { formatDegrees, formatKilometresPerSecond } from './format.ts';
import { formatSimTime } from '../app/time.ts';
import { HEADING_TURN } from '../sim/commands.ts';
import type { CommandHorizon, PlannerMode } from '../app/planner.ts';
import type { BurnNode, FlightPlan } from '../planner/plan.ts';

const DASH = '—';
const TWO_PI = Math.PI * 2;
const LOCKED_REASON = 'order cannot arrive in time';

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

function isLocked({
  node,
  mode,
  commandHorizon,
}: {
  node: BurnNode;
  mode: PlannerMode;
  commandHorizon: CommandHorizon | null;
}): boolean {
  return (
    mode === 'amend' && commandHorizon !== null && node.atTick < commandHorizon.commandHorizonTick
  );
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
    mode,
    commandHorizon,
  }: {
    plan: FlightPlan | null;
    railName: string;
    dt: number;
    issues: readonly string[];
    mode: PlannerMode;
    /** GRV-0031: `null` without a draft, or (amend mode) once the amended probe no longer exists. */
    commandHorizon: CommandHorizon | null;
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

  // A draft describes a launch that hasn't happened yet -- rail/heading/speed. An amendment has
  // no launch to describe at all (the probe already exists, plan.ts's own FlightPlan doc: these
  // fields are inert placeholders in amend mode) -- skipped entirely rather than shown as stale.
  if (mode === 'draft') {
    refs.body.append(
      row('RAIL', 'rail', railName || DASH),
      row('LAUNCH', 'launchTime', formatSimTime({ tick: plan.launchTick, dt })),
      row('HEADING', 'heading', formatDegrees((plan.heading * TWO_PI) / HEADING_TURN)),
      row('SPEED', 'speed', formatKilometresPerSecond(plan.speed / 1000)),
    );
  }
  // Command horizon (GAME-0001 §4.6, GRV-0031): where an order sent right now first takes effect
  // -- shown in both modes, from the simulation's own computed values (rule 11), never re-derived.
  if (commandHorizon) {
    refs.body.append(
      row('ISSUE', 'issueTick', formatSimTime({ tick: commandHorizon.issueTick, dt })),
      row('ARRIVES', 'arrivalTick', formatSimTime({ tick: commandHorizon.arrivalTick, dt })),
      row(
        'CMD HORIZON',
        'commandHorizonTick',
        formatSimTime({ tick: commandHorizon.commandHorizonTick, dt }),
      ),
    );
  }
  plan.nodes.forEach((node, index) => {
    const n = index + 1;
    const locked = isLocked({ node, mode, commandHorizon });
    refs.body.append(
      row(`NODE ${n} T`, `node.${index}.time`, formatSimTime({ tick: node.atTick, dt })),
      row(
        `NODE ${n} PRO`,
        `node.${index}.prograde`,
        formatKilometresPerSecond(node.prograde / 1000),
      ),
      row(`NODE ${n} LAT`, `node.${index}.lateral`, formatKilometresPerSecond(node.lateral / 1000)),
    );
    // Locked/editable status only means anything in amend mode (a draft's own nodes are never
    // locked, module header) -- one row per node, "LOCKED, <reason>" or "EDITABLE".
    if (mode === 'amend') {
      refs.body.append(
        row(
          `NODE ${n} STATUS`,
          `node.${index}.status`,
          locked ? `LOCKED, ${LOCKED_REASON}` : 'EDITABLE',
        ),
      );
    }
  });

  const disabled = issues.length > 0;
  refs.issue.hidden = !disabled;
  refs.issue.textContent = disabled ? issues[0]! : '';
  refs.commit.disabled = disabled;
  refs.discard.disabled = false;
}
