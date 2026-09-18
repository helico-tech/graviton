// Planner state (EPIC-06, GRV-0026, GAME-0001 §4.4-4.6, §4.11; docs/work/GRV-0026-planner-
// overlay.md): the draft FlightPlan the player is editing, the active drag (a launch vector off a
// rail, or a burn node's prograde/lateral handle), which node is selected, an explicit horizon
// tick for scrubbing, and the ghost it integrates to (src/planner/ghost.ts -- the live
// simulation's own step function, never a separate model; src/planner/** stays untouched here,
// only called). DOM-free and pure: every transition takes the current state and returns a new
// one, so src/ui/plot.ts's real pointer/keyboard input and the debug API drive it identically
// (ADR-0004 §1). `reintegrate` is the one transition that touches the simulation's own code path
// (via src/planner/ghost.ts); every other transition is arithmetic over the draft alone.
import { advance, checkBurn, checkLaunch, createSim } from '../sim/sim.ts';
import type { BurnRejection, Command, LaunchRejection, Sim } from '../sim/sim.ts';
import { createBodyTable, evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { createRailTable, railGeometry } from '../sim/rails.ts';
import { issueTickFor, uplinkArrival } from '../sim/lightcone.ts';
import { integrateGhost } from '../planner/ghost.ts';
import type { Ghost, GhostCache } from '../planner/ghost.ts';
import { diffAmendmentNodes, existingNodesForProbe, validatePlan } from '../planner/plan.ts';
import type { BurnNode, FlightPlan } from '../planner/plan.ts';
import { quantizeHeading, quantizeSpeed } from '../levels/solve.ts';
import type { CompiledLevel } from './levels.ts';

// A ghost's sample buffer is `horizonTick - fromTick + 1` long (ghost.ts); this bounds it for a
// plan launched "now" against the longest campaign flight seen so far (L01-intercept's committed
// solution flies ~3300 ticks, docs/evidence/GRV-0025/README.md) with generous headroom for a
// player-drafted trajectory that never clears -- the ghost simply stops early on an impact or a
// body hit (runLoop, ghost.ts), so a larger horizon than a flight needs costs nothing but buffer
// size, never wall time.
export const GHOST_HORIZON_TICKS = 20000;

// The launch drag's speed mapping (GAME-0001 §4.2, design note): a fixed on-screen reference
// length, converted to world metres by the camera's own metresPerPixel, so the drag "feels" the
// same regardless of zoom -- dragging this many pixels off the rail reaches the muzzle's top
// speed.
const LAUNCH_DRAG_REFERENCE_PX = 160;

// The node handle's linear mm/s mapping: this many screen pixels represents this many m/s of
// delta-v, again converted to world metres by metresPerPixel so a handle drag feels the same at
// any zoom. Delta-v handles are linear, not logarithmic like the launch band above -- a burn has
// no natural multiplicative range the way a muzzle band does.
const NODE_HANDLE_REFERENCE_PX = 120;
const NODE_HANDLE_REFERENCE_MPS = 200;

const MM_PER_M = 1000;
const INT32_MAX = 0x7fffffff;

// A freshly placed node needs *some* nonzero component: commands.ts's applyBurn rejects a burn
// whose prograde and lateral are both exactly zero (it would have no direction to freeze). One
// mm/s prograde is the smallest valid, effectively negligible burn -- the player drags the handle
// to set a real magnitude from there.
const DEFAULT_NODE_PROGRADE_MM_PER_S = 1;

export interface LaunchDrag {
  readonly kind: 'launch';
  readonly rail: number;
  /** The drag's current world-space endpoint, carried on the drag itself so the renderer can draw
   *  the live launch-vector preview (src/render/ghost.ts) without re-deriving it from the
   *  quantised heading/speed the draft already committed to. */
  readonly worldX: number;
  readonly worldY: number;
}

export interface NodeDrag {
  readonly kind: 'node';
  readonly index: number;
  readonly handle: 'prograde' | 'lateral';
  readonly worldX: number;
  readonly worldY: number;
}

export type Drag = LaunchDrag | NodeDrag;

/** 'draft' plans a fresh launch; 'amend' revises an already-flying probe's plan (GRV-0031,
 *  GAME-0001 §4.4 "amendable only if its activation time is later than the moment an order sent
 *  now would reach the probe"). */
export type PlannerMode = 'draft' | 'amend';

/** Where an order sent right now first takes effect (GAME-0001 §4.6 "command horizon", ADR-0007
 *  §2-3, GRV-0031): for a draft, `issueTick`/`arrivalTick` are the launch's own -- the earliest the
 *  probe can exist at all, so nothing can be commanded before `arrivalTick` either, hence
 *  `commandHorizonTick === arrivalTick`. For an amendment, `issueTick` is simply `now` (an order to
 *  an already-flying probe needs no launch of its own) and `arrivalTick`/`commandHorizonTick` are
 *  both the uplink arrival of an order sent now -- kept as two fields for a uniform PLAN-panel
 *  shape across both modes rather than a genuine second number. */
export interface CommandHorizon {
  readonly issueTick: number;
  readonly arrivalTick: number;
  readonly commandHorizonTick: number;
}

export interface PlannerState {
  readonly draft: FlightPlan | null;
  readonly mode: PlannerMode;
  /** The object index being amended, `null` in 'draft' mode. */
  readonly amendProbe: number | null;
  /** The observation tick the amendment plans against (src/app/observed.ts's own last-observation
   *  tick at the moment amendment mode was entered), fixed for the whole session -- "the post plans
   *  on what it knows," never the true state (module header). `null` in 'draft' mode. */
  readonly amendObservationTick: number | null;
  /** The amended probe's own nodes already committed at the moment amendment mode was entered
   *  (`existingNodesForProbe`, src/planner/plan.ts), filtered to `atTick >= nowTick` at that
   *  instant (an already-fired node is history, not part of the plan going forward) -- the
   *  reference `beginNodeDrag`/`removeNode` check "is this node one I can't cancel" against, and
   *  `reintegrate`/`commitPlan` diff `draft.nodes` against to find what actually needs sending.
   *  `[]` in 'draft' mode. */
  readonly amendExistingNodes: readonly BurnNode[];
  readonly drag: Drag | null;
  /** Explicit horizon tick for the timeline scrub (GAME-0001 §4.6 "horizon scrub"); `null` is
   *  "the present" -- nothing in the simulation moves because of this field, it only changes what
   *  tick the plot is drawn at (src/render/frame.ts's captureFrame, extended to take an explicit
   *  time). Unrelated to `commandHorizon` below despite the shared name -- this one is a scrub
   *  position, that one a simulated quantity (GRV-0031 keeps the two apart deliberately: `App`
   *  exposes them as `horizon()`/`commandHorizon()`, two different methods). */
  readonly horizon: number | null;
  readonly ghost: Ghost | null;
  readonly cache: GhostCache | undefined;
  /** The node whose handles are drawn and whose Delete/drag target the keyboard acts on --
   *  persists past the end of a drag (unlike `drag` itself), set by clicking a node marker or by
   *  starting a drag on one. Not part of the design note's literal state tuple; added because
   *  "handles only for the selected/dragged node" and "Delete removes the selected node" both need
   *  a selection that outlives the drag gesture itself -- flagged in the unit's evidence rather
   *  than folded in silently. */
  readonly selectedNode: number | null;
  /** Every reason the draft currently integrates to no ghost, computed by `reintegrate` alongside
   *  the (possibly null) ghost so the PLAN panel can show why without re-deriving anything itself
   *  (determinism rule 11: every displayed number originates in the simulation, not a second
   *  model): `validatePlan`'s own shape issues (node budget, sortedness, integer-ness, a node
   *  whose `atTick` no longer clears the -- possibly just re-snapped -- launch tick) checked
   *  first, generalising the design note's "outside the cone or band the ghost is not drawn and
   *  the reason is shown" to cover a malformed plan the same way (GRV-0028, docs/issues/2026-09-
   *  18-reintegrate-skips-validate-plan.md); or, if the shape is fine, a single human-readable
   *  line naming `checkLaunch`'s own rejection (capacity, reload, band, cone) in 'draft' mode, or
   *  `checkBurn`'s own rejection (locked, occluded) per amended node in 'amend' mode. Empty exactly
   *  when the draft is valid and its ghost is current. */
  readonly issues: readonly string[];
  /** `reintegrate`'s own computed command horizon (GRV-0031), alongside `ghost`/`issues` for the
   *  same "one source of truth" reason -- `null` without a draft or an amended probe that still
   *  exists. */
  readonly commandHorizon: CommandHorizon | null;
}

export function createPlannerState(): PlannerState {
  return {
    draft: null,
    mode: 'draft',
    amendProbe: null,
    amendObservationTick: null,
    amendExistingNodes: [],
    drag: null,
    horizon: null,
    ghost: null,
    cache: undefined,
    selectedNode: null,
    issues: [],
    commandHorizon: null,
  };
}

function makeEph(count: number): EphemerisOut {
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
  };
}

