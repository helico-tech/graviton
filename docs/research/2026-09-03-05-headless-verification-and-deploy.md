# 05 — Headless verification, evidence and deployment pipeline

Date: 2026-09-03. Research for Graviton. Probes live in
`scratchpad/probes/canvas/` (files: `scene.mjs`, `page.html`, `browser.mjs`,
`napi.mjs`, `svg.mjs`, `compare.mjs`; outputs in `out/`). Every number below
was measured on this VM today unless marked "not verified".

## TL;DR

1. **Primary screenshot path: Playwright 1.62.1 + its bundled Chromium
   (chromium-1234, Chrome 151.0.7922.34) driving the real `dist/` build over
   HTTP through a `window.graviton` debug API.** Launch + load 166 ms, 0.7 ms
   per Canvas2D frame, `page.screenshot` 26–34 ms at 960×540 and 32 ms at
   1280×720, ~630 MB RSS for the browser tree. Pixels are bit-identical across
   runs and across `chromium` / `chromium-headless-shell`. The Read tool
   renders the PNG legibly (verified: text, dashes, bands, ellipse fill all
   readable).
2. **Fallback: `@napi-rs/canvas` 1.0.8 running the same Canvas2D renderer
   module in Node.** 0.28 ms per frame, 80 MB RSS, zero setup, deterministic
   across runs, but **7 % of pixels differ from Chromium** (text and stroke
   anti-aliasing), so it can never share goldens with the browser and it cannot
   see the DOM panels. Use it for renderer unit tests and fast contact sheets,
   never as proof the app works. Reject the SVG + resvg route (needs a second
   renderer, 8 % pixel drift, proves nothing about the shipped page).
3. **Copy canyon-run's shape** (`/data/repos/canyon-run.git`, ADR 0003 and
   0005, `tools/headless/*`, `scripts/git-hooks/pre-push`, `docs/evidence/`),
   adapted from WebGL to Canvas2D and from "frames" to "ticks". It is the same
   owner, the same agreements, and it is proven on GitHub Pages.
4. **Evidence lives in `docs/evidence/<WORK-ID>/`** (README.md + ≤ 6 PNG +
   `meta.json` + `solvability.json`), declared by an ADR amendment, validated
   by `scripts/validate-docs.ts`, indexed by a script.
5. **Pages:** `gh repo create` → push → `gh api -X POST repos/helico-tech/graviton/pages -f build_type=workflow`
   (exact call canyon-run used, verified from its session log) → workflow with
   `actions/checkout@v7`, `pnpm/setup@v2`, `actions/configure-pages@v6`,
   `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5` → `gh run watch`
   → `curl` 200 → Playwright screenshot of the live URL with the build SHA
   asserted through the debug API.
6. **Remotes:** one `origin` = `/data/repos/graviton.git` with two push URLs
   (local bare + GitHub). One `git push` updates both; `gh` resolves the repo
   from the push URL (verified). Rename `master` → `main` first.
7. **CI:** `pnpm check` (typecheck, lint with zero warnings, format, unit +
   golden replay tests) + `pnpm docs:validate` + build + Playwright e2e in one
   job; Playwright *does* run in CI (canyon-run: ~3 min per run, no flakes).
   Pre-push hook = plain `scripts/git-hooks/pre-push` installed by `prepare`
   via `core.hooksPath`; no husky, no lefthook.

## 1. Environment facts verified today

