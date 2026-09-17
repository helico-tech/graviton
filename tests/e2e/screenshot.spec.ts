// Runs scripts/screenshot.ts as a real child process against the built
// dist/ (docs/work/GRV-0012). `pnpm e2e` builds first, so dist/ already
// matches HEAD; this only needs to run once, not once per Playwright
// project, since it never opens a `page` of its own.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function runScreenshot(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('node', ['scripts/screenshot.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    return { status: failure.status, stdout: failure.stdout };
  }
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'runs the script once, not once per project');
});

test('succeeds and writes a PNG when the build matches', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grv-screenshot-')), 'shot.png');

  const { status, stdout } = runScreenshot(['--out', out, '--expect-build', headSha]);

  expect(status).toBe(0);
  const summary = JSON.parse(stdout.trim());
  expect(summary).toMatchObject({ build: headSha, expected: headSha, violations: [], out });

  const bytes = fs.readFileSync(out);
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(bytes.byteLength).toBeGreaterThan(1000);
});

test('exits non-zero when --expect-build does not match', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grv-screenshot-')), 'shot.png');

  const { status, stdout } = runScreenshot(['--out', out, '--expect-build', '0000000']);

  expect(status).not.toBe(0);
  const summary = JSON.parse(stdout.trim());
  expect(summary.build).toBe(headSha);
  expect(summary.expected).toBe('0000000');
  // The build mismatch is the only reason for the non-zero exit here.
  expect(summary.violations).toEqual([]);
});