/** Mirrors src/planner/plan.ts's own (unexported) nodeBudget: burnNodeCapacity is always
 *  count * nodeBudget for the level's one probe type (levels/compile.ts's buildScenario), so this
 *  small formula is worth restating here rather than exporting a name from a module this unit
 *  must leave untouched. */
function nodeBudget(level: CompiledLevel): number {
  return level.scenario.burnNodeCapacity / level.scenario.capacity;
}

/** Replaces the draft's own data outright (debug API's own `setPlan`, a way to construct a
 *  specific plan without a drag gesture) -- deliberately mode-preserving: called while amending
 *  (GRV-0031) it stays in 'amend' mode with the same `amendProbe`/`amendExistingNodes`, letting a
 *  test drive the plan through the debug API instead of a real pointer drag; called from fresh
 *  (mode already 'draft', `createPlannerState`'s own default) it is exactly the old behaviour.
 *  `beginLaunchDrag`/`beginAmend` are the actual mode transitions -- this never is one. */
export function setPlan({ state, plan }: { state: PlannerState; plan: FlightPlan }): PlannerState {
  return { ...state, draft: plan, drag: null, selectedNode: null };
}

export function discardDraft(state: PlannerState): PlannerState {
  return {
    ...state,
    draft: null,
    mode: 'draft',
    amendProbe: null,
    amendObservationTick: null,
    amendExistingNodes: [],
    drag: null,
    ghost: null,
    cache: undefined,
    selectedNode: null,
    issues: [],
    commandHorizon: null,
  };
}

