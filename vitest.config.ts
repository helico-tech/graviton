import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // GitHub runners have two vCPUs shared by every worker; the 5 s default starved a plain loop.
    testTimeout: 20_000,
  },
});
