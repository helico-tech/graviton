// Bundled committed level solutions (GRV-0023): every levels/*.solution.json is inlined into the
// app bundle at build time via Vite's import.meta.glob, exactly the treatment src/app/levels.ts
// gives the compiled levels themselves -- no runtime fetch, and `?solution=1`/`loadSolution()`
// work from the built page alone.
import type { Command } from '../sim/sim.ts';

export interface CompiledSolution {
  level: string;
  log: Command[];
  ticks: number;
}

const modules = import.meta.glob('../../levels/*.solution.json', {
  eager: true,
  import: 'default',
}) as Record<string, CompiledSolution>;

const solutions = new Map<string, CompiledSolution>();
for (const solution of Object.values(modules)) solutions.set(solution.level, solution);

export function getSolution(levelId: string): CompiledSolution | undefined {
  return solutions.get(levelId);
}