/** Opens `probe`'s plan for amendment (GAME-0001 §4.4, GRV-0031): the draft becomes the probe's own
 *  existing nodes (`existingNodesForProbe`, src/planner/plan.ts) filtered to what is still ahead of
 *  `nowTick` -- an already-fired node is history, not part of the plan going forward, and never
 *  shown. `rail`/`heading`/`speed`/`launchTick` on the resulting `FlightPlan` are never read in
 *  amend mode (`integrateGhost`'s own amend path ignores them, ghost.ts module header) but carry
 *  the probe's real launch command's own values anyway, found in `log`, so nothing in the shared
 *  shape is ever a meaningless placeholder. A no-op (returns `state` unchanged) if `probe` was
 *  never launched in `log` at all -- the caller (app.ts's own `N`/`amend()` wiring) is expected to
 *  gate this on an actual flying-probe selection first. */
export function beginAmend({
  state,
  log,
  probe,
  nowTick,
  observationTick,
}: {
  state: PlannerState;
  log: readonly Command[];
  probe: number;
  nowTick: number;
  observationTick: number;
}): PlannerState {
  // A launch command doesn't itself carry its own object index (planToCommands/commitAmendment
  // never store one either) -- pinning down *which* launch created `probe` would mean re-deriving
  // materialisation order from the whole log (plan.ts's own documented "known limitation" for
  // concurrent launches). Not needed here: the resulting FlightPlan's rail/heading/speed fields are
  // inert in amend mode regardless (module header above), so any real launch command in the log is
  // a fine, honest placeholder -- the one real requirement is that `probe` has actually flown at
  // all, i.e. the log contains at least one launch.
  const anyLaunch = log.find((c): c is Extract<Command, { kind: 'launch' }> => c.kind === 'launch');
  if (!anyLaunch) return state;

  const existing = existingNodesForProbe({ log, probe }).filter((n) => n.atTick >= nowTick);
  const draft: FlightPlan = {
    rail: anyLaunch.rail,
    launchTick: anyLaunch.tick,
    heading: anyLaunch.heading,
    speed: anyLaunch.speed,
    nodes: existing.map((n) => ({ ...n })),
  };

  return {
    ...state,
    draft,
    mode: 'amend',
    amendProbe: probe,
    amendObservationTick: observationTick,
    amendExistingNodes: existing,
    drag: null,
    selectedNode: null,
  };
}

export function beginLaunchDrag({
  state,
  rail,
  worldX,
  worldY,
}: {
  state: PlannerState;
  rail: number;
  worldX: number;
  worldY: number;
}): PlannerState {
  return {
    ...state,
    mode: 'draft',
    amendProbe: null,
    amendObservationTick: null,
    amendExistingNodes: [],
    drag: { kind: 'launch', rail, worldX, worldY },
  };
}

