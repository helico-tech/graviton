// The planner overlay on the plot (GRV-0026, GAME-0001 §4.6, GAME-0002 §4 "Dashed: predicted from
// a loaded plan", §7 "Trajectories"): the dashed ghost path, its burn nodes and the selected
// node's drag handles, its closest-approach/impact/body-hit event marks, and the live launch
// vector while a launch drag is in progress. `buildPlannerFrame` is the DOM-free assembly step
// (Ghost + FlightPlan -> plain world-space geometry, mirroring frame.ts's captureFrame), so the
// same data can be hit-tested by src/ui/plot.ts's pointer handling and drawn by `drawPlannerFrame`
// -- both pure over their arguments, like the rest of this package (ADR-0002 guard-rail 6).
// Ghost/FlightPlan/BurnNode are imported type-only (src/planner stays untouched and pulls in
// nothing yaml/valibot-shaped -- ghost.ts's own module header), so this adds no runtime import;
// `src/render` still depends on neither src/app nor src/ui (frame.ts's own stated rule) and, as
// with the rest of this package, on src/sim directly (railGeometry, HEADING_TURN) rather than a
// second model of either.
import { formatMetres, worldToScreen } from './camera.ts';
import type { View } from './camera.ts';
import { drawMarker } from './bodies.ts';
import {
  ALARM,
  CONFIRMED_GOOD,
  KNOWN,
  KNOWN_DIM,
  LINE_STYLES,
  MONO_FONT_FAMILY,
} from './palette.ts';
import type { Ctx2D } from './ctx2d.ts';
import { HEADING_TURN } from '../sim/commands.ts';
import type { Ghost } from '../planner/ghost.ts';
import type { BurnNode, FlightPlan } from '../planner/plan.ts';

const TWO_PI = Math.PI * 2;
const NODE_MARKER_RADIUS_PX = 4;
const HANDLE_STEM_LENGTH_PX = 40;
const HANDLE_DOT_RADIUS_PX = 3;
const EVENT_MARKER_RADIUS_PX = 4;
const EVENT_TICK_LENGTH_PX = 6;
const LABEL_FONT = `10px "${MONO_FONT_FAMILY}"`;
const LABEL_OFFSET_PX = 6;
/** GRV-0028, docs/issues/2026-09-18-plot-event-labels-overlap-at-impact.md: on a direct hit the
 *  closest-approach and impact marks land on (near enough) the same pixel, and their labels used
 *  to render as one garbled string ("impac t118 km") -- a closest-approach label this close to an
 *  impact for the *same* contact is dropped instead (`plannerLabels`, below). */
const LABEL_SUPPRESS_RADIUS_PX = 8;

export interface GhostPathPoint {
  readonly x: number;
  readonly y: number;
  /** Carried so a caller (src/ui/plot.ts's pointer hit-testing) can turn "nearest point on the
   *  drawn path" straight into `app.addNode({ tick })` without a second lookup into the ghost. */
  readonly tick: number;
}

export interface GhostRenderNode {
  readonly x: number;
  readonly y: number;
  /** This node's own index into `FlightPlan.nodes` -- hit-testing's own way back to
   *  `app.selectNode`/`beginNodeDrag`. */
  readonly index: number;
  /** GRV-0031, GAME-0001 §4.4/GAME-0002 §7: `atTick` earlier than the command horizon in 'amend'
   *  mode -- drawn hollow rather than filled, and never grows a handle even if selected
   *  (`buildPlannerFrame`'s own `handle` below). Always `false` in 'draft' mode (a draft's own
   *  plan is one not-yet-sent transmission, nothing in it is locked). */
  readonly locked: boolean;
}

