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

export interface WarpEaseFrame {
  value: number;
  finished: boolean;
}

// docs/issues/2026-09-18-warp-label-sticks-on-eased-value.md: a real rAF loop's frame spacing is
// irregular, so no frame is guaranteed to land with `elapsedMs` anywhere near `durationMs` -- one
// frame can sit just under it and the next jump straight past. The label previously stopped
// updating once a frame crossed `durationMs`, trusting that the last write (at whatever fraction
// the previous frame happened to land on) was already exact; it usually wasn't, so the label
// stuck mid-ease. `warpEaseFrame` is the one thing a caller needs each frame: the value to show
// and whether to keep animating -- once finished, `value` is always exactly `to`, regardless of
// how far `elapsedMs` overshot `durationMs`.
export function warpEaseFrame({
  from,
  to,
  elapsedMs,
  durationMs = WARP_EASE_MS,
}: {
  from: number;
  to: number;
  elapsedMs: number;
  durationMs?: number;
}): WarpEaseFrame {
  if (elapsedMs >= durationMs) return { value: to, finished: true };
  return { value: easedWarpValue({ from, to, elapsedMs, durationMs }), finished: false };
}
