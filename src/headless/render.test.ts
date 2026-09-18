// `pnpm render`'s flag parsing and its `renderLevel` core (GRV-0022), against the real,
// committed L01-intercept level and solution -- the same fixture tests/render/plot.test.ts uses.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseRenderFlags, renderLevel } from './render.ts';
import { repoRoot } from '../../scripts/lib/repo.ts';

describe('parseRenderFlags', () => {
  test('defaults width/height to 1280x720 and solution to false', () => {
    expect(parseRenderFlags(['--level', 'L01-intercept', '--out', 'x.png'])).toEqual({
      level: 'L01-intercept',
      tick: undefined,
      zoom: undefined,
      cx: undefined,
      cy: undefined,
      width: 1280,
      height: 720,
      solution: false,
      out: 'x.png',
    });
  });

  test('parses every flag', () => {
    const flags = parseRenderFlags([
      '--level',
      'L01-intercept',
      '--tick',
      '600',
      '--zoom',
      '5000',
      '--cx',
      '1e9',
      '--cy',
      '-2e8',
      '--w',
      '960',
      '--h',
      '540',
      '--solution',
      '--out',
      'x.png',
    ]);
    expect(flags).toEqual({
      level: 'L01-intercept',
      tick: 600,
      zoom: 5000,
      cx: 1e9,
      cy: -2e8,
      width: 960,
      height: 540,
      solution: true,
      out: 'x.png',
    });
  });

  test('--level and --out are required', () => {
    expect(() => parseRenderFlags(['--out', 'x.png'])).toThrow(/--level/);
    expect(() => parseRenderFlags(['--level', 'L01-intercept'])).toThrow(/--out/);
  });

  test('--select <kind>:<index> parses through src/app/selection.ts, shared rather than reimplemented', () => {
    const flags = parseRenderFlags([
      '--level',
      'L01-intercept',
      '--select',
      'probe:0',
      '--out',
      'x.png',
    ]);
    expect(flags.select).toEqual({ kind: 'probe', index: 0 });
  });

  test('--select rejects a malformed value the same way parseSelectionParam does', () => {
    expect(() =>
      parseRenderFlags(['--level', 'L01-intercept', '--select', 'nope', '--out', 'x.png']),
    ).toThrow();
  });
});

describe('renderLevel', () => {
  const outputs: string[] = [];
  afterEach(() => {
    for (const out of outputs.splice(0)) fs.rmSync(out, { force: true });
  });

  function scratchPath(name: string): string {
    const out = path.join(repoRoot, 'runs', name);
    outputs.push(out);
    return out;
  }

  test('writes a PNG and reports tick 0 for a fresh level with no --tick', () => {
    const out = scratchPath('render-test-default.png');
    const result = renderLevel({
      level: 'L01-intercept',
      width: 320,
      height: 180,
      solution: false,
      out,
    });

    expect(result.tick).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  test("--solution with no --tick advances to the solution log's own tick count", () => {
    const out = scratchPath('render-test-solution.png');
    const solution = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'levels/L01-intercept.solution.json'), 'utf8'),
    ) as { ticks: number };

    const result = renderLevel({
      level: 'L01-intercept',
      width: 320,
      height: 180,
      solution: true,
      out,
    });

    expect(result.tick).toBe(solution.ticks);
  });

  test('--solution --tick stops exactly there, and the contact is cleared once past its impact tick', () => {
    const evidence = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'levels/L01-intercept.evidence.json'), 'utf8'),
    ) as { contacts: { impactTick: number }[] };
    const impactTick = evidence.contacts[0]!.impactTick;

    const before = renderLevel({
      level: 'L01-intercept',
      tick: impactTick,
      width: 320,
      height: 180,
      solution: true,
      out: scratchPath('render-test-before-impact.png'),
    });
    const after = renderLevel({
      level: 'L01-intercept',
      tick: impactTick + 1,
      width: 320,
      height: 180,
      solution: true,
      out: scratchPath('render-test-after-impact.png'),
    });

    expect(before.tick).toBe(impactTick);
    expect(after.tick).toBe(impactTick + 1);
    expect(before.hash).not.toBe(after.hash);
  });

  test('--select draws the ring, changing the frame hash from an unselected render of the same tick', () => {
    const args = {
      level: 'L01-intercept',
      tick: 100,
      width: 320,
      height: 180,
      solution: false,
    } as const;
    const unselected = renderLevel({ ...args, out: scratchPath('render-test-select-none.png') });
    const selected = renderLevel({
      ...args,
      select: { kind: 'rail', index: 0 },
      out: scratchPath('render-test-select-rail.png'),
    });
    expect(selected.frameHash).not.toBe(unselected.frameHash);
  });

  test('two renders of the same tick are byte-identical (determinism)', () => {
    const args = {
      level: 'L01-intercept',
      tick: 100,
      width: 320,
      height: 180,
      solution: false,
    };
    const a = renderLevel({ ...args, out: scratchPath('render-test-det-a.png') });
    const b = renderLevel({ ...args, out: scratchPath('render-test-det-b.png') });
    expect(a.frameHash).toBe(b.frameHash);
    expect(a.hash).toBe(b.hash);
  });
});
