// Replays every level's solution and writes its evidence file beside it (ADR-0006 §5, docs/work/
// GRV-0017-level-verifier-and-evidence.md). Mirrors levels-build.ts's --check semantics: without
// it, writes `<id>.evidence.json`; with it, writes nothing and fails if the evidence on disk
// would change. A campaign level (id starting with `L`) with no solution fails -- `pnpm check`
// must prove every campaign level solvable (GRV-0019, GAME-0001 §9's data-driven campaign). A
// fixture (id starting with `T`, or anything else not yet following the campaign convention) with
// no solution is only reported, unchanged from GRV-0017.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/levels/compile.ts';
import type { CompiledLevel } from '../src/levels/compile.ts';
import { verifyLevel } from '../src/levels/verify.ts';
import type { LevelSolution } from '../src/levels/verify.ts';
import { parseFlags, repoRoot } from './lib/repo.ts';

const LEVEL_SUFFIX = '.level.json';

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Writes `content` to `outputPath` unless `check` is set, in which case it only compares
 *  `content` against whatever is already there (mirrors levels-build.ts's own helper). Returns a
 *  staleness message when the file would change (or is missing) under `check`, `null` otherwise. */
function writeOrCheck({
  outputPath,
  content,
  check,
}: {
  outputPath: string;
  content: string;
  check: boolean;
}): string | null {
  const relPath = path.relative(repoRoot, outputPath);
  if (!check) {
    fs.writeFileSync(outputPath, content);
    return null;
  }
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
  if (current === content) return null;
  return `${relPath}: stale or missing (run pnpm levels:verify)`;
}

export interface VerifyLevelsResult {
  ok: boolean;
  messages: string[];
}

export function verifyLevels({
  levelsDir,
  check,
}: {
  levelsDir: string;
  check: boolean;
}): VerifyLevelsResult {
  const messages: string[] = [];
  let ok = true;

  const levelFiles = fs.existsSync(levelsDir)
    ? fs
        .readdirSync(levelsDir)
        .filter((name) => name.endsWith(LEVEL_SUFFIX))
        .sort()
    : [];

  for (const name of levelFiles) {
    const id = name.slice(0, -LEVEL_SUFFIX.length);
    const levelPath = path.join(levelsDir, name);
    const solutionPath = path.join(levelsDir, `${id}.solution.json`);

    if (!fs.existsSync(solutionPath)) {
      if (id.startsWith('L')) {
        ok = false;
        messages.push(`levels: ${id} FAILED: no solution`);
      } else {
        messages.push(`levels: ${id} no solution`);
      }
      continue;
    }

    const levelJson = fs.readFileSync(levelPath, 'utf8');
    const solutionJson = fs.readFileSync(solutionPath, 'utf8');
    const level = JSON.parse(levelJson) as CompiledLevel;
    const solution = JSON.parse(solutionJson) as LevelSolution;

    const { evidence, failures } = verifyLevel({
      level,
      levelHash: sha256(levelJson),
      solution,
      solutionHash: sha256(solutionJson),
    });

    const evidencePath = path.join(levelsDir, `${id}.evidence.json`);
    const stale = writeOrCheck({
      outputPath: evidencePath,
      content: canonicalJson(evidence),
      check,
    });
    if (stale) {
      ok = false;
      messages.push(stale);
    }

    if (failures.length > 0) {
      ok = false;
      messages.push(`levels: ${id} FAILED: ${failures.join('; ')}`);
    } else {
      messages.push(`levels: ${id} ok`);
    }
  }

  return { ok, messages };
}

if (import.meta.main) {
  const { flags } = parseFlags(process.argv.slice(2));
  const check = flags.check === 'true';
  const result = verifyLevels({ levelsDir: path.join(repoRoot, 'levels'), check });
  for (const message of result.messages) console.log(message);
  process.exit(result.ok ? 0 : 1);
}