export interface CommandHorizonMark {
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

export interface GhostRenderHandle {
  readonly nodeX: number;
  readonly nodeY: number;
  readonly progradeX: number;
  readonly progradeY: number;
  readonly lateralX: number;
  readonly lateralY: number;
}

export interface GhostEventMark {
  readonly x: number;
  readonly y: number;
  readonly kind: 'closestApproach' | 'impact' | 'bodyHit';
  readonly label: string;
  /** The contact this event concerns (`closestApproach`/`impact` only) -- lets `plannerLabels`
   *  (below) match a closest-approach label to the impact that supersedes it, GRV-0028.
   *  `undefined` for `bodyHit`, which has no contact. */
  readonly contact?: number;
}

export interface LaunchVectorPreview {
  readonly originX: number;
  readonly originY: number;
  readonly tipX: number;
  readonly tipY: number;
  readonly label: string;
}

export interface PlannerFrame {
  readonly path: readonly GhostPathPoint[];
  readonly nodes: readonly GhostRenderNode[];
  readonly handle: GhostRenderHandle | null;
  readonly events: readonly GhostEventMark[];
  readonly launchVector: LaunchVectorPreview | null;
  /** GRV-0031: the tick before which the path is locked (dimmed solid, GAME-0002 §4) -- `null` in
   *  'draft' mode, where nothing is ever locked, so the whole path draws in the ordinary dashed
   *  "predicted" style. */
  readonly lockedUntilTick: number | null;
  /** The command horizon's own mark on the path, `CMD +mm:ss` (GAME-0001 §4.6) -- `null` without a
   *  ghost or a command horizon, or if the ghost never actually reached that tick. */
  readonly commandHorizonMark: CommandHorizonMark | null;
}

function sampleAt(
  ghost: Ghost,
  tick: number,
): { x: number; y: number; vx: number; vy: number } | null {
  const index = tick - ghost.fromTick;
  if (index < 0 || index >= ghost.samples.count) return null;
  return {
    x: ghost.samples.x[index]!,
    y: ghost.samples.y[index]!,
    vx: ghost.samples.vx[index]!,
    vy: ghost.samples.vy[index]!,
  };
}

function ghostPath(ghost: Ghost): GhostPathPoint[] {
  const points: GhostPathPoint[] = [];
  for (let i = 0; i < ghost.samples.count; i++) {
    points.push({ x: ghost.samples.x[i]!, y: ghost.samples.y[i]!, tick: ghost.fromTick + i });
  }
  return points;
}

function isNodeLocked(node: BurnNode, lockedUntilTick: number | null): boolean {
  return lockedUntilTick !== null && node.atTick < lockedUntilTick;
}

function ghostNodes(
  ghost: Ghost,
  plan: FlightPlan,
  lockedUntilTick: number | null,
): GhostRenderNode[] {
  const nodes: GhostRenderNode[] = [];
  plan.nodes.forEach((node, index) => {
    const sample = sampleAt(ghost, node.atTick);
    if (sample) {
      nodes.push({ x: sample.x, y: sample.y, index, locked: isNodeLocked(node, lockedUntilTick) });
    }
  });
  return nodes;
}

/** The selected node's prograde (along the ghost's own velocity at its tick) and lateral (+90
 *  degrees, left of velocity -- plan.ts's own BurnNode doc) handle tips, a fixed screen length out
 *  from the node -- a drag affordance, not a magnitude readout (the PLAN panel shows the exact
 *  mm/s). `null` if there is no selection, the ghost never reached that tick, or (GRV-0031) the
 *  node is locked -- "no handles" (GAME-0001 §4.4), a locked node can't be dragged at all. */
function ghostHandle({
  ghost,
  plan,
  selectedNode,
  view,
  lockedUntilTick,
}: {
  ghost: Ghost;
  plan: FlightPlan;
  selectedNode: number | null;
  view: View;
  lockedUntilTick: number | null;
}): GhostRenderHandle | null {
  if (selectedNode === null) return null;
  const node = plan.nodes[selectedNode];
  if (!node || isNodeLocked(node, lockedUntilTick)) return null;
  const sample = sampleAt(ghost, node.atTick);
  if (!sample) return null;

  const speed = Math.hypot(sample.vx, sample.vy);
  if (speed === 0) return null;
  const ux = sample.vx / speed;
  const uy = sample.vy / speed;
  const stem = HANDLE_STEM_LENGTH_PX * view.metresPerPixel;

  return {
    nodeX: sample.x,
    nodeY: sample.y,
    progradeX: sample.x + ux * stem,
    progradeY: sample.y + uy * stem,
    lateralX: sample.x + -uy * stem,
    lateralY: sample.y + ux * stem,
  };
}

function ghostEvents(ghost: Ghost): GhostEventMark[] {
  const marks: GhostEventMark[] = [];
  for (const event of ghost.events) {
    if (event.kind === 'closestApproach') {
      const sample = sampleAt(ghost, event.tick);
      if (sample)
        marks.push({
          x: sample.x,
          y: sample.y,
          kind: 'closestApproach',
          label: `miss ${formatMetres(event.distance)}`,
          contact: event.contact,
        });
    } else if (event.kind === 'impact') {
      const sample = sampleAt(ghost, event.tick);
      if (sample)
        marks.push({
          x: sample.x,
          y: sample.y,
          kind: 'impact',
          label: 'impact',
          contact: event.contact,
        });
    } else if (event.kind === 'bodyHit') {
      const sample = sampleAt(ghost, event.tick);
      if (sample) marks.push({ x: sample.x, y: sample.y, kind: 'bodyHit', label: 'body hit' });
    }
  }
  return marks;
}

function launchVectorPreview({
  plan,
  originX,
  originY,
}: {
  plan: FlightPlan;
  originX: number;
  originY: number;
}): LaunchVectorPreview {
  const headingRad = (plan.heading * TWO_PI) / HEADING_TURN;
  const speedMps = plan.speed / 1000;
  const tipLength = 40; // a fixed on-screen arrow length; the label carries the real numbers
  return {
    originX,
    originY,
    tipX: originX + Math.cos(headingRad) * tipLength,
    tipY: originY + Math.sin(headingRad) * tipLength,
    label: `${((headingRad * 180) / Math.PI).toFixed(0)}°  ${(speedMps / 1000).toFixed(2)} km/s`,
  };
}

/** `+mm:ss` (GAME-0001 §4.6's own `CMD +mm:ss` label): minutes uncapped (a draft's own command
 *  horizon can be a long flight away), never the `T+dd:hh:mm:ss` absolute-time format
 *  (src/app/time.ts's `formatSimTime`) -- this is a duration, "how far from now", not a moment. */
function formatMinutesSeconds(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** The command horizon's own mark (GAME-0001 §4.6): a point on the ghost's predicted path at
 *  `commandHorizonTick`, labelled with how far that is from the ghost's own start (`fromTick`,
 *  "now") -- for a draft that is the launch's own flight time to arrival (the mark sits right at
 *  the path's own start, since the ghost never draws before its probe exists); for an amendment,
 *  the pure uplink delay. `null` if the ghost never actually reached that tick. */
function commandHorizonMarkFor({
  ghost,
  commandHorizonTick,
  dt,
}: {
  ghost: Ghost;
  commandHorizonTick: number;
  dt: number;
}): CommandHorizonMark | null {
  const sample = sampleAt(ghost, commandHorizonTick);
  if (!sample) return null;
  const label = `CMD +${formatMinutesSeconds((commandHorizonTick - ghost.fromTick) * dt)}`;
  return { x: sample.x, y: sample.y, label };
}

/** Ghost + FlightPlan -> plain world-space geometry (never screen space -- `drawPlannerFrame`
 *  below projects it, mirroring how `renderPlot` projects trails itself). `launchOrigin` is the
 *  rail's current world position (Frame.rails[plan.rail], already computed by captureFrame) and
 *  is read only while a launch drag is actually live -- released, the ghost path itself is the
 *  primary read, not a straight preview arrow. `commandHorizon`/`dt` are GRV-0031's own addition
 *  (GAME-0001 §4.6): `locks: true` only in 'amend' mode (a draft's own plan is one not-yet-sent
 *  transmission -- nothing in it is locked, plan.ts's "same issue batch"). */
export function buildPlannerFrame({
  plan,
  ghost,
  selectedNode,
  launchOrigin,
  view,
  commandHorizon,
  dt,
}: {
  plan: FlightPlan | null;
  ghost: Ghost | null;
  selectedNode: number | null;
  launchOrigin: { x: number; y: number } | null;
  view: View;
  commandHorizon: { commandHorizonTick: number; locks: boolean } | null;
  dt: number;
}): PlannerFrame | null {
  if (!plan) return null;
  const lockedUntilTick =
    commandHorizon && commandHorizon.locks ? commandHorizon.commandHorizonTick : null;
  return {
    path: ghost ? ghostPath(ghost) : [],
    nodes: ghost ? ghostNodes(ghost, plan, lockedUntilTick) : [],
    handle: ghost ? ghostHandle({ ghost, plan, selectedNode, view, lockedUntilTick }) : null,
    events: ghost ? ghostEvents(ghost) : [],
    launchVector: launchOrigin
      ? launchVectorPreview({ plan, originX: launchOrigin.x, originY: launchOrigin.y })
      : null,
    lockedUntilTick,
    commandHorizonMark:
      ghost && commandHorizon
        ? commandHorizonMarkFor({
            ghost,
            commandHorizonTick: commandHorizon.commandHorizonTick,
            dt,
          })
        : null,
  };
}

function project(
  view: View,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
): { x: number; y: number } {
  return worldToScreen({ view, canvasWidth, canvasHeight, x, y });
}

export interface PlannerLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/** Every event mark's screen-space label position and text (GRV-0028, docs/issues/2026-09-18-
 *  plot-event-labels-overlap-at-impact.md), with a closest-approach label dropped when an impact
 *  for the *same contact* lands within `LABEL_SUPPRESS_RADIUS_PX` of it: on a direct hit the two
 *  marks land on (near enough) the same pixel, and their labels would otherwise render as one
 *  garbled string. Pure over `frame` + `view` + the canvas size, so a test can call it directly
 *  without rasterising text (tests/render/plot.test.ts's own convention for pixel assertions
 *  doesn't apply here -- there is nothing to sample). `drawEvents` (below) still draws every
 *  mark's own glyph regardless -- only the *text* is suppressed, not the tick mark/diamond/cross
 *  itself. */
export function plannerLabels({
  frame,
  view,
  canvasWidth,
  canvasHeight,
}: {
  frame: PlannerFrame;
  view: View;
  canvasWidth: number;
  canvasHeight: number;
}): PlannerLabel[] {
  const screens = frame.events.map((event) =>
    project(view, canvasWidth, canvasHeight, event.x, event.y),
  );

  const suppressed = frame.events.map((event, index) => {
    if (event.kind !== 'closestApproach') return false;
    const own = screens[index]!;
    return frame.events.some((other, otherIndex) => {
      if (other.kind !== 'impact' || other.contact !== event.contact) return false;
      const otherScreen = screens[otherIndex]!;
      return Math.hypot(otherScreen.x - own.x, otherScreen.y - own.y) <= LABEL_SUPPRESS_RADIUS_PX;
    });
  });

  return frame.events
    .map((event, index) => ({ x: screens[index]!.x, y: screens[index]!.y, text: event.label }))
    .filter((_, index) => !suppressed[index]);
}

function strokePathSegment(
  ctx: Ctx2D,
  {
    points,
    color,
    view,
    canvasWidth,
    canvasHeight,
  }: {
    points: readonly GhostPathPoint[];
    color: string;
    view: View;
    canvasWidth: number;
    canvasHeight: number;
  },
): void {
  if (points.length < 2) return;
  ctx.beginPath();
  const first = project(view, canvasWidth, canvasHeight, points[0]!.x, points[0]!.y);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const p = project(view, canvasWidth, canvasHeight, points[i]!.x, points[i]!.y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([...LINE_STYLES.ghost.dash]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** The dashed "predicted" ghost path (GAME-0002 §4), split at `lockedUntilTick` (GRV-0031) into a
 *  dimmed (`KNOWN_DIM`) locked stretch and the ordinary `KNOWN` one beyond it -- the identical
 *  dash throughout (palette.ts's own convention for "dimmed solid": colour only, mirroring an
 *  expended trail, src/render/plot.ts). `null` draws the whole path `KNOWN`, a draft's own case
 *  (nothing in it is ever locked). The two segments share their boundary point so the line reads
 *  continuous. */
function drawPath(
  ctx: Ctx2D,
  {
    path,
    lockedUntilTick,
    view,
    canvasWidth,
    canvasHeight,
  }: {
    path: readonly GhostPathPoint[];
    lockedUntilTick: number | null;
    view: View;
    canvasWidth: number;
    canvasHeight: number;
  },
): void {
  if (lockedUntilTick === null) {
    strokePathSegment(ctx, { points: path, color: KNOWN, view, canvasWidth, canvasHeight });
    return;
  }
  let splitIndex = path.findIndex((p) => p.tick >= lockedUntilTick);
  if (splitIndex === -1) splitIndex = path.length - 1;
  strokePathSegment(ctx, {
    points: path.slice(0, splitIndex + 1),
    color: KNOWN_DIM,
    view,
    canvasWidth,
    canvasHeight,
  });
  strokePathSegment(ctx, {
    points: path.slice(splitIndex),
    color: KNOWN,
    view,
    canvasWidth,
    canvasHeight,
  });
}

/** Burn nodes as small squares (GAME-0002 §7): filled while amendable, hollow once locked
 *  (GRV-0031, GAME-0001 §4.4) -- a stroked square rather than `drawMarker`'s own fill-only glyph. */
function drawNodes(
  ctx: Ctx2D,
  {
    nodes,
    view,
    canvasWidth,
    canvasHeight,
  }: {
    nodes: readonly GhostRenderNode[];
    view: View;
    canvasWidth: number;
    canvasHeight: number;
  },
): void {
  for (const node of nodes) {
    const p = project(view, canvasWidth, canvasHeight, node.x, node.y);
    if (node.locked) {
      // A stroked (hollow) square -- Ctx2D (ctx2d.ts) is a deliberately minimal Canvas2D subset
      // with no strokeRect, so this is the same moveTo/lineTo/closePath/stroke shape every other
      // hairline here already uses.
      ctx.strokeStyle = KNOWN_DIM;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x - NODE_MARKER_RADIUS_PX, p.y - NODE_MARKER_RADIUS_PX);
      ctx.lineTo(p.x + NODE_MARKER_RADIUS_PX, p.y - NODE_MARKER_RADIUS_PX);
      ctx.lineTo(p.x + NODE_MARKER_RADIUS_PX, p.y + NODE_MARKER_RADIUS_PX);
      ctx.lineTo(p.x - NODE_MARKER_RADIUS_PX, p.y + NODE_MARKER_RADIUS_PX);
      ctx.closePath();
      ctx.stroke();
    } else {
      drawMarker(ctx, {
        x: p.x,
        y: p.y,
        shape: 'square',
        radius: NODE_MARKER_RADIUS_PX,
        color: KNOWN,
      });
    }
  }
}

function drawHandle(
  ctx: Ctx2D,
  {
    handle,
    view,
    canvasWidth,
    canvasHeight,
  }: {
    handle: GhostRenderHandle | null;
    view: View;
    canvasWidth: number;
    canvasHeight: number;
  },
): void {
  if (!handle) return;
  const node = project(view, canvasWidth, canvasHeight, handle.nodeX, handle.nodeY);
  const prograde = project(view, canvasWidth, canvasHeight, handle.progradeX, handle.progradeY);
  const lateral = project(view, canvasWidth, canvasHeight, handle.lateralX, handle.lateralY);

  ctx.strokeStyle = KNOWN;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const tip of [prograde, lateral]) {
    ctx.beginPath();
    ctx.moveTo(node.x, node.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    drawMarker(ctx, {
      x: tip.x,
      y: tip.y,
      shape: 'circle',
      radius: HANDLE_DOT_RADIUS_PX,
      color: KNOWN,
    });
  }
}

function drawLabel(ctx: Ctx2D, { x, y, text }: { x: number; y: number; text: string }): void {
  ctx.font = LABEL_FONT;
  ctx.fillStyle = KNOWN;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x + LABEL_OFFSET_PX, y - LABEL_OFFSET_PX);
}

/** Closest-approach tick mark, impact (confirmed-good) and body-hit (alarm) markers (design note)
 *  -- every mark, whether or not its label is suppressed (`plannerLabels` still owns which labels
 *  actually draw, below); this thin consumer just projects and draws the glyphs. */
function drawEventMarkers(
  ctx: Ctx2D,
  {
    events,
    view,
    canvasWidth,
    canvasHeight,
  }: {
    events: readonly GhostEventMark[];
    view: View;
    canvasWidth: number;
    canvasHeight: number;
  },
): void {
  for (const event of events) {
    const p = project(view, canvasWidth, canvasHeight, event.x, event.y);
    if (event.kind === 'closestApproach') {
      ctx.strokeStyle = KNOWN;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x - EVENT_TICK_LENGTH_PX, p.y);
      ctx.lineTo(p.x + EVENT_TICK_LENGTH_PX, p.y);
      ctx.moveTo(p.x, p.y - EVENT_TICK_LENGTH_PX);
      ctx.lineTo(p.x, p.y + EVENT_TICK_LENGTH_PX);
      ctx.stroke();
    } else if (event.kind === 'impact') {
      drawMarker(ctx, {
        x: p.x,
        y: p.y,
        shape: 'diamond',
        radius: EVENT_MARKER_RADIUS_PX,
        color: CONFIRMED_GOOD,
      });
    } else {
      // bodyHit: an alarm cross -- "nothing else is alarm" (GAME-0002 §1), so this is the one
      // marker on the plot ever drawn in it.
      ctx.strokeStyle = ALARM;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x - EVENT_MARKER_RADIUS_PX, p.y - EVENT_MARKER_RADIUS_PX);
      ctx.lineTo(p.x + EVENT_MARKER_RADIUS_PX, p.y + EVENT_MARKER_RADIUS_PX);
      ctx.moveTo(p.x - EVENT_MARKER_RADIUS_PX, p.y + EVENT_MARKER_RADIUS_PX);
      ctx.lineTo(p.x + EVENT_MARKER_RADIUS_PX, p.y - EVENT_MARKER_RADIUS_PX);
      ctx.stroke();
    }
  }
}

