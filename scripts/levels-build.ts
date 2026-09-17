// Compiles every levels/*.level.yaml to canonical JSON beside it and regenerates the editor
// JSON Schema (docs/work/GRV-0016-level-compiler.md). `--check` writes nothing and exits 1 if any
// output is stale, missing, or any level has issues -- the staleness half of `pnpm check`.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, compileLevel } from '../src/levels/compile.ts';
import { generateLevelJsonSchema } from '../src/levels/schema.ts';
import { parseFlags, repoRoot } from './lib/repo.ts';

function formatIssue(
  relPath: string,
  issue: { line: number; column: number; severity: string; message: string },
): string {
  return `${relPath}:${issue.line}:${issue.column} ${issue.severity} ${issue.message}`;
}

/** Writes `content` to `outputPath` unless `check` is set, in which case it only compares
 *  `content` against whatever is already there. Returns a staleness message when the file would
 *  change (or is missing) under `check`, `null` otherwise. */
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
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content);
    return null;
  }
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
  if (current === content) return null;
  return `${relPath}: stale or missing (run pnpm levels:build)`;
}

export interface BuildLevelsResult {
  ok: boolean;
  messages: string[];
}

export function buildLevels({
  levelsDir,
  check,
}: {
  levelsDir: string;
  check: boolean;
}): BuildLevelsResult {
  const messages: string[] = [];
  let ok = true;

  const names = fs.existsSync(levelsDir)
    ? fs
        .readdirSync(levelsDir)
        .filter((name) => name.endsWith('.level.yaml'))
        .sort()
    : [];

  for (const name of names) {
    const filePath = path.join(levelsDir, name);
    const relPath = path.relative(repoRoot, filePath);
    const result = compileLevel({ source: fs.readFileSync(filePath, 'utf8'), path: filePath });

    for (const warning of result.warnings) messages.push(formatIssue(relPath, warning));

    if ('issues' in result) {
      ok = false;
      for (const issue of result.issues) messages.push(formatIssue(relPath, issue));
      continue;
    }

    const outputPath = path.join(levelsDir, `${result.level.id}.level.json`);
    const stale = writeOrCheck({ outputPath, content: canonicalJson(result.level), check });
    if (stale) {
      ok = false;
      messages.push(stale);
    }
  }

  const schemaPath = path.join(levelsDir, 'schema', 'level.schema.json');
  const schemaStale = writeOrCheck({
    outputPath: schemaPath,
    content: canonicalJson(generateLevelJsonSchema()),
    check,
  });
  if (schemaStale) {
    ok = false;
    messages.push(schemaStale);
  }

  return { ok, messages };
}

if (import.meta.main) {
  const { flags } = parseFlags(process.argv.slice(2));
  const check = flags.check === 'true';
  const result = buildLevels({ levelsDir: path.join(repoRoot, 'levels'), check });
  for (const message of result.messages) console.error(message);
  console.log(result.ok ? 'levels: ok' : 'levels: failed');
  process.exit(result.ok ? 0 : 1);
}
