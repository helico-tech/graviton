// Cross-engine proof for the debug API (ADR-0002 guard-rail 5, ADR-0004 §1,
// §3): serves the BUILT dist/ over HTTP and drives it with real Chromium and
// Firefox, never `vite dev`. `pnpm e2e` builds first; this config only serves.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4310;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    // vite preview's default host (`localhost`) resolves to the IPv6
    // loopback here, which 127.0.0.1 can't reach -- bind IPv4 explicitly.
    command: `pnpm preview --port ${PORT} --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
