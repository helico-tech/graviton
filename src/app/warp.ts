// The warp ladder (GAME-0001 §4.11): ticks advanced per rendered frame at each rung. Rung 0 is
// paused; `dt` never changes -- warp only ever changes how many whole ticks a frame advances
// (docs/domain/simulation-determinism.md rule 3).
export const WARP_LADDER = [0, 1, 10, 100, 1000, 10000] as const;
export type WarpRung = number;

export function clampRung(rung: number): WarpRung {
  return Math.min(Math.max(Math.trunc(rung), 0), WARP_LADDER.length - 1);
}

export function ticksPerFrame(rung: WarpRung): number {
  return WARP_LADDER[clampRung(rung)]!;
}

export function stepRung(rung: WarpRung, direction: 1 | -1): WarpRung {
  return clampRung(rung + direction);
}

/** Space toggles between paused and whatever non-zero rung was last active, so resuming returns
 *  to the warp the player was actually at rather than always snapping to 1x. */
export function togglePause(rung: WarpRung, lastNonZeroRung: WarpRung): WarpRung {
  return rung === 0 ? clampRung(lastNonZeroRung) : 0;
}
