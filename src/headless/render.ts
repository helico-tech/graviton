// `pnpm render` (ADR-0004 §3, GRV-0022): renders a level headless through the exact same
// `renderPlot` the page uses, via `@napi-rs/canvas` -- for fast contact sheets and renderer
// iteration, never as proof the shipped page works (research §3: 7% of pixels differ from
// Chromium's text/stroke anti-aliasing, so this and `pnpm screenshot` never share pixel
// goldens). Outside `src/app`'s bundle-isolation boundary, so it reads a compiled level's JSON
// straight off disk -- the same way scripts/levels-verify.ts does -- rather than through
// src/app/levels.ts's Vite-only `import.meta.glob`, which only exists inside a Vite build.
//
// The tick-advance-with-trails loop is not duplicated here: `createDebugSession().stepSampled`
// (src/app/debug-api.ts) plus `src/app/trails.ts`'s `TrailSet` are the exact same primitives
// src/app/app.ts drives from the page.
import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { createDebugSession } from '../app/debug-api.ts';
// `CompiledLevel` is a type-only import (erased at build time, unlike src/app/levels.ts's own
// `import.meta.glob`, which is Vite-only and genuinely can't run here) -- observedObjects's own
// replay (src/app/observed.ts) needs the full shape, not just FrameLevelNames's render-facing
// subset, so this reads a compiled level's JSON straight off disk (the same way
// scripts/levels-verify.ts does) and asserts it against that type.
import type { CompiledLevel } from '../app/levels.ts';
import { createObservedCache } from '../app/observed.ts';
import type { ObservedObject } from '../app/observed.ts';
import { parseSelectionParam } from '../app/selection.ts';
import type { SelectionTarget } from '../app/selection.ts';
import { createTrailSet, sampleObservedTrailSet, trailPoints } from '../app/trails.ts';
import { defaultView } from '../render/camera.ts';
import type { View } from '../render/camera.ts';
import { hashCanvasPixels, renderPlot } from '../render/plot.ts';
import type { Ctx2D } from '../render/ctx2d.ts';
import type { Command } from '../sim/sim.ts';
import { parseFlags, repoRoot } from '../../scripts/lib/repo.ts';

interface SolutionFile {
  level: string;
  log: Command[];
  ticks: number;
}

/** The same woff2 files the web build imports (src/app/styles.css), registered under the same
 *  family names `src/render/palette.ts`'s `MONO_FONT_FAMILY` and the CSS's `--font-condensed`
 *  use, so a headless render's text glyphs match the page's. */
function registerFonts(): void {
  const dir = path.join(repoRoot, 'node_modules/@fontsource');
  const fonts: { file: string; family: string }[] = [
    {
      file: 'jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
      family: 'JetBrains Mono',
    },
    {
      file: 'jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
      family: 'JetBrains Mono',
    },
    {
      file: 'barlow-condensed/files/barlow-condensed-latin-500-normal.woff2',
      family: 'Barlow Condensed',
    },
    {
      file: 'barlow-condensed/files/barlow-condensed-latin-600-normal.woff2',
      family: 'Barlow Condensed',
    },
  ];
  for (const { file, family } of fonts) {
    const fullPath = path.join(dir, file);
    if (!GlobalFonts.registerFromPath(fullPath, family))
      throw new Error(`render: failed to register font ${fullPath}`);
  }
}

export interface RenderFlags {
  level: string;
  tick?: number;
  zoom?: number;
  cx?: number;
  cy?: number;
  width: number;
  height: number;
  solution: boolean;
  select?: SelectionTarget;
  out: string;
}