/** The rail's own muzzle point and local vertical at `t`, the geometric anchor the launch drag's
 *  heading (absolute, the vector from this point) and speed band (this rail's own muzzleSpeedMin/
 *  Max) are both read against -- a plain BodyTable/RailTable query, never a full Sim: geometry
 *  depends only on `scenario` and `t`, not on committed history (rails.ts, ephemeris/bodies.ts). */
function currentRailGeometry({
  level,
  rail,
  t,
}: {
  level: CompiledLevel;
  rail: number;
  t: number;
}): { x: number; y: number } {
  const bodies = createBodyTable(level.scenario.bodies);
  const rails = createRailTable(level.scenario.rails, bodies);
  const eph = makeEph(bodies.count);
  evaluateEphemeris(bodies, t, eph);
  return railGeometry({ bodies, rails, rail, t, eph });
}

/** Heading (absolute, quantised to 1/2^32 turn) and speed (quantised to mm/s, mapped
 *  logarithmically across the rail's muzzle band by the drag's screen-relative length) for a
 *  launch drag whose current world endpoint is `(worldX, worldY)`, anchored at the rail's own
 *  muzzle point at `t` (design note: "heading = angle of the vector from the rail's surface
 *  point... speed = muzzleMin*(muzzleMax/muzzleMin)^(clamp(len/L, 0, 1))"). */
function launchDraftFrom({
  level,
  rail,
  worldX,
  worldY,
  launchTick,
  metresPerPixel,
}: {
  level: CompiledLevel;
  rail: number;
  worldX: number;
  worldY: number;
  launchTick: number;
  metresPerPixel: number;
}): { heading: number; speed: number } {
  const t = launchTick * level.scenario.dt;
  const origin = currentRailGeometry({ level, rail, t });
  const dx = worldX - origin.x;
  const dy = worldY - origin.y;
  const len = Math.hypot(dx, dy);
  const heading = quantizeHeading(len > 0 ? Math.atan2(dy, dx) : 0);

  const railDef = level.scenario.rails[rail]!;
  const worldReference = LAUNCH_DRAG_REFERENCE_PX * metresPerPixel;
  const fraction = worldReference > 0 ? Math.min(1, Math.max(0, len / worldReference)) : 0;
  const band = railDef.muzzleSpeedMax / railDef.muzzleSpeedMin;
  const speedMps = railDef.muzzleSpeedMin * band ** fraction;
  const speed = quantizeSpeed(speedMps);

  return { heading, speed };
}

/** Updates the draft's rail/heading/speed from the drag's live endpoint, launching "now" (the
 *  next tick after `tick`, the caller's own current sim tick) -- recomputed on every call, so the
 *  rail's own rotation (GAME-0001 §4.2's launch-window phase) is read fresh each frame the drag
 *  runs, matching "time may keep running while planning". Existing nodes on the same rail's draft
 *  are preserved across a re-drag (their atTick/prograde/lateral are independent of the launch
 *  vector); a drag starting a brand-new plan (or switching rails) begins with none. */
export function updateLaunchDrag({
  state,
  level,
  worldX,
  worldY,
  tick,
  metresPerPixel,
}: {
  state: PlannerState;
  level: CompiledLevel;
  worldX: number;
  worldY: number;
  tick: number;
  metresPerPixel: number;
}): PlannerState {
  if (!state.drag || state.drag.kind !== 'launch') return state;
  const rail = state.drag.rail;
  const launchTick = tick + 1;
  const { heading, speed } = launchDraftFrom({
    level,
    rail,
    worldX,
    worldY,
    launchTick,
    metresPerPixel,
  });

  const nodes = state.draft && state.draft.rail === rail ? state.draft.nodes : [];
  const draft: FlightPlan = { rail, launchTick, heading, speed, nodes };
  return { ...state, draft, drag: { kind: 'launch', rail, worldX, worldY } };
}

export function endDrag(state: PlannerState): PlannerState {
  return { ...state, drag: null };
}

export function selectNode({
  state,
  index,
}: {
  state: PlannerState;
  index: number | null;
}): PlannerState {
  if (index !== null && (!state.draft || index < 0 || index >= state.draft.nodes.length))
    return state;
  return { ...state, selectedNode: index };
}

