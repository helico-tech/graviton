// Proves the committed fixture artefact is loadable by the real simulation, not just valid JSON
// (docs/work/GRV-0016-level-compiler.md).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { advance, createSim } from '../sim/sim.ts';
import type { Scenario } from '../sim/sim.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';

interface CompiledFixture {
  seed: number;
  scenario: Scenario;
}

describe('the compiled fixture level', () => {
  test('loads into createSim and advances a few hundred ticks without throwing', () => {
    const raw = fs.readFileSync(
      path.join(repoRoot, 'levels', 'T00-compiler-fixture.level.json'),
      'utf8',
    );
    const compiled = JSON.parse(raw) as CompiledFixture;

    const sim = createSim({ scenario: compiled.scenario, seed: compiled.seed });

    expect(() => advance({ sim, log: [], ticks: 300 })).not.toThrow();
    expect(sim.tick).toBe(300);
  });
});
