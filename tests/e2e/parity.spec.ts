// Cross-engine hash parity (ADR-0002 guard-rail 5, ADR-0004 §1, docs/work/
// GRV-0011, docs/issues/2026-09-17-cross-engine-hash-parity-test-missing.md):
// runs against real Chromium and Firefox, built dist/ served over HTTP by
// playwright.config.ts's webServer. Uses the shared console gate (GRV-0012)
// with failOnAnyConsoleMessage, matching this spec's original inline gate
// that failed on every console message, not just errors and warnings.
//
// GRV-0015: every golden in tests/golden/ is replayed, not just
// flyby-burn.json -- a loop over the directory listing, not a hardcoded name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Command, Scenario } from '../../src/sim/sim.ts';
import { attachConsoleGate } from './console-gate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(here, '../../tests/golden');

interface GoldenFile {
  scenario: Scenario;
  seed: number;
  log: Command[];
  ticks: number;
  expectedHash: string;
  simVersion: number;
}

function goldenNames(): string[] {
  return fs.readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json'));
}

function readGolden(name: string): GoldenFile {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), 'utf8')) as GoldenFile;
}

/** Splits `totalTicks` into several unequal, positive batches summing to the
 *  total, so the incremental replay never advances by the same amount twice. */
function unevenBatches(totalTicks: number): number[] {
  const ratios = [0.05, 0.4, 0.1, 0.3, 0.15];
  const batches = ratios.slice(0, -1).map((r) => Math.round(totalTicks * r));
  batches.push(totalTicks - batches.reduce((sum, b) => sum + b, 0));
  return batches;
}

for (const name of goldenNames()) {
  test.describe(`golden: ${name}`, () => {
    test('run() replays the golden log and matches the Node hash', async ({ page }) => {
      const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
      const golden = readGolden(name);

      await page.goto('/?debug=1');
      await page.waitForFunction(() => window.graviton?.ready === true);

      const result = await page.evaluate(
        (args: { scenario: Scenario; seed: number; log: Command[]; ticks: number }) =>
          window.graviton!.run(args),
        { scenario: golden.scenario, seed: golden.seed, log: golden.log, ticks: golden.ticks },
      );
      const version = await page.evaluate(() => window.graviton!.version);

      expect(result.hash).toBe(golden.expectedHash);
      expect(result.tick).toBe(golden.ticks);
      expect(version.sim).toBe(golden.simVersion);
      expect(gate.violations()).toEqual([]);
    });

    test('load/command/step in uneven batches replays the same golden log to the same hash', async ({
      page,
    }) => {
      const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
      const golden = readGolden(name);

      await page.goto('/?debug=1');
      await page.waitForFunction(() => window.graviton?.ready === true);

      await page.evaluate(
        (args: { scenario: Scenario; seed: number }) => window.graviton!.load(args),
        { scenario: golden.scenario, seed: golden.seed },
      );
      for (const command of golden.log) {
        await page.evaluate((cmd: Command) => window.graviton!.command(cmd), command);
      }
      for (const ticks of unevenBatches(golden.ticks)) {
        await page.evaluate((batch: number) => window.graviton!.step(batch), ticks);
      }

      const hash = await page.evaluate(() => window.graviton!.hash());

      expect(hash).toBe(golden.expectedHash);
      expect(gate.violations()).toEqual([]);
    });
  });
}

test('window.graviton is not installed without ?debug=1', async ({ page }) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });

  await page.goto('/');
  const graviton = await page.evaluate(() => window.graviton);

  expect(graviton).toBeUndefined();
  expect(gate.violations()).toEqual([]);
});
