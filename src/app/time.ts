// Simulated time as `T+dd:hh:mm:ss` (GAME-0001 §4.11, GAME-0002 §8): integer arithmetic over
// `tick * dt` seconds only, never wall time (docs/domain/simulation-determinism.md rule 1).
export function formatSimTime({ tick, dt }: { tick: number; dt: number }): string {
  const totalSeconds = tick * dt;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `T+${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