export function parseRenderFlags(argv: string[]): RenderFlags {
  const { flags } = parseFlags(argv);
  if (!flags.level) throw new Error('render: --level <id> is required');
  if (!flags.out) throw new Error('render: --out <png> is required');
  return {
    level: flags.level,
    tick: flags.tick !== undefined ? Number(flags.tick) : undefined,
    zoom: flags.zoom !== undefined ? Number(flags.zoom) : undefined,
    cx: flags.cx !== undefined ? Number(flags.cx) : undefined,
    cy: flags.cy !== undefined ? Number(flags.cy) : undefined,
    width: flags.w !== undefined ? Number(flags.w) : 1280,
    height: flags.h !== undefined ? Number(flags.h) : 720,
    solution: flags.solution === 'true',
    select: flags.select !== undefined ? parseSelectionParam(flags.select) : undefined,
    out: flags.out,
  };
}

export interface RenderResult {
  tick: number;
  hash: string;
  frameHash: string;
}

/** Loads the level, optionally replays its committed solution, renders one frame and writes the
 *  PNG -- the CLI's whole job, factored out so tests/render/*.test.ts can call it without
 *  shelling out. */
export function renderLevel(flags: RenderFlags): RenderResult {
  const levelPath = path.join(repoRoot, 'levels', `${flags.level}.level.json`);
  const level = JSON.parse(fs.readFileSync(levelPath, 'utf8')) as CompiledLevel;

  const session = createDebugSession();
  session.load({ scenario: level.scenario, seed: level.seed });
  const trailSet = createTrailSet();
  const observedCache = createObservedCache();
  let observed: ObservedObject[] = [];

  let ticks = flags.tick ?? 0;
  if (flags.solution) {
    const solutionPath = path.join(repoRoot, 'levels', `${flags.level}.solution.json`);
    const solution = JSON.parse(fs.readFileSync(solutionPath, 'utf8')) as SolutionFile;
    for (const command of solution.log) session.command(command);
    ticks = flags.tick ?? solution.ticks;
  }
  session.stepSampled({
    ticks,
    level,
    cache: observedCache,
    onTick: (_positions, sample) => {
      sampleObservedTrailSet(
        trailSet,
        sample.observed.map((o) => o.observation),
      );
      observed = sample.observed;
    },
  });

  const frame = session.captureFrame(level, observed);
  let view: View = defaultView({
    largestOrbitRadius: frame.systemExtent,
    canvasWidth: flags.width,
    canvasHeight: flags.height,
  });
  if (flags.zoom !== undefined) view = { ...view, metresPerPixel: flags.zoom };
  if (flags.cx !== undefined) view = { ...view, centreX: flags.cx };
  if (flags.cy !== undefined) view = { ...view, centreY: flags.cy };

  const trails = new Map<number, readonly { x: number; y: number }[]>();
  trailSet.buffers.forEach((buffer, index) => trails.set(index, trailPoints(buffer)));

  const predictedTails = new Map<number, readonly { x: number; y: number }[]>();
  observed.forEach((objectView, index) => {
    if (objectView.observation)
      predictedTails.set(index, [objectView.observation, ...objectView.tail]);
  });

  const canvas = createCanvas(flags.width, flags.height);
  const ctx = canvas.getContext('2d');
  // `SKRSContext2D.fillStyle`/`strokeStyle` are typed wider than `Ctx2D`'s string-only contract
  // (src/ui/plot.ts's `ctx()` has the full reasoning); this renderer never sets a gradient or a
  // pattern.
  renderPlot({
    ctx: ctx as unknown as Ctx2D,
    view,
    frame,
    trails,
    predictedTails,
    canvasWidth: flags.width,
    canvasHeight: flags.height,
    selection: flags.select ?? null,
  });

  fs.mkdirSync(path.dirname(flags.out), { recursive: true });
  fs.writeFileSync(flags.out, canvas.toBuffer('image/png'));

  return {
    tick: frame.tick,
    hash: session.hash(),
    frameHash: hashCanvasPixels(ctx, flags.width, flags.height),
  };
}

function main(argv: string[]): number {
  const flags = parseRenderFlags(argv);
  registerFonts();
  const result = renderLevel(flags);
  console.info(`tick ${result.tick}`);
  console.info(`hash ${result.hash}`);
  console.info(`frameHash ${result.frameHash}`);
  console.info(`wrote ${flags.out}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
