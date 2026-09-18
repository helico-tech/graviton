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
import { ALARM, CONFIRMED_GOOD, KNOWN, LINE_STYLES, MONO_FONT_FAMILY } from './palette.ts';
import type { Ctx2D } from './ctx2d.ts';
import { HEADING_TURN } from '../sim/commands.ts';
import type { Ghost } from '../planner/ghost.ts';
import type { FlightPlan } from '../planner/plan.ts';

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

function ghostNodes(ghost: Ghost, plan: FlightPlan): GhostRenderNode[] {
  const nodes: GhostRenderNode[] = [];
  plan.nodes.forEach((node, index) => {
    const sample = sampleAt(ghost, node.atTick);
    if (sample) nodes.push({ x: sample.x, y: sample.y, index });
  });
  return nodes;
}

/** The selected node's prograde (along the ghost's own velocity at its tick) and lateral (+90
 *  degrees, left of velocity -- plan.ts's own BurnNode doc) handle tips, a fixed screen length out
 *  from the node -- a drag affordance, not a magnitude readout (the PLAN panel shows the exact
 *  mm/s). `null` if there is no selection or the ghost never reached that tick. */
function ghostHandle({
  ghost,
  plan,
  selectedNode,
  view,
}: {
  ghost: Ghost;
  plan: FlightPlan;
  selectedNode: number | null;
  view: View;
}): GhostRenderHandle | null {
  if (selectedNode === null) return null;
  const node = plan.nodes[selectedNode];
  if (!node) return null;
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

/** Ghost + FlightPlan -> plain world-space geometry (never screen space -- `drawPlannerFrame`
 *  below projects it, mirroring how `renderPlot` projects trails itself). `launchOrigin` is the
 *  rail's current world position (Frame.rails[plan.rail], already computed by captureFrame) and
 *  is read only while a launch drag is actually live -- released, the ghost path itself is the
 *  primary read, not a straight preview arrow. */
export function buildPlannerFrame({
  plan,
  ghost,
  selectedNode,
  launchOrigin,
  view,
}: {
  plan: FlightPlan | null;
  ghost: Ghost | null;
  selectedNode: number | null;
  launchOrigin: { x: number; y: number } | null;
  view: View;
}): PlannerFrame | null {
  if (!plan) return null;
  return {
    path: ghost ? ghostPath(ghost) : [],
    nodes: ghost ? ghostNodes(ghost, plan) : [],
    handle: ghost ? ghostHandle({ ghost, plan, selectedNode, view }) : null,
    events: ghost ? ghostEvents(ghost) : [],
    launchVector: launchOrigin
      ? launchVectorPreview({ plan, originX: launchOrigin.x, originY: launchOrigin.y })
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

function drawPath(
  ctx: Ctx2D,
  {
    path,
    view,
    canvasWidth,
    canvasHeight,
  }: { path: readonly GhostPathPoint[]; view: View; canvasWidth: number; canvasHeight: number },
): void {
  if (path.length < 2) return;
  ctx.beginPath();
  const first = project(view, canvasWidth, canvasHeight, path[0]!.x, path[0]!.y);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < path.length; i++) {
    const p = project(view, canvasWidth, canvasHeight, path[i]!.x, path[i]!.y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = LINE_STYLES.ghost.color;
  ctx.lineWidth = 1;
  ctx.setLineDash([...LINE_STYLES.ghost.dash]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Burn nodes as small filled squares (GAME-0002 §7): every node is amendable until signal delay
 *  exists (a later epic, YAGNI here), so every node draws filled, never hollow. */
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
    drawMarker(ctx, {
      x: p.x,
      y: p.y,
      shape: 'square',
      radius: NODE_MARKER_RADIUS_PX,
      color: KNOWN,
    });
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
  drawPath(ctx, { path: frame.path, view, canvasWidth, canvasHeight });
  drawNodes(ctx, { nodes: frame.nodes, view, canvasWidth, canvasHeight });
  drawHandle(ctx, { handle: frame.handle, view, canvasWidth, canvasHeight });
  drawEvents(ctx, { frame, view, canvasWidth, canvasHeight });
  drawLaunchVector(ctx, { vector: frame.launchVector, view, canvasWidth, canvasHeight });
}