| Item | Value |
|---|---|
| Node / pnpm / bun | 24.14.0 / 11.25.0 / 1.3.10. Node 24 runs `.ts` directly (type stripping), so repo scripts are `node scripts/x.ts`. |
| Playwright npm latest | 1.62.1 (2026-07-24). Needs `chromium-1234` + `chromium_headless_shell-1234`, both already in `~/.cache/ms-playwright`. |
| `playwright-cli` (the skill) | 1.59.0-alpha, bundles its own playwright-core and uses `chromium-1208` = **Chrome for Testing 145.0.7632.6**. Its pixels differ from the repo's Chromium by 1.07 % (text AA). Fine for eyeballing, never for goldens. Blocks `file:` URLs; `eval` needs a function expression; screenshots land in `.playwright-cli/` (gitignore it). |
| System Chrome | 151.0.7922.137. `channel: 'chrome'` works but differs from Playwright's build by the same 1.07 %; also requests `/favicon.ico` and logs a console error on 404 (Playwright's chromium does not). |
| GPU | None. Canvas2D in headless Chromium is Skia software raster; no flags needed. WebGL2 via SwiftShader also works with no flags (canyon-run memory). |
| Fonts on this VM | Only DejaVu and Liberation (24 files). The app must bundle its own woff2 and await `document.fonts.ready` before reporting ready. |
| gh | 2.89, logged in as `helico-tech`, ssh protocol, token scope `repo` (enough to create the repo and the Pages site). `helico-tech/graviton` does not exist yet. |
| Local bare repos | `/data/repos/` is `ralph:ralph` rwx. canyon-run's workspace uses two named remotes (`origin` local, `github`). |
| GitHub Actions latest tags (from `gh api repos/*/releases/latest`, 2026-09-03) | checkout v7.0.1, setup-node v7.0.0, configure-pages v6.0.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1, cache v6.1.0, upload-artifact v7.0.1, pnpm/setup v2.1.0 (pnpm ≥ 11), pnpm/action-setup v6.0.10 (pnpm ≤ 10 only). |
| canyon-run CI/Pages | `ci.yml` and `pages.yml` green on `main`; live at https://helico-tech.github.io/canyon-run/ (200). Its first three Pages runs failed for unrelated reasons (pnpm version declared twice; a slow test), not for Pages enablement. The `github-pages` environment was auto-created by the first run; the Pages *site* was created by the API call. |

## 2. What to reuse from canyon-run

Read with `git --git-dir=/data/repos/canyon-run.git show HEAD:<path>`:

| Path | Reuse |
|---|---|
| `docs/adr/2026-09-03-0003-headless-validation-workflow.md` | The decision template: test mode, replay-driven runs, gate order (state hash > semantic pixel checks > exact frame hash keyed by renderer > perceptual diff), agent reads a contact sheet, before/after discipline. |
| `docs/adr/2026-09-03-0005-work-tracking-layout.md` | The layout amendment ADR that added `docs/evidence/`. Copy the form. |
| `tools/headless/serve.ts`, `browser.ts`, `sheet.ts`, `stats.ts` | Static server for `dist/` (Playwright refuses `file:`), page opener with console capture, sharp contact sheet, frame statistics. Adapt nearly verbatim. |
| `src/app/testMode.ts` | `window.__game` installed only in test mode; `window.__errors` collecting `error` + `unhandledrejection`. Rename to `window.graviton`. |
| `scripts/validate-docs.ts`, `issues.ts`, `new-work-item.ts`, `lib/*` | The required repo scripts, with tests. Change the ID regex. |
| `scripts/git-hooks/pre-push` + `"prepare": "git config core.hooksPath scripts/git-hooks"` | Hook strategy. |
| `.github/workflows/ci.yml`, `pages.yml` | Bump action majors (§7) and swap `pnpm/action-setup` for `pnpm/setup@v2`. |
| `tsconfig.sim.json` + eslint restricted globals | DOM-free check of the simulation package; Graviton's determinism contract needs the same (no `Date`, `performance`, `Math.random`). |
| `docs/evidence/README.md`, per-unit READMEs | Evidence convention (§8). |

## 3. Headless rendering for screenshots

Probe scene: a Graviton-like plot at 960×540 — ground, minor/major grid,
banded planet with terminator and phase tick, hairline true-size ring, dashed
planned orbit, dotted extrapolation, solid flown segment, two low-opacity
ellipses with overlap, filled/hollow node squares, 13 px and 10 px monospace
readouts, scale bar. Same `drawScene(ctx, tick)` module used by (a) and (b).

