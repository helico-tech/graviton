// Playwright screenshot + deploy proof (ADR-0004 §3, §6, docs/work/GRV-0012):
// launches Chromium, loads either `--url` or a locally served dist/, gates
// the console, waits for load and fonts, reads the build SHA off the page,
// writes a PNG and exits non-zero unless the gate is clean and the build
// matches `--expect-build`. Outside src/sim, so console and node builtins
// are fine (ADR-0002).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { attachConsoleGate } from './lib/console-gate.ts';
import { parseFlags, repoRoot } from './lib/repo.ts';
import { serveStatic } from './lib/static-server.ts';

export interface ScreenshotFlags {
  url?: string;
  out: string;
  expectBuild?: string;
  width: number;
  height: number;
  debug: boolean;
}

function positiveInt(flags: Record<string, string>, key: 'w' | 'h', fallback: number): number {
  if (!(key in flags)) return fallback;
  const value = Number(flags[key]);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`screenshot: --${key} must be a positive integer, got ${flags[key]}`);
  return value;
}

export function parseScreenshotFlags(argv: string[]): ScreenshotFlags {
  const { flags } = parseFlags(argv);
  if (!flags.out) throw new Error('screenshot: --out <png> is required');
  return {
    url: flags.url,
    out: flags.out,
    expectBuild: flags['expect-build'],
    width: positiveInt(flags, 'w', 1280),
    height: positiveInt(flags, 'h', 720),
    debug: flags.debug === 'true',
  };
}

/** Compares two SHAs on the shorter one's length, so a 7-char short SHA and
 *  a 40-char full SHA of the same commit are considered equal. Two empty
 *  strings are never a match -- there is nothing to compare. */
export function shaPrefixesMatch(a: string, b: string): boolean {
  const length = Math.min(a.length, b.length);
  return length > 0 && a.slice(0, length) === b.slice(0, length);
}

const BUILD_TEXT = /build\s+(\S+)/i;

/** Parses `GRAVITON  build <sha>` (src/app/main.ts's placeholder text) out
 *  of the `#app` element -- the non-debug fallback for reading the build SHA
 *  off a live page that has no `window.graviton`. */
export function parseBuildFromAppText(text: string): string | null {
  return BUILD_TEXT.exec(text)?.[1] ?? null;
}

interface ScreenshotSummary {
  url: string;
  build: string | null;
  expected: string | null;
  violations: string[];
  out: string;
}

async function main(argv: string[]): Promise<number> {
  const flags = parseScreenshotFlags(argv);
  const dist = path.join(repoRoot, 'dist');
  if (!flags.url && !fs.existsSync(path.join(dist, 'index.html'))) {
    console.error('screenshot: dist/index.html is missing -- run pnpm build first');
    return 2;
  }

  const server = flags.url ? undefined : await serveStatic(dist);
  const browser = await chromium.launch({ headless: true });
  try {
    const target = new URL(flags.url ?? server!.url);
    if (flags.debug) target.searchParams.set('debug', '1');

    const context = await browser.newContext({
      viewport: { width: flags.width, height: flags.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const gate = attachConsoleGate(page);

    await page.goto(target.toString(), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    if (flags.debug) {
      await page.waitForFunction(() => window.graviton?.ready === true, undefined, {
        timeout: 30_000,
      });
    }

    const build = flags.debug
      ? ((await page.evaluate(() => window.graviton?.version.build)) ?? null)
      : parseBuildFromAppText(await page.locator('#app').innerText());

    fs.mkdirSync(path.dirname(flags.out), { recursive: true });
    await page.screenshot({ path: flags.out, animations: 'disabled', caret: 'hide' });

    const violations = gate.violations();
    const buildMatches =
      flags.expectBuild === undefined
        ? true
        : build !== null && shaPrefixesMatch(build, flags.expectBuild);

    const summary: ScreenshotSummary = {
      url: target.toString(),
      build,
      expected: flags.expectBuild ?? null,
      violations,
      out: flags.out,
    };
    console.log(JSON.stringify(summary));

    return violations.length === 0 && buildMatches ? 0 : 1;
  } finally {
    await browser.close();
    await server?.close();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