/** A node is locked (GAME-0001 §4.4, GAME-0002 §4/§7, GRV-0031) once its own activation time is
 *  earlier than the moment an order sent now would reach the probe -- `commandHorizonTick`, only
 *  meaningful in 'amend' mode (a draft's own nodes are never locked; the whole plan is one
 *  transmission that hasn't gone out yet, plan.ts's own "same issue batch"). */
export function isNodeLocked({ state, node }: { state: PlannerState; node: BurnNode }): boolean {
  return state.mode === 'amend' && node.atTick < (state.commandHorizon?.commandHorizonTick ?? 0);
}

/** Places a node at `tick` (design note "click on the ghost path... adds a node at the nearest
 *  sample tick"), sorted into position, a no-op if there is no draft or the level's per-probe node
 *  budget (levels/compile.ts) is already spent. In 'draft' mode the tick must be later than the
 *  launch; in 'amend' mode it must be at or after the command horizon (GRV-0031: "new nodes only
 *  after it") -- refused with an issue string rather than silently, since the player's click landed
 *  somewhere real on the ghost path and deserves a reason. Selects the new node so its handles are
 *  immediately visible for fine-tuning. */
export function addNode({
  state,
  level,
  tick,
}: {
  state: PlannerState;
  level: CompiledLevel;
  tick: number;
}): PlannerState {
  if (!state.draft) return state;
  if (state.mode === 'amend') {
    const horizonTick = state.commandHorizon?.commandHorizonTick;
    if (horizonTick === undefined || tick < horizonTick) {
      return {
        ...state,
        issues: ['new node before the command horizon: order cannot arrive in time'],
      };
    }
  } else if (tick <= state.draft.launchTick) {
    return state;
  }
  if (state.draft.nodes.length >= nodeBudget(level)) return state;

  const node: BurnNode = { atTick: tick, prograde: DEFAULT_NODE_PROGRADE_MM_PER_S, lateral: 0 };
  const nodes = [...state.draft.nodes, node].sort((a, b) => a.atTick - b.atTick);
  const index = nodes.indexOf(node);
  return { ...state, draft: { ...state.draft, nodes }, selectedNode: index };
}

/** In 'amend' mode, an existing (already-committed) node cannot be un-sent -- there is no way to
 *  cancel a queued command (sim/commands.ts has no such primitive, plan.ts's own `diffAmendmentNodes`
 *  doc) -- so removing one of `amendExistingNodes` is refused with an issue string, locked or not
 *  (a node the player only just added this session, never yet transmitted, has nothing to cancel
 *  and can always be removed, even if it has since drifted behind the command horizon). */
export function removeNode({ state, index }: { state: PlannerState; index: number }): PlannerState {
  if (!state.draft || index < 0 || index >= state.draft.nodes.length) return state;
  if (state.mode === 'amend' && index < state.amendExistingNodes.length) {
    return { ...state, issues: ['cannot remove an already-committed node'] };
  }
  const nodes = state.draft.nodes.filter((_, i) => i !== index);

  // Every later node's index shifts down by one; anything referencing the removed node itself
  // (its own selection, or a drag targeting it) is cleared rather than left dangling.
  const shiftIndex = (i: number): number | null => (i === index ? null : i > index ? i - 1 : i);

  const selectedNode = state.selectedNode === null ? null : shiftIndex(state.selectedNode);
  let drag = state.drag;
  if (drag?.kind === 'node') {
    const shifted = shiftIndex(drag.index);
    drag = shifted === null ? null : { ...drag, index: shifted };
  }

  return { ...state, draft: { ...state.draft, nodes }, selectedNode, drag };
}

/** In 'amend' mode, a locked node (`isNodeLocked`) refuses a drag -- returned unchanged, with an
 *  issue string, rather than starting a drag that could only ever end in the simulation's own
 *  rejection at commit time (GRV-0031, GAME-0001 §4.4 "locked nodes are dimmed and refuse edits,
 *  with the reason shown"). */
export function beginNodeDrag({
  state,
  index,
  handle,
  worldX,
  worldY,
}: {
  state: PlannerState;
  index: number;
  handle: 'prograde' | 'lateral';
  worldX: number;
  worldY: number;
}): PlannerState {
  if (!state.draft || index < 0 || index >= state.draft.nodes.length) return state;
  const node = state.draft.nodes[index]!;
  if (isNodeLocked({ state, node })) {
    return { ...state, issues: [`node ${index + 1} is locked: order cannot arrive in time`] };
  }
  return {
    ...state,
    drag: { kind: 'node', index, handle, worldX, worldY },
    selectedNode: index,
  };
}

