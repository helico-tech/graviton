import { expect, test } from 'vitest';
import { parseBuildFromAppText, parseScreenshotFlags, shaPrefixesMatch } from './screenshot.ts';

test('parses --out, defaults width/height to 1280x720', () => {
  expect(parseScreenshotFlags(['--out', 'shot.png'])).toEqual({
    url: undefined,
    out: 'shot.png',
    expectBuild: undefined,
    width: 1280,
    height: 720,
    debug: false,
  });
});

test('parses every flag', () => {
  expect(
    parseScreenshotFlags([
      '--url',
      'https://example.com',
      '--out',
      'shot.png',
      '--expect-build',
      'abc1234',
      '--w',
      '960',
      '--h',
      '540',
      '--debug',
    ]),
  ).toEqual({
    url: 'https://example.com',
    out: 'shot.png',
    expectBuild: 'abc1234',
    width: 960,
    height: 540,
    debug: true,
  });
});

test('--out is required', () => {
  expect(() => parseScreenshotFlags([])).toThrow(/--out/);
});

test('rejects a non-numeric or non-positive --w or --h', () => {
  expect(() => parseScreenshotFlags(['--out', 'x.png', '--w', 'abc'])).toThrow(/--w/);
  expect(() => parseScreenshotFlags(['--out', 'x.png', '--w', '0'])).toThrow(/--w/);
  expect(() => parseScreenshotFlags(['--out', 'x.png', '--h', '-5'])).toThrow(/--h/);
});

test('sha prefixes match on the shorter length', () => {
  expect(shaPrefixesMatch('abc1234', 'abc1234567890123456789012345678901234567890')).toBe(true);
  expect(shaPrefixesMatch('abc1234567890123456789012345678901234567890', 'abc1234')).toBe(true);
  expect(shaPrefixesMatch('abc1234', 'abc1234')).toBe(true);
});

test('sha prefixes reject a mismatch and two empty strings', () => {
  expect(shaPrefixesMatch('abc1234', 'def5678')).toBe(false);
  expect(shaPrefixesMatch('', '')).toBe(false);
});

test('parses the build sha out of the #app placeholder text', () => {
  expect(parseBuildFromAppText('GRAVITON  build 8908839')).toBe('8908839');
  expect(parseBuildFromAppText('GRAVITON build abc1234')).toBe('abc1234');
});

test('returns null when the text has no build marker', () => {
  expect(parseBuildFromAppText('GRAVITON')).toBeNull();
  expect(parseBuildFromAppText('')).toBeNull();
});
