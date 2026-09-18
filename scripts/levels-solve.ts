// Finds a command log for one level and, with `--write`, commits it plus its regenerated
// evidence (docs/work/GRV-0018-level-solver.md). Mirrors levels-verify.ts's own write/no-write
// split: without `--write`, nothing on disk changes; with it, both `<id>.solution.json` and
// `<id>.evidence.json` are written through the same canonicalJson/verifyLevel path
// levels-verify.ts uses, so a solved level is immediately in the same state `pnpm levels:verify`
// would leave it in.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/levels/compile.ts';
import type { CompiledLevel } from '../src/levels/compile.ts';
import { solveLevel } from '../src/levels/solve.ts';
import type { ProgressEvent, SolveWindow } from '../src/levels/solve.ts';
import { verifyLevel } from '../src/levels/verify.ts';
import { parseFlags, repoRoot } from './lib/repo.ts';

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

export interface RunLevelsSolveArgs {
  levelsDir: string;
  id: string;
  write: boolean;
  window?: SolveWindow;
  maxFlightTicks?: number;
  budget?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export interface RunLevelsSolveResult {
  ok: boolean;
  message: string;
}

export function runLevelsSolve({
  levelsDir,
  id,
  write,
  window,
  maxFlightTicks,
  budget,
  onProgress,
}: RunLevelsSolveArgs): RunLevelsSolveResult {
  const levelPath = path.join(levelsDir, `${id}.level.json`);
  if (!fs.existsSync(levelPath))
    return {
      ok: false,
      message: `levels: ${id} not found (${path.relative(repoRoot, levelPath)})`,
    };

  const levelJson = fs.readFileSync(levelPath, 'utf8');
  const level = JSON.parse(levelJson) as CompiledLevel;
  const result = solveLevel({ level, options: { window, maxFlightTicks, budget }, onProgress });

  if ('failure' in result) {
    const bestSummary = result.best
      .map((b) => `${b.contactId}=${b.missKm.toFixed(3)}km`)
      .join(', ');
    return {
      ok: false,
      message: `levels: ${id} FAILED to solve: ${result.failure} (best: ${bestSummary})`,
    };
  }

  if (!write) return { ok: true, message: `levels: ${id} solved (not written -- pass --write)` };

  const solutionPath = path.join(levelsDir, `${id}.solution.json`);
  const solutionJson = canonicalJson(result.solution);
  fs.writeFileSync(solutionPath, solutionJson);

  const { evidence, failures } = verifyLevel({
    level,
    levelHash: sha256(levelJson),
    solution: result.solution,
    solutionHash: sha256(solutionJson),
  });
  const evidencePath = path.join(levelsDir, `${id}.evidence.json`);
  fs.writeFileSync(evidencePath, canonicalJson(evidence));

  if (failures.length > 0)
    return {
      ok: false,
      message: `levels: ${id} solved and written, but verify FAILED: ${failures.join('; ')}`,
    };
  return {
    ok: true,
    message: `levels: ${id} solved and written (${path.relative(repoRoot, solutionPath)}, ${path.relative(repoRoot, evidencePath)})`,
  };
}

if (import.meta.main) {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const id = positional[0];
  if (!id) {
    console.error(
      'usage: levels-solve <id> [--write] [--window <ticks>] [--max-flight <ticks>] [--budget <evals>]',
    );
    process.exit(1);
  }

  const write = flags.write === 'true';
  const windowEnd = flags.window ? Number(flags.window) : undefined;
  const maxFlightTicks = flags['max-flight'] ? Number(flags['max-flight']) : undefined;
  const budget = flags.budget ? Number(flags.budget) : undefined;

  const result = runLevelsSolve({
    levelsDir: path.join(repoRoot, 'levels'),
    id,
    write,
    window: windowEnd !== undefined ? { start: 0, end: windowEnd } : undefined,
    maxFlightTicks,
    budget,
    onProgress: (event) =>
      console.error(`${event.stage}: ${event.evals} evals, best ${event.bestMissKm.toFixed(3)} km`),
  });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