| | (a) Playwright + bundled Chromium | (b) @napi-rs/canvas 1.0.8 | (c) SVG → @resvg/resvg-js 2.6.2 |
|---|---|---|---|
| Setup | `pnpm add -D playwright` + `pnpm exec playwright install chromium` (already cached here; ~1 min in CI, ~650 MB) | `pnpm add -D @napi-rs/canvas` (prebuilt binary, 0 s) | `pnpm add -D @resvg/resvg-js` (prebuilt) |
| Launch + page load | 166 ms (chromium), 168 ms (headless-shell), 302 ms (system Chrome) | 0.2 ms | 0 ms |
| Draw, per frame | 0.69 ms | 0.28 ms | 13 ms render (plus building the SVG string) |
| Capture | `canvas.toDataURL` 7 ms; `page.screenshot` 26–34 ms (32 ms at 1280×720); in-page FNV hash 6 ms | PNG encode 92 ms; hash 85 ms (pure JS loop over 2 M bytes) | included |
| Memory | ~630 MB RSS for the whole browser tree (1.2 GB with system Chrome) | 80 MB | 57 MB |
| Determinism | Bit-identical across two launches and across `chromium` vs `chromium-headless-shell` (file SHA equal). `toDataURL` and `page.screenshot` are pixel-identical. System Chrome 151 and CfT 145 differ from it by 1.07 % of pixels (max channel delta 234, text AA). | Bit-identical across runs. 6.96 % of pixels differ from Chromium (text, stroke coverage). | Deterministic. 8 % differ (and the scene had to be re-authored as SVG). |
| What it proves | The shipped page: bundle, CSS, DOM panels, fonts, event wiring, worker startup, console cleanliness | Only the renderer function; no DOM, no CSS, no panels, no bootstrap | Nothing about the shipped app |
| Agent readability | PNG via Read: excellent (verified) | Same | Same |
| PNG size (this style) | 48–75 KB per 960×540 frame | 56 KB | 44 KB |

