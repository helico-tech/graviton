// runLevelsSolve: the CLI's write/no-write split, exercised against a temp levels/ dir seeded
// with the real compiled compiler fixture (mirrors levels-verify.test.ts's own style, but this
// module needs a level that is actually solvable, not just the smallest createSim accepts, so it
// copies the real fixture rather than hand-building a scenario).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runLevelsSolve } from './levels-solve.ts';
import { repoRoot } from './lib/repo.ts';

const FIXTURE_ID = 'T00-compiler-fixture';
const SOLVE_OPTIONS = { window: { start: 0, end: 30 }, maxFlightTicks: 260, budget: 4000 };

let levelsDir: string;

beforeEach(() => {
  levelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grv-levels-solve-'));
  fs.copyFileSync(
    path.join(repoRoot, 'levels', `${FIXTURE_ID}.level.json`),
    path.join(levelsDir, `${FIXTURE_ID}.level.json`),
  );
});

afterEach(() => {
  fs.rmSync(levelsDir, { recursive: true, force: true });
});

// A real solve takes ~4 s here and more on CI runners; vitest's default is 5 s.
const SOLVE_TIMEOUT_MS = 120_000;

test(
  'without --write, nothing is written',
  () => {
    const result = runLevelsSolve({ levelsDir, id: FIXTURE_ID, write: false, ...SOLVE_OPTIONS });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(levelsDir, `${FIXTURE_ID}.solution.json`))).toBe(false);
    expect(fs.existsSync(path.join(levelsDir, `${FIXTURE_ID}.evidence.json`))).toBe(false);
  },
  SOLVE_TIMEOUT_MS,
);

test(
  '--write writes both the solution and the regenerated evidence',
  () => {
    const result = runLevelsSolve({ levelsDir, id: FIXTURE_ID, write: true, ...SOLVE_OPTIONS });

    expect(result.ok).toBe(true);
    const solutionPath = path.join(levelsDir, `${FIXTURE_ID}.solution.json`);
    const evidencePath = path.join(levelsDir, `${FIXTURE_ID}.evidence.json`);
    expect(fs.existsSync(solutionPath)).toBe(true);
    expect(fs.existsSync(evidencePath)).toBe(true);

    const solution = JSON.parse(fs.readFileSync(solutionPath, 'utf8'));
    expect(solution.level).toBe(FIXTURE_ID);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    expect(evidence.outcome.contactsCleared).toBe(evidence.outcome.contactsTotal);
  },
  SOLVE_TIMEOUT_MS,
);

test('a level with no level.json file fails cleanly', () => {
  const result = runLevelsSolve({ levelsDir, id: 'does-not-exist', write: false });
  expect(result.ok).toBe(false);
  expect(result.message).toContain('not found');
});

test('an unsolvable level reports a failure without writing anything', () => {
  const level = JSON.parse(
    fs.readFileSync(path.join(levelsDir, `${FIXTURE_ID}.level.json`), 'utf8'),
  );
  // Make the contact unreachable within the given window/flight budget: push its capture radius
  // down to nothing and shrink the window so no direct launch can possibly clear it.
  level.scenario.contacts[0].captureRadius = 0.001;
  fs.writeFileSync(path.join(levelsDir, 'tiny.level.json'), JSON.stringify(level));

  const result = runLevelsSolve({
    levelsDir,
    id: 'tiny',
    write: true,
    window: { start: 0, end: 2 },
    maxFlightTicks: 5,
    budget: 200,
  });

  expect(result.ok).toBe(false);
  expect(result.message).toContain('FAILED to solve');
  expect(fs.existsSync(path.join(levelsDir, 'tiny.solution.json'))).toBe(false);
});