/** Sets a node's dragged component from the projection of the drag vector (node position to the
 *  drag's world endpoint) onto the ghost's own velocity direction at the node's tick (prograde) or
 *  its perpendicular (lateral, "+90 degrees, left of velocity" -- plan.ts's own BurnNode doc),
 *  scaled by a fixed metres-per-(m/s) factor derived from the camera (design note). Needs an
 *  already-integrated ghost sample at the node's tick -- a no-op otherwise (nothing to project
 *  onto yet; the UI only starts a node drag on an existing, already-drawn ghost node). */
export function updateNodeDrag({
  state,
  worldX,
  worldY,
  metresPerPixel,
}: {
  state: PlannerState;
  worldX: number;
  worldY: number;
  metresPerPixel: number;
}): PlannerState {
  if (!state.drag || state.drag.kind !== 'node' || !state.draft || !state.ghost) return state;
  const { index, handle } = state.drag;
  const node = state.draft.nodes[index];
  if (!node) return state;

  const sampleIndex = node.atTick - state.ghost.fromTick;
  if (sampleIndex < 0 || sampleIndex >= state.ghost.samples.count) return state;
  const vx = state.ghost.samples.vx[sampleIndex]!;
  const vy = state.ghost.samples.vy[sampleIndex]!;
  const speed = Math.hypot(vx, vy);
  if (speed === 0) return state;
  const ux = vx / speed;
  const uy = vy / speed;
  const perpX = -uy;
  const perpY = ux;

  const nodeX = state.ghost.samples.x[sampleIndex]!;
  const nodeY = state.ghost.samples.y[sampleIndex]!;
  const dx = worldX - nodeX;
  const dy = worldY - nodeY;
  const along = handle === 'prograde' ? dx * ux + dy * uy : dx * perpX + dy * perpY;

  const worldPerMps = (NODE_HANDLE_REFERENCE_PX * metresPerPixel) / NODE_HANDLE_REFERENCE_MPS;
  const mps = worldPerMps > 0 ? along / worldPerMps : 0;
  const quantized = Math.max(-INT32_MAX, Math.min(INT32_MAX, Math.round(mps * MM_PER_M)));

  let prograde = handle === 'prograde' ? quantized : node.prograde;
  let lateral = handle === 'lateral' ? quantized : node.lateral;
  // A burn needs *some* direction (commands.ts's applyBurn rejects (0, 0)): dragging the last
  // remaining nonzero axis all the way to zero would otherwise make the node invalid the moment
  // this update lands, before the player ever sees a reason why.
  if (prograde === 0 && lateral === 0) {
    if (handle === 'prograde') prograde = 1;
    else lateral = 1;
  }

  const nodes = state.draft.nodes.slice();
  nodes[index] = { ...node, prograde, lateral };
  return {
    ...state,
    draft: { ...state.draft, nodes },
    drag: { ...state.drag, worldX, worldY },
  };
}

export function setHorizon({
  state,
  tick,
}: {
  state: PlannerState;
  tick: number | null;
}): PlannerState {
  return { ...state, horizon: tick };
}

/** Speculatively checks the draft's launch (rail/heading/speed, never the nodes -- validatePlan's
 *  own job) against the world as of `plan.launchTick`, replaying `log` first exactly as
 *  integrateGhost's own cold path does. Read-only: checkLaunch itself never mutates `sim`
 *  (commands.ts), and this Sim is thrown away immediately after. */
function checkPlanLaunch({
  level,
  log,
  plan,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  plan: FlightPlan;
}): LaunchRejection | null {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  advance({ sim, log, ticks: plan.launchTick });
  return checkLaunch({
    sim,
    command: {
      tick: plan.launchTick,
      kind: 'launch',
      rail: plan.rail,
      heading: plan.heading,
      speed: plan.speed,
    },
  });
}

/** A throwaway `Sim` replayed to `nowTick` -- `computeCommandHorizon`/`checkAmendmentNodes`'s own
 *  read-only anchor, mirroring `checkPlanLaunch`'s own pattern. Advancing all the way to `nowTick`
 *  (rather than, say, tick 0) matters for an object-target light-cone query specifically
 *  (`uplinkArrival`'s own live-state anchoring invariant, docs/evidence/GRV-0029/README.md's design
 *  decision: "every caller ... must call it with sim.tick already close to the true issue point") --
 *  a rail-target query does not need it (`railGeometry` is analytic in time, not sim-tick-dependent)
 *  but is unaffected by the extra replay either. */