/** Every event's own marker, then every *unsuppressed* label (`plannerLabels`, GRV-0028) --
 *  suppressing only the text keeps every mark itself visible even where two coincide. */
function drawEvents(
  ctx: Ctx2D,
  {
    frame,
    view,
    canvasWidth,
    canvasHeight,
  }: { frame: PlannerFrame; view: View; canvasWidth: number; canvasHeight: number },
): void {
  drawEventMarkers(ctx, { events: frame.events, view, canvasWidth, canvasHeight });
  for (const label of plannerLabels({ frame, view, canvasWidth, canvasHeight })) {
    drawLabel(ctx, label);
  }
}

/** The live launch vector while a drag is in progress (GAME-0001 §4.6 "launch drag"): a solid
 *  hairline from the rail's own muzzle point to the drag's current endpoint, labelled with the
 *  heading and speed it currently resolves to. */
function drawLaunchVector(
  ctx: Ctx2D,
  {
    vector,
    view,
    canvasWidth,
    canvasHeight,
  }: {
    vector: LaunchVectorPreview | null;
    view: View;
    canvasWidth: number;
    canvasHeight: number;
  },
): void {
  if (!vector) return;
  const origin = project(view, canvasWidth, canvasHeight, vector.originX, vector.originY);
  const tip = project(view, canvasWidth, canvasHeight, vector.tipX, vector.tipY);
  ctx.strokeStyle = KNOWN;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  drawLabel(ctx, { x: tip.x, y: tip.y, text: vector.label });
}

