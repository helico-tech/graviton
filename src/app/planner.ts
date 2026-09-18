// Planner state (EPIC-06, GRV-0026, GAME-0001 §4.4-4.6, §4.11; docs/work/GRV-0026-planner-
// overlay.md): the draft FlightPlan the player is editing, the active drag (a launch vector off a
// rail, or a burn node's prograde/lateral handle), which node is selected, an explicit horizon
// tick for scrubbing, and the ghost it integrates to (src/planner/ghost.ts -- the live
// simulation's own step function, never a separate model; src/planner/** stays untouched here,
// only called). DOM-free and pure: every transition takes the current state and returns a new
// one, so src/ui/plot.ts's real pointer/keyboard input and the debug API drive it identically
// (ADR-0004 §1). `reintegrate` is the one transition that touches the simulation's own code path
// (via src/planner/ghost.ts); every other transition is arithmetic over the draft alone.
import { advance, checkLaunch, createSim } from '../sim/sim.ts';
import type { Command, LaunchRejection } from '../sim/sim.ts';
import { createBodyTable, evaluateEphemeris } from '../sim/ephemeris/bodies.ts';
import type { EphemerisOut } from '../sim/ephemeris/bodies.ts';
import { createRailTable, railGeometry } from '../sim/rails.ts';
import { integrateGhost } from '../planner/ghost.ts';
import type { Ghost, GhostCache } from '../planner/ghost.ts';
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

export interface PlannerState {
  readonly draft: FlightPlan | null;
  readonly drag: Drag | null;
  /** Explicit horizon tick for the timeline scrub (GAME-0001 §4.6 "horizon scrub"); `null` is
   *  "the present" -- nothing in the simulation moves because of this field, it only changes what
   *  tick the plot is drawn at (src/render/frame.ts's captureFrame, extended to take an explicit
   *  time). */
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
  /** From `checkLaunch` (sim/commands.ts) against the draft's own rail/heading/speed -- capacity,
   *  reload, band or cone -- computed by `reintegrate` alongside the ghost so the PLAN panel can
   *  show why a launch is currently infeasible without re-deriving it itself (determinism rule 11:
   *  every displayed number originates in the simulation, not a second model). `null` when there
   *  is no draft or the launch is currently feasible. */
  readonly launchRejection: LaunchRejection | null;
}

export function createPlannerState(): PlannerState {
  return {
    draft: null,
    drag: null,
    horizon: null,
    ghost: null,
    cache: undefined,
    selectedNode: null,
    launchRejection: null,
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

export function setPlan({ state, plan }: { state: PlannerState; plan: FlightPlan }): PlannerState {
  return { ...state, draft: plan, drag: null, selectedNode: null };
}

export function discardDraft(state: PlannerState): PlannerState {
  return {
    ...state,
    draft: null,
    drag: null,
    ghost: null,
    cache: undefined,
    selectedNode: null,
    launchRejection: null,
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
  return { ...state, drag: { kind: 'launch', rail, worldX, worldY } };
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

/** Places a node at `tick` (design note "click on the ghost path... adds a node at the nearest
 *  sample tick"), sorted into position, a no-op if there is no draft, the tick is not later than
 *  the launch, or the level's per-probe node budget (levels/compile.ts) is already spent. Selects
 *  the new node so its handles are immediately visible for fine-tuning. */
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
  if (tick <= state.draft.launchTick) return state;
  if (state.draft.nodes.length >= nodeBudget(level)) return state;

  const node: BurnNode = { atTick: tick, prograde: DEFAULT_NODE_PROGRADE_MM_PER_S, lateral: 0 };
  const nodes = [...state.draft.nodes, node].sort((a, b) => a.atTick - b.atTick);
  const index = nodes.indexOf(node);
  return { ...state, draft: { ...state.draft, nodes }, selectedNode: index };
}

export function removeNode({ state, index }: { state: PlannerState; index: number }): PlannerState {
  if (!state.draft || index < 0 || index >= state.draft.nodes.length) return state;
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

/** Re-integrates the ghost from the draft (GAME-0001 §4.6, determinism contract's "Ghost
 *  invariant"): if the sim's clock has reached or passed the draft's own launch tick, the launch
 *  snaps to the next tick first ("the plan can only launch in the future") -- everything
 *  downstream reads the snapped draft, never the stale one. A rejected launch (capacity, reload,
 *  band or cone -- checkLaunch, sim/commands.ts) skips integration entirely: the ghost is not
 *  drawn and the reason is carried on `launchRejection` instead, matching the design note's own
 *  "outside the cone or band the ghost is not drawn and the reason is shown". Caching
 *  (src/planner/ghost.ts's GhostCache) is threaded through `state.cache`, so an unrelated node
 *  edit resumes from the earliest one that actually changed rather than recomputing the whole
 *  flight. The UI layer debounces calls to this to once per animation frame (design note); this
 *  function itself is synchronous and does no debouncing of its own. */
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
  if (!state.draft) return { ...state, ghost: null, cache: undefined, launchRejection: null };

  const launchTick = nowTick >= state.draft.launchTick ? nowTick + 1 : state.draft.launchTick;
  const draft: FlightPlan =
    launchTick === state.draft.launchTick ? state.draft : { ...state.draft, launchTick };

  const launchRejection = checkPlanLaunch({ level, log, plan: draft });
  if (launchRejection !== null) {
    return { ...state, draft, ghost: null, cache: undefined, launchRejection };
  }

  const { ghost, cache } = integrateGhost({
    level,
    log,
    plan: draft,
    fromTick: draft.launchTick,
    horizonTick,
    cache: state.cache,
  });
  return { ...state, draft, ghost, cache, launchRejection: null };
}
