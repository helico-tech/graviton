// Shared console gate for a driven page (ADR-0004 §4, docs/work/GRV-0012):
// `tests/e2e/console-gate.ts` and `scripts/screenshot.ts` both import this so
// the rules live in one place. Playwright-`Page`-typed, but doesn't need the
// test runner -- `scripts/screenshot.ts` drives it from a plain CLI.
import type { Page } from '@playwright/test';

export interface AllowlistEntry {
  pattern: RegExp;
  /** Why this message is known-benign -- the whole point of the field is that
   *  an entry can't be added without saying so. */
  why: string;
}

/** Starts empty: nothing has been proven benign yet (ADR-0004 §4). Add an
 *  entry only once a specific message is shown to be harmless, with a `why`. */
export const ALLOWLIST: AllowlistEntry[] = [];

export interface ConsoleGateOptions {
  /** Defaults to the shared ALLOWLIST; pass one explicitly to test the
   *  allowlisting behaviour without mutating the shared list. */
  allowlist?: AllowlistEntry[];
  /** ADR-0004 gates on console error + warning. parity.spec.ts predates the
   *  allowlisted gate and failed on every console message; this keeps that
   *  stricter behaviour available so it doesn't regress. */
  failOnAnyConsoleMessage?: boolean;
}

export interface ConsoleGate {
  violations(): string[];
  /** Throws with the recorded violations if any were recorded. */
  assertClean(): void;
}

export function attachConsoleGate(page: Page, options: ConsoleGateOptions = {}): ConsoleGate {
  const allowlist = options.allowlist ?? ALLOWLIST;
  const records: string[] = [];
  const record = (message: string): void => {
    if (!allowlist.some(({ pattern }) => pattern.test(message))) records.push(message);
  };

  page.on('console', (message) => {
    const type = message.type();
    if (options.failOnAnyConsoleMessage || type === 'error' || type === 'warning') {
      record(`console.${type}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => record(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) =>
    record(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) record(`http ${response.status()}: ${response.url()}`);
  });
  page.on('dialog', (dialog) => {
    record(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });

  return {
    violations: () => [...records],
    assertClean: () => {
      if (records.length) throw new Error(`console gate: ${records.join('; ')}`);
    },
  };
}
