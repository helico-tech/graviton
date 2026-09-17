// Static guard for "no YAML parser and no valibot in the app bundle" (docs/work/GRV-0016-level-
// compiler.md): nothing under src/app or src/sim may import 'yaml', 'valibot', or the compiler's
// own internals. A regex-based import-graph walk is enough here -- the real proof is the built
// dist/ grep recorded in docs/evidence/GRV-0016/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { repoRoot } from '../../scripts/lib/repo.ts';

const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const BANNED_PACKAGES = new Set(['yaml', 'valibot', '@valibot/to-json-schema']);
const BANNED_LEVELS_MODULE = /\/levels\/(compile|schema|units)(?:\.ts)?$/;

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function importSpecifiers(file: string): string[] {
  return [...fs.readFileSync(file, 'utf8').matchAll(IMPORT_RE)].map((m) => m[1]!);
}

function isBanned(specifier: string): boolean {
  return BANNED_PACKAGES.has(specifier) || BANNED_LEVELS_MODULE.test(specifier);
}

describe('src/app and src/sim never import the level compiler or its dependencies', () => {
  test.each(['src/app', 'src/sim'])('%s has no forbidden import', (root) => {
    const dir = path.join(repoRoot, root);
    const offenders = allSourceFiles(dir).flatMap((file) =>
      importSpecifiers(file)
        .filter(isBanned)
        .map((spec) => `${path.relative(repoRoot, file)} imports "${spec}"`),
    );
    expect(offenders).toEqual([]);
  });
});
