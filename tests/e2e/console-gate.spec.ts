// Proves each console-gate rule fires (ADR-0004 §4, docs/work/GRV-0012).
// Fixture pages are served through page.route for a fake origin -- Playwright
// intercepts the navigation and every subresource request itself, so no real
// network or a served dist/ is needed.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { attachConsoleGate } from './console-gate.ts';

const FIXTURE_ORIGIN = 'https://gate-fixture.test';

/** A real doctype and head keep Firefox out of quirks mode -- without one it
 *  logs its own "Quirks Mode" / "layout forced before load" warnings that
 *  would otherwise show up as unrelated gate violations. */
function fixtureDocument(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${bodyHtml}</body></html>`;
}

async function loadFixture(
  page: Page,
  {
    html,
    routes = {},
  }: { html: string; routes?: Record<string, { status: number; body?: string }> },
): Promise<void> {
  await page.route(`${FIXTURE_ORIGIN}/page.html`, (route) =>
    route.fulfill({ contentType: 'text/html', body: fixtureDocument(html) }),
  );
  for (const [routePath, response] of Object.entries(routes)) {
    await page.route(`${FIXTURE_ORIGIN}${routePath}`, (route) => {
      if (response.status === 0) return route.abort('failed');
      return route.fulfill({ status: response.status, body: response.body ?? '' });
    });
  }
  await page.goto(`${FIXTURE_ORIGIN}/page.html`);
}

test('fails on console.error', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, { html: '<script>console.error("boom")</script>' });

  expect(gate.violations()).toEqual(['console.error: boom']);
  expect(() => gate.assertClean()).toThrow(/boom/);
});

test('fails on console.warn', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, { html: '<script>console.warn("careful")</script>' });

  expect(gate.violations()).toEqual(['console.warning: careful']);
  expect(() => gate.assertClean()).toThrow(/careful/);
});

test('fails on a thrown error (pageerror)', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, { html: '<script>throw new Error("kaboom")</script>' });

  expect(gate.violations()).toEqual(['pageerror: kaboom']);
});

test('fails on a failed request', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, {
    html: '<script src="missing.js"></script>',
    routes: { '/missing.js': { status: 0 } },
  });

  // Chromium itself also logs a console.error for the same failed load
  // (research §6) -- the gate catches both signals, which is the point.
  expect(gate.violations()).toContainEqual(
    expect.stringMatching(/^requestfailed: .*\/missing\.js/),
  );
});

test('fails on a 404 subresource', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, {
    html: '<img src="notfound.png">',
    routes: { '/notfound.png': { status: 404 } },
  });

  expect(gate.violations()).toContainEqual(expect.stringMatching(/^http 404: .*\/notfound\.png/));
});

test('fails on a dialog and dismisses it', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, { html: '<script>alert("hi")</script>' });

  expect(gate.violations()).toEqual(['dialog: hi']);
});

test('a clean page passes', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, { html: '<p>hello</p>' });

  expect(gate.violations()).toEqual([]);
  expect(() => gate.assertClean()).not.toThrow();
});

test('an allowlisted pattern is ignored without touching the shared allowlist', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, {
    allowlist: [{ pattern: /boom/, why: 'test fixture: proves entries are ignored' }],
  });
  await loadFixture(page, { html: '<script>console.error("boom")</script>' });

  expect(gate.violations()).toEqual([]);

  const { ALLOWLIST } = await import('./console-gate.ts');
  expect(ALLOWLIST).toEqual([]);
});

test('failOnAnyConsoleMessage catches messages that are not errors or warnings', async ({
  page,
}) => {
  const gate = attachConsoleGate(page, { failOnAnyConsoleMessage: true });
  await loadFixture(page, { html: '<script>console.info("just fyi")</script>' });

  expect(gate.violations()).toEqual(['console.info: just fyi']);
});

test('without the strict option, an info message is not a violation', async ({ page }) => {
  const gate = attachConsoleGate(page);
  await loadFixture(page, { html: '<script>console.info("just fyi")</script>' });

  expect(gate.violations()).toEqual([]);
});