**Recommendation.** (a) primary, (b) fallback. (b) only exists if the plot is
drawn with Canvas2D through a pure `render(ctx, viewState, simState)` function
that never touches `document`; then the same module runs in Vitest under
`@napi-rs/canvas` for renderer unit tests ("hollow node when locked", "dash
pattern per line class") and for quick contact sheets of many levels without a
browser. Keep separate goldens per backend or, better, no pixel goldens for
(b) at all — assert on sampled pixels and statistics. If the stack researcher
picks WebGL or DOM/SVG for the plot, (b) disappears and (a) is the only path;
it works equally (canyon-run did WebGL2 through SwiftShader with no flags).

Golden-hash policy that follows from the drift measurements: an exact frame
hash is compared only when the *renderer key* matches — `playwright@1.62.1 /
chromium-1234 / linux`. Store it in `meta.json`. A Playwright upgrade changes
the key and re-baselines in a commit that says so. Across machines (this VM vs
`ubuntu-latest`) exactness is **not verified**; the first CI run should upload
its PNGs as an artifact and diff them locally. Until proven equal, CI compares
with `pixelmatch` at `maxDiffPixelRatio 0.01` and relies on state hashes,
readouts and semantic gates for hard failures.

Determinism preconditions for (a): fixed viewport and `deviceScaleFactor: 1`;
bundled woff2 fonts and `await document.fonts.ready` before `ready`;
`?debug=1` disables the one permitted animation (the 150 ms warp ease) and the
rAF loop, so `render()` is synchronous and the screenshot cannot catch a
half-frame; no `Date.now()` anywhere in the render path (the aesthetic spec
already forbids motion that is not simulated time).

## 4. The debug/automation API

Installed only when the URL has `?debug=1` (or `window.__gravitonRun` was
injected by `addInitScript`). Production pages never expose it. Small on
purpose; every member maps to something a verifier needs.

```ts
// src/app/debugApi.ts — installed by main.ts in debug mode only
export interface GravitonDebugApi {
  readonly ready: true;                       // set after level load AND document.fonts.ready
  readonly version: { sim: string; build: string };   // SIM_VERSION and the git short SHA (Vite define)
  load(levelId: string, seed?: number): StateSummary;  // fresh run, tick 0
  loadRun(run: RunRecord): StateSummary;               // (level_id, seed, ordered command log) replayed to its last tick
  command(cmd: Command): void;                         // append to the log at the current tick, exactly as the UI would
  step(ticks: number): StateSummary;                   // advance, no render, no rAF
  warpTo(target: WarpTarget): StateSummary;            // 'next-telemetry' | 'next-node' | 'next-window' | 'closest-approach' | 'end' | { tick: number }
  state(): StateSummary;                               // { tick, simTime, phase, hash, probes[], contacts[], selection, score }
  hash(): string;                                      // canonical state hash, the one golden replays assert
  readouts(): Record<string, string>;                  // every [data-readout] element's text, e.g. { 'status.time': 'T+04:12:33:08', 'selection.dv': '412 m/s' }
  select(id: string | null): void;
  view(v: { center?: [number, number] | { follow: string }; zoom?: number }): void;  // zoom in log10 metres per px, or a body/probe id to follow
  render(): void;                                      // one synchronous frame of plot + panels at the current state
  frameHash(): string;                                 // FNV-1a over the plot canvas RGBA
  run(): RunRecord;                                    // export the current run for tests/golden
  errors(): string[];                                  // window 'error' + 'unhandledrejection' since page load
}
declare global { interface Window { graviton?: GravitonDebugApi } }
```

URL parameters cover the no-driver case and make evidence reproducible by a
link: `?debug=1&level=L03&seed=7&tick=1800&zoom=6.5&cx=…&cy=…&w=1280&h=720`.
`w`/`h` size the plot canvas so the same shot is reproducible independent of
the browser window.

Why `readouts()` reads the DOM rather than the model: determinism rule 11
says every displayed number comes from the simulation, and the "Frontend &
UX" gate says a green suite is not proof the UI works. The driver asserts
`readouts()['selection.dv'] === format(state().selection.dv)` — the displayed
string, not the number behind it. Every readout element carries
`data-readout="<panel>.<field>"`; that is the whole contract between the UI
and the verifier, and it costs nothing.

`errors()` must be installed before any app code runs: register the listeners
in a tiny inline `<script>` at the top of `index.html` (or via
`context.addInitScript`) so a crash during bootstrap is still recorded.

## 5. `scripts/screenshot.ts` and where evidence lives

Behaviour: refuse if `dist/index.html` is missing (tell the user to run
`pnpm build`), serve `dist/` on `127.0.0.1:0` with the copied static server,
open the page with the debug API, run the scenario, write PNG(s) plus
`meta.json`, exit non-zero on any console error, warning, page error, failed
request or HTTP ≥ 400. `--url` skips the server and points at any origin
(the Pages site). `--expect-build <sha>` fails when
`window.graviton.version.build` differs, which is how the live site is proven
to be the pushed commit.

```
pnpm build
node scripts/screenshot.ts --level L01 --seed 1 --tick 600 --zoom 6.2 --follow PRB-01 \
     --out docs/evidence/GAME-0007/tick-600.png
node scripts/screenshot.ts --run tests/golden/L01-straight-intercept.json --at 0,1200,2400,end \
     --width 960 --height 540 --out runs/L01                      # several frames + sheet.png
node scripts/screenshot.ts --url https://helico-tech.github.io/graviton/ --level L01 --tick 600 \
     --expect-build "$(git rev-parse --short HEAD)" --out docs/evidence/GAME-0012/pages-live.png
```

Skeleton (Node 24 runs it directly; `playwright` not `@playwright/test`):

```ts
// scripts/screenshot.ts
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseFlags, repoRoot } from './lib/repo.ts';
import { serveStatic } from './lib/serve.ts';          // canyon-run tools/headless/serve.ts
import { attachConsoleGate } from './lib/consoleGate.ts'; // §6

const { flags } = parseFlags(process.argv.slice(2));
const width = Number(flags.width ?? 1280), height = Number(flags.height ?? 720);
const out = flags.out ?? 'runs/shot.png';
const dist = path.join(repoRoot, 'dist');
if (!flags.url && !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ missing: run pnpm build first'); process.exit(2);
}
const server = flags.url ? undefined : await serveStatic(dist);
const base = flags.url ?? server!.url + '/';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
const page = await context.newPage();
const gate = attachConsoleGate(page);
const q = new URLSearchParams({ debug: '1', w: String(width), h: String(height) });
await page.goto(`${base}?${q}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.graviton?.ready === true, undefined, { timeout: 30_000 });

const api = (fn: string, arg?: unknown) => page.evaluate(([f, a]) => (window.graviton as any)[f](a), [fn, arg] as const);
const version = await page.evaluate(() => window.graviton!.version);
if (flags['expect-build'] && version.build !== flags['expect-build'])
  throw new Error(`live build ${version.build} != expected ${flags['expect-build']}`);
