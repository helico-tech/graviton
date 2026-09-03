import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// The build SHA is exposed to the app so a deployed page can prove which commit it is.
const buildSha =
  process.env.GITHUB_SHA?.slice(0, 7) ??
  execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

export default defineConfig({
  base: './',
  define: { __BUILD_SHA__: JSON.stringify(buildSha) },
  build: { target: 'es2022', sourcemap: true },
});
