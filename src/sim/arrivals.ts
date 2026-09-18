// The light-cone pending-arrivals queue (ADR-0007 §2-3, GRV-0029): every command already
// validated at its issue tick, waiting for the tick its uplink actually arrives. Split out of
// sim.ts/commands.ts so neither needs a runtime import of the other (sim.ts's `advance` calls into
// commands.ts already; commands.ts only ever needs `Sim`'s *type*) -- both import this module
// instead, at runtime, with no cycle.

// A plain word, not Command['kind']'s string literal, so hashSim/serializeSim (sim.ts) never
// hash/write a string (ADR-0002's raw-bits-only state).
export const ARRIVAL_KIND_LAUNCH = 0;
export const ARRIVAL_KIND_BURN = 1;

/** A command already validated at its issue tick, waiting for its light-cone arrival
 *  (commands.ts's `applyCommand`): every command whose arrival is later than its issue tick lands
 *  here instead of taking effect immediately (`materializeArrival`, commands.ts, is what finally
 *  applies it). Kept sorted by `arrivalTick`, ties broken by insertion (= issue) order -- the same
 *  insertion-sort/stable-shift shape as `PendingBurnNodes` (sim.ts), generalised to a fixed set of
 *  float64 payload slots so one queue serves both command kinds (`a`/`b`/`c`/`d` read as
 *  rail/heading/speed for a launch, probe/atTick/prograde/lateral for a burn -- `d` unused by a
 *  launch). Float64, not Int32: a launch's `speed` field is validated up to
 *  `Number.MAX_SAFE_INTEGER` (commands.ts), well past Int32 range. State: hashed and serialised in
 *  this same (arrival, then issue) order (sim.ts). */
export interface PendingArrivals {
  arrivalTick: Int32Array;
  kind: Uint8Array;
  tick: Float64Array;
  a: Float64Array;
  b: Float64Array;
  c: Float64Array;
  d: Float64Array;
  count: number;
}

/** capacity + burnNodeCapacity: a generous, static upper bound on how many issued-but-not-yet-
 *  arrived commands can coexist (at most one per eventual live object, plus one per concurrently
 *  in-flight burn node -- `PendingBurnNodes`' own capacity already bounds the latter), matching
 *  `PendingBurnNodes`' own sizing philosophy rather than a tight theoretical count. */
export function createPendingArrivals(capacity: number): PendingArrivals {
  return {
    arrivalTick: new Int32Array(capacity),
    kind: new Uint8Array(capacity),
    tick: new Float64Array(capacity),
    a: new Float64Array(capacity),
    b: new Float64Array(capacity),
    c: new Float64Array(capacity),
    d: new Float64Array(capacity),
    count: 0,
  };
}

/** Inserts a command already known to have arrival `arrivalTick`, keeping the queue sorted by
 *  `arrivalTick` with ties in insertion (issue) order. */
export function enqueuePendingArrival({
  pending,
  arrivalTick,
  kind,
  tick,
  a,
  b,
  c,
  d,
}: {
  pending: PendingArrivals;
  arrivalTick: number;
  kind: number;
  tick: number;
  a: number;
  b: number;
  c: number;
  d: number;
}): void {
  if (pending.count >= pending.arrivalTick.length)
    throw new Error(`pendingArrivals: capacity ${pending.arrivalTick.length} exceeded`);

  let p = pending.count;
  while (p > 0 && pending.arrivalTick[p - 1]! > arrivalTick) {
    pending.arrivalTick[p] = pending.arrivalTick[p - 1]!;
    pending.kind[p] = pending.kind[p - 1]!;
    pending.tick[p] = pending.tick[p - 1]!;
    pending.a[p] = pending.a[p - 1]!;
    pending.b[p] = pending.b[p - 1]!;
    pending.c[p] = pending.c[p - 1]!;
    pending.d[p] = pending.d[p - 1]!;
    p--;
  }
  pending.arrivalTick[p] = arrivalTick;
  pending.kind[p] = kind;
  pending.tick[p] = tick;
  pending.a[p] = a;
  pending.b[p] = b;
  pending.c[p] = c;
  pending.d[p] = d;
  pending.count++;
}

/** Removes the entry at `index` with a stable shift (mirrors `PendingBurnNodes`' own
 *  `removePendingNode`, sim.ts): keeps the remaining entries sorted. */
export function removePendingArrival(pending: PendingArrivals, index: number): void {
  pending.count--;
  for (let j = index; j < pending.count; j++) {
    pending.arrivalTick[j] = pending.arrivalTick[j + 1]!;
    pending.kind[j] = pending.kind[j + 1]!;
    pending.tick[j] = pending.tick[j + 1]!;
    pending.a[j] = pending.a[j + 1]!;
    pending.b[j] = pending.b[j + 1]!;
    pending.c[j] = pending.c[j + 1]!;
    pending.d[j] = pending.d[j + 1]!;
  }
}

/** Finds a same-tick, still-pending launch whose future object index will be the probe a bundled
 *  burn command targets (ADR-0007's "a burn command issued at a tick when its probe does not
 *  exist yet is queued with the arrival tick of the launch that creates it, provided it is in the
 *  same issue batch"): scans for a launch issued at `issueTick` -- `planToCommands` (plan.ts) only
 *  ever issues a plan's launch and its own nodes at the identical tick, and the launch always
 *  sorts first in the log (plan.ts's own doc), so by the time a bundled burn is validated the
 *  matching launch is already enqueued here. Returns its arrival tick, or -1 if none matches (a
 *  genuinely unknown probe, commands.ts's own thrown case). */
export function pendingLaunchArrivalAt({
  pending,
  issueTick,
}: {
  pending: PendingArrivals;
  issueTick: number;
}): number {
  for (let i = 0; i < pending.count; i++) {
    if (pending.kind[i] === ARRIVAL_KIND_LAUNCH && pending.tick[i] === issueTick)
      return pending.arrivalTick[i]!;
  }
  return -1;
}
