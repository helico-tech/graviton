// The palette is the one source of truth GAME-0002 §2's hexes are declared in; this asserts
// `src/app/styles.css`'s `:root` custom properties never drift from it, and that the
// marker/line registries GAME-0002 §11 relies on ("every marker its shape", "every line its dash
// pattern") are each internally unique.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { repoRoot } from '../../scripts/lib/repo.ts';
import { BODY_CLASS_STYLES, CSS_CUSTOM_PROPERTIES, LINE_STYLES, MARKER_SHAPES } from './palette.ts';

const HEX_COLOR = /^#[0-9a-f]{6}$/;

describe('CSS_CUSTOM_PROPERTIES matches src/app/styles.css', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'src/app/styles.css'), 'utf8');

  test.each(Object.entries(CSS_CUSTOM_PROPERTIES))('%s is %s in the stylesheet', (name, value) => {
    const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
    expect(match, `${name} not declared in :root`).not.toBeNull();
    expect(match![1]!.toLowerCase()).toBe(value);
  });
});

describe('BODY_CLASS_STYLES', () => {
  test.each(Object.entries(BODY_CLASS_STYLES))(
    '%s has four to six valid hex bands',
    (_class, style) => {
      expect(style.bands.length).toBeGreaterThanOrEqual(4);
      expect(style.bands.length).toBeLessThanOrEqual(6);
      for (const band of style.bands) expect(band).toMatch(HEX_COLOR);
    },
  );

  test('every class has a distinct glyph shape', () => {
    const shapes = Object.values(BODY_CLASS_STYLES).map((style) => style.glyph);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  test('only the star has no terminator', () => {
    for (const [name, style] of Object.entries(BODY_CLASS_STYLES)) {
      expect(style.terminator).toBe(name === 'star' ? 'none' : 'hard');
    }
  });
});

describe('MARKER_SHAPES', () => {
  test('every overlay marker has a distinct shape', () => {
    const shapes = Object.values(MARKER_SHAPES);
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe('LINE_STYLES', () => {
  test('every line class has a distinct dash pattern', () => {
    const dashes = Object.values(LINE_STYLES).map((style) => JSON.stringify(style.dash));
    expect(new Set(dashes).size).toBe(dashes.length);
  });
});