if (flags.run) await api('loadRun', JSON.parse(fs.readFileSync(flags.run, 'utf8')));
else await api('load', flags.level ?? 'L01', Number(flags.seed ?? 1));
if (flags.follow || flags.zoom) await api('view', { center: flags.follow ? { follow: flags.follow } : undefined, zoom: flags.zoom ? Number(flags.zoom) : undefined });
if (flags.select) await api('select', flags.select);
const state = await api('step', Number(flags.tick ?? 0));
await api('render');
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, animations: 'disabled', caret: 'hide' });
const meta = {
  out, version, playwright: (await import('playwright/package.json', { with: { type: 'json' } })).default.version,
  browser: browser.version(), rendererKey: `playwright-${browser.version()}-linux`,
  state, hash: await api('hash'), frameHash: await api('frameHash'), readouts: await api('readouts'),
  errors: [...gate.records, ...(await api('errors'))], width, height, date: new Date().toISOString(),
};
fs.writeFileSync(out.replace(/\.png$/, '.meta.json'), JSON.stringify(meta, null, 1));
await browser.close(); server?.close();
console.log(JSON.stringify({ out, hash: meta.hash, frameHash: meta.frameHash, errors: meta.errors.length }));
if (meta.errors.length) process.exit(1);
```

Add `--at 0,1200,end` to loop `step` and write `frame-<tick>.png` plus a
sharp contact sheet (`sheet.ts` from canyon-run, 46 ms for five thumbnails);
the agent reads the sheet with one Read call and opens a full frame only when
the sheet looks wrong.

Static server vs `vite preview`: use the in-process server. It starts in a
few ms on a free port, has no lifecycle to manage, and is what the Playwright
tests share as a fixture. `pnpm preview --strictPort` stays for humans. With
`base: './'` in Vite the same `dist/` is served at `/` locally and at
`/graviton/` on Pages without rebuilding.

**Where evidence lives — amend the layout, by ADR:**

```
docs/evidence/<WORK-ID>/README.md          what was proven, the command, the numbers, the images inline
docs/evidence/<WORK-ID>/*.png              ≤ 6 images, ≤ 1 MB total, 960×540 or 1280×720, DPR 1
docs/evidence/<WORK-ID>/*.meta.json        hash, readouts, renderer key, build SHA, date, console records
docs/evidence/<WORK-ID>/solvability.json   for level units: solver verdicts per level and difficulty dial
docs/evidence/README.md                    index, generated by `pnpm evidence:index`
```

Why `docs/evidence/` and not `test-results/`, a wiki, or artifacts: the
agreements say all agent artifacts live in the docs tree and nothing is
invented elsewhere; evidence is documentation ("Done requires command output
that proves it") and belongs beside the work item it proves; GitHub renders
`README.md` with inline PNGs, so a human browses a unit's proof in the
browser without cloning; git keeps it with the commit that produced it.
Why undated `<WORK-ID>` rather than canyon-run's `YYYY-MM-DD-CR-NNNN`: the
agreements date `adr/`, `specs/`, `issues/` and sort work items by ID with no
date; evidence is a property of a work item, so it sorts and validates the
same way (folder name must match a `docs/work/<ID>-*.md` file). The date goes
in `meta.json` and the README. Why the size cap: PNGs are binary and immutable
in history; this style of frame is 50–75 KB, so six frames per unit keeps a
100-unit project under 50 MB.

Validation added to `scripts/validate-docs.ts`: `evidence` is in
`DECLARED_DIRS`; every folder has a `README.md`; the folder name matches a
work item; no file over 400 KB; the index is up to date (regenerate and diff).
Scratch output goes to `runs/` (gitignored); promotion to evidence is a
deliberate `--out docs/evidence/...`.

## 6. Console-error capture

Attach before navigation; treat warnings as errors (agreements: warnings are
errors); keep the allowlist explicit and empty until a specific benign message
is proven benign (canyon-run needed one for SwiftShader; Canvas2D needs none).

```ts
// scripts/lib/consoleGate.ts — shared by screenshot.ts and the Playwright fixture
import type { Page } from 'playwright';
const ALLOW: RegExp[] = [];                       // add with a comment saying why, never silently
export function attachConsoleGate(page: Page): { records: string[] } {
  const records: string[] = [];
  const push = (s: string) => { if (!ALLOW.some((re) => re.test(s))) records.push(s); };
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => { if (r.status() >= 400) push(`http ${r.status()}: ${r.url()}`); });
  page.on('dialog', (d) => { push(`dialog: ${d.message()}`); void d.dismiss(); });
  page.on('crash', () => push('page crashed'));
  return { records };
}
```

Plus the in-page side: `window.graviton.errors()` returns what the
`error`/`unhandledrejection` listeners caught, including errors thrown inside
`page.evaluate` calls that Playwright would otherwise surface only as a
rejected promise. The screenshot script merges both lists into `meta.json`
and exits 1 if either is non-empty.

Playwright test fixture, auto-applied to every e2e test:

```ts
// tests/e2e/fixtures.ts
import { test as base, expect } from '@playwright/test';
import { attachConsoleGate } from '../../scripts/lib/consoleGate.ts';
export const test = base.extend<{ consoleGate: string[] }>({
  consoleGate: [async ({ page }, use) => {
    const gate = attachConsoleGate(page);
    await use(gate.records);
    const inPage = await page.evaluate(() => window.graviton?.errors() ?? []).catch(() => []);
    expect([...gate.records, ...inPage], 'console must be clean').toEqual([]);
  }, { auto: true }],
});
export { expect };
```

Two gotchas measured today: full Chrome builds request `/favicon.ico` and log
`Failed to load resource: 404` as a console *error* — ship a favicon (or
`<link rel="icon" href="data:,">`) rather than allowlisting it; and Vite's
production bundle strips nothing, so a library's `console.warn` on startup
fails the run, which is the intended behaviour.

## 7. GitHub Pages deployment

**Vite config.** `base: './'` (relative), as canyon-run does. It makes one
`dist/` correct at `https://helico-tech.github.io/graviton/`, at the local
static server root, and at `vite preview`. The Vite docs' alternative is
`base: '/graviton/'`; it is only needed with client-side routing, which the
game does not have. Inject the build SHA for the live-site check:

```ts
// vite.config.ts
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
const build = process.env.GITHUB_SHA?.slice(0, 7) ?? execSync('git rev-parse --short HEAD').toString().trim();
export default defineConfig({
  base: './',
  define: { __BUILD_SHA__: JSON.stringify(build) },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
});
```

**Workflow.** Action majors verified against `releases/latest` today.
`pnpm/setup@v2` installs pnpm from `packageManager` (must be ≥ 11; this repo
pins 11.25.0), installs Node 24 and runs `pnpm install` itself, replacing both
`actions/setup-node` and `pnpm/action-setup` (which caused canyon-run's first
Pages failure: "Multiple versions of pnpm specified").

```yaml
# .github/workflows/pages.yml
name: pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2
        with:
          runtime: node@24
          cache: true
      - run: pnpm check
      - run: pnpm build
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

**Repository creation and Pages enablement, in order.** The Pages site must
exist with `build_type: workflow` before `configure-pages` runs (its default
`enablement: false` only reads the site; `enablement: true` needs a PAT, the
workflow token cannot enable Pages). The site cannot be created on an empty
repository, so push first. To avoid a failed first run, push the docs-only
history first, enable Pages, then push the commit that adds the workflows.

```bash
cd /data/workspaces/graviton
git branch -m master main                                     # GitHub's default; the agreements protect both names
gh repo create helico-tech/graviton --public \
  --description "Graviton: an orbital-mechanics and signal-delay clearance game" \
  --homepage https://helico-tech.github.io/graviton/
# remotes: see §8 (single origin, two push URLs)
git push -u origin main                                       # docs-only history, no workflows yet
gh api -X POST repos/helico-tech/graviton/pages -f build_type=workflow   # exactly what canyon-run used; source defaults to main:/
gh api repos/helico-tech/graviton/pages --jq '{html_url, build_type, https_enforced}'
# expected: {"html_url":"https://helico-tech.github.io/graviton/","build_type":"workflow","https_enforced":true}
```

If the workflow was pushed before the site existed, the run fails at
`configure-pages` with "Get Pages site failed"; create the site and re-run
with `gh workflow run pages.yml` (the workflow has `workflow_dispatch`) or
`gh run rerun <id>`.

**Verify the deployed site from the CLI.**

```bash
gh run watch --exit-status "$(gh run list --workflow pages --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
for i in $(seq 1 30); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' https://helico-tech.github.io/graviton/)
  [ "$code" = 200 ] && break; sleep 10
done; echo "pages http $code"                                 # first deploy: 200 within ~1–3 min
curl -sS https://helico-tech.github.io/graviton/ | grep -oE '(src|href)="[^"]+"' | head   # relative ./assets/… paths
pnpm build && node scripts/screenshot.ts --url https://helico-tech.github.io/graviton/ \
  --level L01 --tick 600 --expect-build "$(git rev-parse --short HEAD)" \
  --out docs/evidence/<ID>/pages-live.png                    # debug API works on the live build, SHA matches, console clean
```

`gh api repos/…/pages --jq .status` is `null` for workflow builds (verified on
canyon-run), so do not poll it; `gh run watch` plus `curl` is the signal.

Ad-hoc look with the skill, when a human-style check is wanted:

```bash
playwright-cli open 'https://helico-tech.github.io/graviton/?debug=1&level=L01'
playwright-cli eval "() => window.graviton.step(600) && window.graviton.render()"
playwright-cli screenshot --filename=runs/live.png
playwright-cli console warning         # must print nothing
playwright-cli close
```

## 8. Local bare remote and keeping both remotes in sync

Recommendation: **one `origin` with two push URLs.** Fetch and tracking come
from the local bare repo (always available, instant); a single `git push`
updates the bare repo and GitHub; `gh` resolves `helico-tech/graviton` from
the push URL (verified today with a scratch clone against canyon-run). Two
named remotes (canyon-run's setup) need two pushes per checkpoint and the
second one gets forgotten.

```bash
git init --bare /data/repos/graviton.git
git --git-dir=/data/repos/graviton.git symbolic-ref HEAD refs/heads/main   # canyon-run's bare HEAD pointed at a nonexistent master; avoid that
cd /data/workspaces/graviton
git remote add origin /data/repos/graviton.git
git remote set-url --add --push origin /data/repos/graviton.git            # the first --add replaces the implicit push URL, so list local first
git remote set-url --add --push origin git@github.com:helico-tech/graviton.git
git remote -v
#   origin  /data/repos/graviton.git (fetch)
#   origin  /data/repos/graviton.git (push)
#   origin  git@github.com:helico-tech/graviton.git (push)
git push -u origin main
```

Behaviour to know: `git push` reports per-URL results; if GitHub is
unreachable the local push still lands and the command exits non-zero, so
re-run it. `origin/main` tracks the local bare repo. Feature branches push to
both as well (`git push -u origin GAME-0007-...`), which is what the
agreements want for worktrees. `gh pr` is not needed (single developer,
merges happen locally as canyon-run did), but it works if wanted.

## 9. Continuous integration and hooks

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push:
    branches: [main]
  pull_request:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2
        with:
          runtime: node@24
          cache: true
      - run: pnpm check                 # typecheck (app + DOM-free sim), lint --max-warnings 0, format:check, vitest (unit + golden replay + warp invariance + round-trip)
      - run: pnpm docs:validate
      - run: pnpm build
      - uses: actions/cache@v6
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e              # playwright test: debug-API scenarios, readouts, console gate, pixelmatch ≤ 1 %
        env:
          CI: 'true'
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: e2e-output
          path: |
            runs/
            test-results/
          if-no-files-found: ignore
```

Should Playwright run in CI? Yes. Cost: `playwright install --with-deps`
≈ 40–60 s uncached, the suite itself is seconds per scenario (no waits on
animation because the debug API steps synchronously), canyon-run's whole job
runs in ~3 min. Flakiness is low because software rendering is deterministic
and every wait is `waitForFunction(() => window.graviton?.ready)`; the one
flake class canyon-run hit was a slow *unit* test timing out on the runner,
fixed by a longer timeout. Keep exact pixel hashes out of CI until §3's
cross-machine check has been done once; keep state hashes, readouts and the
console gate as hard failures from day one.

`package.json` scripts (shape only; versions are the stack researcher's):

```json
{
  "packageManager": "pnpm@11.25.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --strictPort",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit",
    "lint": "eslint . --max-warnings 0",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test",
    "test:e2e": "playwright test",
    "screenshot": "node scripts/screenshot.ts",
    "docs:validate": "node scripts/validate-docs.ts",
    "evidence:index": "node scripts/evidence-index.ts",
    "work:new": "node scripts/new-work-item.ts",
    "issue": "node scripts/issues.ts",
    "prepare": "git config core.hooksPath scripts/git-hooks"
  }
}
```

**Hooks: plain `scripts/git-hooks/pre-push`, installed by `prepare`.** pnpm 11
still runs the project's own lifecycle scripts (the 11.x hardening applies to
*dependencies'* build scripts), and canyon-run proves the pattern on pnpm 10.
Husky is the same `core.hooksPath` trick behind a package; lefthook is a Go
binary with parallel YAML jobs that a one-line hook does not need. The
agreements ask for fast gates locally and slow suites in CI, so the hook is:

```sh
#!/bin/sh
# Fast local gate before any push: typecheck, lint, format, unit + golden tests, docs layout.
set -e
cd "$(git rev-parse --show-toplevel)"
pnpm check
pnpm docs:validate
```

Target under 60 s; e2e and the build stay in CI. Never `--no-verify`. If
`pnpm check` grows past a minute, split `test` into `test:fast` (sim + scripts)
for the hook and keep the full run in CI, rather than dropping the hook.

## 10. Evidence of progress: the per-unit convention

Every unit of work ends the same way, so a reader can browse `docs/work/`,
`docs/evidence/` and `git log` and reconstruct what happened.

1. **Work item gets a "Delivered" section** with the commit(s), the evidence
   folder link, and the verification commands actually run (canyon-run's
   `docs/work/CR-0023-speed-cues.md` is the model).
2. **`docs/evidence/<ID>/README.md`** states in prose what was proven, the
   exact command lines, a small table of numbers (state hash, tick, readouts
   asserted, gate results, test counts), and the images inline with a
   one-line caption each. Test output goes in as a short fenced snippet (the
   summary line, the golden hash line), never a full log.
3. **Before/after for anything user-visible**: `before-<scenario>.png` and
   `after-<scenario>.png` from the *same* scenario, both read by the agent,
   both in the folder, with the diff summarised in the README. State hashes
   must be equal across before/after unless the unit changed the simulation,
   and then the golden replay was regenerated in a commit that says so.
4. **Level units add `solvability.json`** (the solver's verdict per level and
   dial: intercept found, delta-v margin, exposure at intercept, ticks) and a
   rendered table in the README; the screenshot script's `--run` mode renders
   the solver's command log at closest approach as the hero frame.
5. **`docs/evidence/README.md`** is generated (`pnpm evidence:index`) and
   checked by `docs:validate`, so it never drifts; the root `README.md` shows
   two current hero frames from evidence and the Pages link, as canyon-run's
   does.
6. **Commits** carry the ID in the subject; the final commit of a unit
   includes its evidence, so `git log --oneline` is the progress diary and
   `git show --stat <sha>` shows which proof came with which change.
7. **Deploy proof** is itself evidence: the unit that lands Pages stores
   `pages-live.png` + its `meta.json` showing `version.build` equal to the
   pushed SHA.

## 11. Gotchas collected today

- Playwright refuses `file:` URLs; serve `dist/` over HTTP.
- `playwright-cli` uses Chrome for Testing 145 with a 1.59-alpha core; its
  pixels differ from the repo's Chromium by ~1 %. Use it to look, not to gold.
- System Chrome and CfT 145 log a console error for the missing favicon; ship one.
- Never return a `Uint8Array` as an array from `page.evaluate` (seconds);
  hash in the page, return hex.
- `@napi-rs/canvas` PNG encode is ~90 ms per 960×540 frame; fine for sheets,
  not for per-tick dumps.
- Fonts: bundle woff2, await `document.fonts.ready`, set `ready` only after.
  Cross-machine pixel equality with bundled fonts is not verified; check on
  the first CI run before enabling exact goldens there.
- `pnpm/action-setup` + `packageManager` together fail with "Multiple versions
  of pnpm specified"; `pnpm/setup@v2` reads `packageManager` and is the one to
  use for pnpm 11.
- `configure-pages` cannot enable Pages with the workflow token; create the
  site via the API after the first push.
- The bare repo's `HEAD` must point at `main` or a fresh clone checks out nothing.
- Perf numbers on this VM vary ±40 % between runs; never gate on timing.

## Sources

- Playwright releases: https://www.npmjs.com/package/playwright, https://playwright.dev/docs/release-notes
- @napi-rs/canvas: https://www.npmjs.com/package/@napi-rs/canvas
- Vite static deploy (GitHub Pages section, action pins): https://vite.dev/guide/static-deploy
- GitHub Pages REST API: https://docs.github.com/en/rest/pages/pages
- actions/configure-pages (enablement input): https://github.com/actions/configure-pages
- actions/deploy-pages: https://github.com/actions/deploy-pages
- pnpm/setup: https://github.com/pnpm/setup
- pnpm 11 release notes: https://pnpm.io/blog/releases/11.0
- Git hooks comparison: https://www.andymadge.com/2026/03/10/git-hooks-comparison/
- canyon-run precedent: `/data/repos/canyon-run.git` (ADR 0003, ADR 0005, `tools/headless/`, `docs/research/2026-09-03-02-headless-validation.md`), its session log for the Pages API call, and https://github.com/helico-tech/canyon-run/actions