/** The command horizon's own mark (GAME-0001 §4.6): a small triangle (distinct from every node
 *  square, handle circle and event glyph already on this plot) plus its `CMD +mm:ss` label. */
function drawCommandHorizonMark(ctx: Ctx2D, { mark }: { mark: CommandHorizonMark }): void {
  drawMarker(ctx, {
    x: mark.x,
    y: mark.y,
    shape: 'triangle',
    radius: EVENT_MARKER_RADIUS_PX,
    color: KNOWN,
  });
  drawLabel(ctx, { x: mark.x, y: mark.y, text: mark.label });
}

/** Draws the whole planner overlay -- called from renderPlot (src/render/plot.ts) after the live
 *  plot's own content, so the ghost and its handles sit on top of bodies, rails and probes. */
export function drawPlannerFrame(
  ctx: Ctx2D,
  {
    frame,
    view,
    canvasWidth,
    canvasHeight,
  }: { frame: PlannerFrame | null; view: View; canvasWidth: number; canvasHeight: number },
): void {
  if (!frame) return;
  drawPath(ctx, {
    path: frame.path,
    lockedUntilTick: frame.lockedUntilTick,
    view,
    canvasWidth,
    canvasHeight,
  });
  drawNodes(ctx, { nodes: frame.nodes, view, canvasWidth, canvasHeight });
  drawHandle(ctx, { handle: frame.handle, view, canvasWidth, canvasHeight });
  drawEvents(ctx, { frame, view, canvasWidth, canvasHeight });
  drawLaunchVector(ctx, { vector: frame.launchVector, view, canvasWidth, canvasHeight });
  if (frame.commandHorizonMark) {
    const mark = project(
      view,
      canvasWidth,
      canvasHeight,
      frame.commandHorizonMark.x,
      frame.commandHorizonMark.y,
    );
    drawCommandHorizonMark(ctx, { mark: { ...frame.commandHorizonMark, x: mark.x, y: mark.y } });
  }
}
