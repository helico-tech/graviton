// Fixed-step frame loop (GAME-0001 §4.11, docs/domain/simulation-determinism.md rules 2-3): a
// frame advances whole ticks only, never a fractional one, and warp changes ticks per frame,
// never `dt`. Pure and DOM-free so it's testable without a browser; main.ts wires it to
// requestAnimationFrame.
import { ticksPerFrame } from './warp.ts';
import type { WarpRung } from './warp.ts';

// Measured throughput is ~86,000 ticks/s for 50 objects at a 60 s timestep (docs/domain/
// simulation-determinism.md "Performance shape"): ~86 ticks/ms. Half of a 16 ms frame leaves the
// other half for layout and paint, so the budget is ~688 ticks/frame, rounded to 700. Every rung
// up to 100 sits comfortably under that; 1000 and 10000 are clamped below their nominal rate, and
// `status.warp.effective` says so rather than pretending the nominal rate was hit.
export const TICK_BUDGET_PER_FRAME = 700;

export function effectiveTicksThisFrame(rung: WarpRung): number {
  return Math.min(ticksPerFrame(rung), TICK_BUDGET_PER_FRAME);
}

// The one permitted transition (GAME-0002 §9): only the *displayed* warp label eases, over about
// 150 ms. The simulation itself always advances by effectiveTicksThisFrame's whole ticks, never a
// fractional one (determinism rule 3) -- this interpolates text, not ticks. main.ts disables it
// entirely in debug mode by never driving an animation frame there.
export const WARP_EASE_MS = 150;

export function easedWarpValue({
  from,
  to,
  elapsedMs,
  durationMs = WARP_EASE_MS,
}: {
  from: number;
  to: number;
  elapsedMs: number;
  durationMs?: number;
}): number {
  const t = Math.min(Math.max(elapsedMs / durationMs, 0), 1);
  return from + (to - from) * t;
}
