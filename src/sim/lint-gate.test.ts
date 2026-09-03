// The determinism guard-rails of ADR-0002 must actually fire on src/sim.
import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse');
}

test('src/sim rejects transcendental Math, clocks, ** and outside imports', async () => {
  const code = [
    "import { x } from '../render/plot.ts';",
    "import fs from 'node:fs';",
    'export const a = Math.sin(1) + x + Number(fs);',
    'export const b = 2 ** 3;',
    'export const c = Date.now();',
    'export const d = Math.pow(2, 3);',
    '',
  ].join('\n');
  const ids = await ruleIdsFor(code, `${root}src/sim/fixture.ts`);
  expect(ids.filter((id) => id === 'no-restricted-properties')).toHaveLength(2);
  expect(ids).toContain('no-restricted-syntax');
  expect(ids).toContain('no-restricted-globals');
  expect(ids.filter((id) => id === 'no-restricted-imports')).toHaveLength(2);
});

test('the same code is allowed outside the deterministic core', async () => {
  const ids = await ruleIdsFor(
    'export const a = Math.sin(1) + Date.now();\n',
    `${root}src/render/fixture.ts`,
  );
  expect(ids).toEqual([]);
});

test('deterministic operations and sibling imports stay allowed in the core', async () => {
  const code = [
    "import { y } from './other.ts';",
    'export const a = Math.sqrt(2) + Math.floor(1.5) + Math.imul(3, 4) + Math.abs(-1) + y;',
    '',
  ].join('\n');
  expect(await ruleIdsFor(code, `${root}src/sim/fixture.ts`)).toEqual([]);
});