function commandHorizonSim({
  level,
  log,
  nowTick,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  nowTick: number;
}): Sim {
  const sim = createSim({ scenario: level.scenario, seed: level.seed });
  advance({ sim, log, ticks: nowTick });
  return sim;
}

/** GAME-0001 §4.6 "command horizon" (ADR-0007 §2-3, GRV-0031): a draft's own launch/arrival
 *  (`issueTickFor`/`uplinkArrival` against its rail, matching `planToCommands`'s own solve exactly
 *  -- "ghost issuance is commit issuance" extends to this readout too); an amendment's uplink
 *  arrival of an order sent right now, against the amended probe itself. `null` without a draft, or
 *  (amend mode) once the amended probe no longer exists in `log` at `nowTick` (expended or never
 *  launched -- should not happen through the UI's own gating, but this stays honest rather than
 *  reading past the object table). */
export function computeCommandHorizon({
  level,
  log,
  mode,
  draft,
  amendProbe,
  nowTick,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  mode: PlannerMode;
  draft: FlightPlan | null;
  amendProbe: number | null;
  nowTick: number;
}): CommandHorizon | null {
  if (!draft) return null;
  const sim = commandHorizonSim({ level, log, nowTick });

  if (mode === 'draft') {
    const issueTick = issueTickFor({
      sim,
      target: { kind: 'rail', rail: draft.rail },
      atTick: draft.launchTick,
    });
    const arrivalTick = uplinkArrival({
      sim,
      target: { kind: 'rail', rail: draft.rail },
      issueTick,
    });
    return { issueTick, arrivalTick, commandHorizonTick: arrivalTick };
  }

  if (amendProbe === null || amendProbe >= sim.objects.count) return null;
  const commandHorizonTick = uplinkArrival({
    sim,
    target: { kind: 'object', object: amendProbe },
    issueTick: nowTick,
  });
  return { issueTick: nowTick, arrivalTick: commandHorizonTick, commandHorizonTick };
}

/** Speculatively checks every node an amendment would actually transmit (`diffAmendmentNodes`,
 *  plan.ts) against `checkBurn` (sim/commands.ts) -- the simulation's own last line of defence
 *  against a locked or occluded node (module doc, ADR-0007 §3-4), read here first so a doomed
 *  amendment is reported rather than thrown from inside `integrateGhost`. Mirrors
 *  `checkPlanLaunch`'s own read-only-Sim pattern; `nowTick` is the issue tick every amended node's
 *  own command uses (module doc: "issued ... now"). */
function checkAmendmentNodes({
  level,
  log,
  amendProbe,
  nowTick,
  nodes,
}: {
  level: CompiledLevel;
  log: readonly Command[];
  amendProbe: number;
  nowTick: number;
  nodes: readonly BurnNode[];
}): string[] {
  const sim = commandHorizonSim({ level, log, nowTick });
  const issues: string[] = [];
  for (const node of nodes) {
    const reason: BurnRejection | null = checkBurn({
      sim,
      command: {
        tick: nowTick,
        kind: 'burn',
        probe: amendProbe,
        atTick: node.atTick,
        prograde: node.prograde,
        lateral: node.lateral,
      },
    });
    if (reason !== null) issues.push(`node at ${node.atTick}: ${reason}`);
  }
  return issues;
}

/** Re-integrates the ghost from the draft (GAME-0001 §4.6, determinism contract's "Ghost
 *  invariant"): if the sim's clock has reached or passed the draft's own launch tick, the launch
 *  snaps to the next tick first ("the plan can only launch in the future") -- everything
 *  downstream, including validation, reads the snapped draft, never the stale one. 'amend' mode
 *  (GRV-0031) has no launch to snap; it dispatches to `reintegrateAmend` instead, which re-checks
 *  the command horizon (it slides forward with the clock, GAME-0001 §4.4) and every amended node's
 *  own `checkBurn` in its place.
 *
 *  Two checks gate integration, in order (GRV-0028, docs/issues/2026-09-18-reintegrate-skips-
 *  validate-plan.md): `validatePlan` (plan.ts) first -- a plan shape the simulation itself would
 *  reject outright (over the node budget, a node no longer later than the -- possibly just
 *  snapped -- launch tick) never reaches `integrateGhost` at all, which is what let a too-large
 *  plan throw from inside the sim's own burn queue and let a re-drag past a node integrate a
 *  ghost that silently ignored it. Only once the shape is clean does `checkLaunch` (capacity,
 *  reload, band or cone -- sim/commands.ts) get a turn. Either way, a rejection skips integration
 *  entirely: the ghost is not drawn and the reason is carried on `issues` instead, matching the
 *  design note's own "outside the cone or band the ghost is not drawn and the reason is shown",
 *  generalised to cover a malformed plan the same way. Caching (src/planner/ghost.ts's
 *  GhostCache) is threaded through `state.cache`, so an unrelated node edit resumes from the
 *  earliest one that actually changed rather than recomputing the whole flight. The UI layer
 *  debounces calls to this to once per animation frame (design note); this function itself is
 *  synchronous and does no debouncing of its own. */
