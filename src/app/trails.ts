// A probe's flown trail: a bounded ring buffer of sampled positions, owned by the app rather than
// the sim (GRV-0022 design) -- sampled positions, not derived, so a trail is exactly where the
// probe actually was, never an interpolation. `debug-api.ts`'s `stepSampled` and `app.ts` are the
// only callers that advance a `TrailSet`; `src/render/plot.ts` only ever reads `trailPoints`.

export interface TrailBuffer {
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** How many samples are live (grows to the buffer's length, then stays there). */
  count: number;
  /** Ring index the next sample overwrites. */
  head: number;
}

// Long enough to hold L01-intercept's whole ~3300-tick flight (docs/evidence/GRV-0019/README.md)
// as one continuous trail; a handful of probes at this length costs nothing worth trimming for.
export const TRAIL_CAPACITY = 4096;

export function createTrailBuffer(capacity: number = TRAIL_CAPACITY): TrailBuffer {
  return { x: new Float64Array(capacity), y: new Float64Array(capacity), count: 0, head: 0 };
}

export function pushTrailSample(buffer: TrailBuffer, x: number, y: number): void {
  const capacity = buffer.x.length;
  buffer.x[buffer.head] = x;
  buffer.y[buffer.head] = y;
  buffer.head = (buffer.head + 1) % capacity;
  buffer.count = Math.min(buffer.count + 1, capacity);
}

/** Oldest-to-newest samples, the order `renderPlot` draws a polyline in. */
export function trailPoints(buffer: TrailBuffer): { x: number; y: number }[] {
  const capacity = buffer.x.length;
  const start = buffer.count < capacity ? 0 : buffer.head;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < buffer.count; i++) {
    const index = (start + i) % capacity;
    points.push({ x: buffer.x[index]!, y: buffer.y[index]! });
  }
  return points;
}

/** One buffer per dynamic object index. A launch only ever grows `Sim.objects.count`
 *  (docs/domain/simulation-determinism.md's dense, index-stable arrays), so an object's index
 *  never moves between samples and a buffer is created lazily the first time its index appears. */
export interface TrailSet {
  buffers: TrailBuffer[];
  readonly capacity: number;
}

export function createTrailSet(capacity: number = TRAIL_CAPACITY): TrailSet {
  return { buffers: [], capacity };
}

export function resetTrailSet(trailSet: TrailSet): void {
  trailSet.buffers = [];
}

/** Samples every live object's current position (app.ts/debug-api.ts call this once per
 *  simulation tick advanced, never per rendered frame -- a frame at 10000x warp still produces
 *  one sample per tick underneath it). */
export function sampleTrailSet(
  trailSet: TrailSet,
  positions: readonly { x: number; y: number }[],
): void {
  for (let i = 0; i < positions.length; i++) {
    trailSet.buffers[i] ??= createTrailBuffer(trailSet.capacity);
    pushTrailSample(trailSet.buffers[i]!, positions[i]!.x, positions[i]!.y);
  }
}
