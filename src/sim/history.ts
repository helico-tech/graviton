// Per-object position/velocity history ring buffer (ADR-0007 §7, research §5.4): the downlink
// solver looks backwards by up to one light delay, so every dynamic object's recent state must
// stay queryable after the live `Sim.objects` arrays have moved on. One ring of `historyTicks`
// entries per object slot, written at the end of every tick for every live object (an expended
// object keeps writing its own frozen state -- simplest, and honest: its "history" really is
// constant from the moment it stopped). Part of `Sim` state: hashed and serialised (sim.ts).

const FLOAT64_BYTES = 8;

export const NEVER_RECORDED = -1;

/** Dense, `[object * historyTicks + slot]` flattened (mirrors DynamicObjects' own convention):
 *  `slot = tick % historyTicks`, so the ring silently overwrites its oldest entry once an object
 *  has lived longer than the retained window. `firstTick`/`lastTick` are the two per-object facts
 *  a ring index alone can't recover: `firstTick` is the launch tick until the ring wraps, at which
 *  point it becomes the oldest *retained* tick; `lastTick` is simply the most recent write. */
export interface HistoryBuffer {
  objectCapacity: number;
  historyTicks: number;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** NEVER_RECORDED until an object's first write; the launch tick from then on. */
  firstWriteTick: Int32Array;
  /** NEVER_RECORDED until an object's first write; the most recent write's tick after that. */
  lastTick: Int32Array;
}

export function createHistoryBuffer({
  objectCapacity,
  historyTicks,
}: {
  objectCapacity: number;
  historyTicks: number;
}): HistoryBuffer {
  const size = objectCapacity * historyTicks;
  const firstWriteTick = new Int32Array(objectCapacity);
  firstWriteTick.fill(NEVER_RECORDED);
  const lastTick = new Int32Array(objectCapacity);
  lastTick.fill(NEVER_RECORDED);
  return {
    objectCapacity,
    historyTicks,
    x: new Float64Array(size),
    y: new Float64Array(size),
    vx: new Float64Array(size),
    vy: new Float64Array(size),
    firstWriteTick,
    lastTick,
  };
}

function slotFor(history: HistoryBuffer, tick: number): number {
  // tick is always >= 0 (determinism rule 1's integer tick counter never goes negative), so a
  // plain modulo is exact -- no sign-correction branch needed.
  return tick % history.historyTicks;
}

/** Writes `object`'s state at `tick` into its ring slot (sim.ts's `advance`, once per live object
 *  at the end of every tick -- module header). Overwrites in place: no allocation. */
export function recordHistory({
  history,
  object,
  tick,
  x,
  y,
  vx,
  vy,
}: {
  history: HistoryBuffer;
  object: number;
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}): void {
  const idx = object * history.historyTicks + slotFor(history, tick);
  history.x[idx] = x;
  history.y[idx] = y;
  history.vx[idx] = vx;
  history.vy[idx] = vy;
  if (history.firstWriteTick[object] === NEVER_RECORDED) history.firstWriteTick[object] = tick;
  history.lastTick[object] = tick;
}

/** The oldest tick `object` still has a retained sample for: its own launch tick while the ring
 *  hasn't wrapped yet, or the oldest tick still inside the window once it has. NEVER_RECORDED if
 *  the object has never been written (never launched, or a capacity slot never used). */
export function firstAvailableTick(history: HistoryBuffer, object: number): number {
  const first = history.firstWriteTick[object]!;
  if (first === NEVER_RECORDED) return NEVER_RECORDED;
  const last = history.lastTick[object]!;
  const oldestRetained = last - history.historyTicks + 1;
  return oldestRetained > first ? oldestRetained : first;
}

export interface SampledState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Cubic Hermite interpolation of `object`'s position and velocity at continuous time `t` seconds,
 *  between the two ring samples bracketing it (research §5.4): C1, exact for the constant-velocity
 *  case that dominates cruise, and it hands the light-cone solvers their derivative term (velocity)
 *  for free. Throws if `t` falls outside the retained window or before the object existed --
 *  callers (lightcone.ts) are expected to check `firstAvailableTick`/`history.lastTick` first when
 *  they need a non-throwing answer. */
export function sampleState({
  history,
  object,
  t,
  dt,
}: {
  history: HistoryBuffer;
  object: number;
  t: number;
  dt: number;
}): SampledState {
  const tickFloat = t / dt;
  const t0 = Math.floor(tickFloat);
  const t1 = t0 + 1;
  const first = firstAvailableTick(history, object);
  const last = history.lastTick[object]!;
  if (first === NEVER_RECORDED || t0 < first || t1 > last) {
    throw new Error(
      `sampleState: object ${object} has no retained sample covering t=${t} (tick ${tickFloat})`,
    );
  }

  const s = tickFloat - t0;
  const i0 = object * history.historyTicks + slotFor(history, t0);
  const i1 = object * history.historyTicks + slotFor(history, t1);
  const x0 = history.x[i0]!;
  const y0 = history.y[i0]!;
  const vx0 = history.vx[i0]!;
  const vy0 = history.vy[i0]!;
  const x1 = history.x[i1]!;
  const y1 = history.y[i1]!;
  const vx1 = history.vx[i1]!;
  const vy1 = history.vy[i1]!;

  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  // Tangents are in tick-normalised (s in [0,1]) space, so a velocity (m/s, per real second) is
  // scaled by dt to become "per tick" before it feeds the Hermite basis.
  const x = h00 * x0 + h10 * dt * vx0 + h01 * x1 + h11 * dt * vx1;
  const y = h00 * y0 + h10 * dt * vy0 + h01 * y1 + h11 * dt * vy1;

  const dh00 = 6 * s2 - 6 * s;
  const dh10 = 3 * s2 - 4 * s + 1;
  const dh01 = -6 * s2 + 6 * s;
  const dh11 = 3 * s2 - 2 * s;
  const vx = (dh00 * x0 + dh10 * dt * vx0 + dh01 * x1 + dh11 * dt * vx1) / dt;
  const vy = (dh00 * y0 + dh10 * dt * vy0 + dh01 * y1 + dh11 * dt * vy1) / dt;

  return { x, y, vx, vy };
}

export const HISTORY_RECORD_BYTES = FLOAT64_BYTES * 4;