export function reintegrate({
  state,
  level,
  log,
  nowTick,
  horizonTick,
}: {
  state: PlannerState;
  level: CompiledLevel;
  log: readonly Command[];
  nowTick: number;
  horizonTick: number;
}): PlannerState {
  if (!state.draft) {
    return { ...state, ghost: null, cache: undefined, issues: [], commandHorizon: null };
  }
  if (state.mode === 'amend') return reintegrateAmend({ state, level, log, nowTick, horizonTick });

  const launchTick = nowTick >= state.draft.launchTick ? nowTick + 1 : state.draft.launchTick;
  const draft: FlightPlan =
    launchTick === state.draft.launchTick ? state.draft : { ...state.draft, launchTick };
  const commandHorizon = computeCommandHorizon({
    level,
    log,
    mode: 'draft',
    draft,
    amendProbe: null,
    nowTick,
  });

  const shapeIssues = validatePlan({ plan: draft, level });
  if (shapeIssues.length > 0) {
    return { ...state, draft, ghost: null, cache: undefined, issues: shapeIssues, commandHorizon };
  }

  const launchRejection = checkPlanLaunch({ level, log, plan: draft });
  if (launchRejection !== null) {
    return {
      ...state,
      draft,
      ghost: null,
      cache: undefined,
      issues: [`launch rejected: ${launchRejection}`],
      commandHorizon,
    };
  }

  const { ghost, cache } = integrateGhost({
    level,
    log,
    plan: draft,
    fromTick: draft.launchTick,
    horizonTick,
    cache: state.cache,
  });
  return { ...state, draft, ghost, cache, issues: [], commandHorizon };
}

/** 'amend' mode's own `reintegrate` (GRV-0031): no launch to snap (the probe already exists), so
 *  the command horizon and every amended node's own `checkBurn` are what gate integration instead
 *  of `validatePlan`'s launch-tick check/`checkLaunch`. `validatePlan` still runs -- the node
 *  budget/sortedness/integer-ness checks apply just as much to an amended plan. */
function reintegrateAmend({
  state,
  level,
  log,
  nowTick,
  horizonTick,
}: {
  state: PlannerState;
  level: CompiledLevel;
  log: readonly Command[];
  nowTick: number;
  horizonTick: number;
}): PlannerState {
  const draft = state.draft!;
  const amendProbe = state.amendProbe;
  const commandHorizon =
    amendProbe === null
      ? null
      : computeCommandHorizon({ level, log, mode: 'amend', draft, amendProbe, nowTick });
  if (amendProbe === null || !commandHorizon) {
    return {
      ...state,
      ghost: null,
      cache: undefined,
      issues: ['amended probe no longer exists'],
      commandHorizon: null,
    };
  }

  const shapeIssues = validatePlan({ plan: draft, level });
  if (shapeIssues.length > 0) {
    return { ...state, ghost: null, cache: undefined, issues: shapeIssues, commandHorizon };
  }

  const toIssue = diffAmendmentNodes({ existing: state.amendExistingNodes, nodes: draft.nodes });
  const burnIssues = checkAmendmentNodes({ level, log, amendProbe, nowTick, nodes: toIssue });
  if (burnIssues.length > 0) {
    return { ...state, ghost: null, cache: undefined, issues: burnIssues, commandHorizon };
  }

  const { ghost, cache } = integrateGhost({
    level,
    log,
    plan: draft,
    fromTick: nowTick,
    horizonTick,
    amend: { probe: amendProbe, observationTick: state.amendObservationTick ?? nowTick },
  });
  return { ...state, ghost, cache, issues: [], commandHorizon };
}
