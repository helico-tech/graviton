// Table-driven: every selection-panel number passes through one of these (GRV-0023 acceptance
// "units chosen to read well... with one formatter module, tested").
import { describe, expect, test } from 'vitest';
import {
  formatDegrees,
  formatDuration,
  formatJoules,
  formatKilograms,
  formatKilometres,
  formatKilometresPerSecond,
} from './format.ts';

const THIN_SPACE = ' ';

describe('formatKilometres', () => {
  test.each([
    [0, '0 km'],
    [500, '1 km'], // rounds to the nearest km
    [1_000, '1 km'],
    [98_734_594_662, `98${THIN_SPACE}734${THIN_SPACE}595 km`], // L01-intercept's semi-major axis
    [1_234_567, `1${THIN_SPACE}235 km`],
  ])('%d m -> %s', (metres, expected) => {
    expect(formatKilometres(metres)).toBe(expected);
  });
});

describe('formatKilometresPerSecond', () => {
  test.each([
    [0, '0.00 km/s'],
    [120_000, '120.00 km/s'], // L01-intercept's launch speed
    [29_845.6, '29.85 km/s'],
  ])('%d m/s -> %s', (metresPerSecond, expected) => {
    expect(formatKilometresPerSecond(metresPerSecond)).toBe(expected);
  });
});

describe('formatDegrees', () => {
  test.each([
    [0, '0.0°'],
    [Math.PI, '180.0°'],
    [Math.PI / 2, '90.0°'],
    [-Math.PI / 2, '270.0°'], // negative angles normalise into [0, 360)
    [2 * Math.PI + 0.001, '0.1°'], // wraps past a full turn
  ])('%d rad -> %s', (radians, expected) => {
    expect(formatDegrees(radians)).toBe(expected);
  });
});

describe('formatDuration', () => {
  test.each([
    [0, '0s'],
    [45, '45s'],
    [90, '1m'],
    [3_600, '1h 00m'],
    [3_660, '1h 01m'],
    [86_400, '1d 00h'],
    [98_940, '1d 03h'], // L01-intercept's impact time, tick 3298 * dt 30
  ])('%d s -> %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('formatKilograms', () => {
  test.each([
    [0, '0 kg'],
    [420, '420 kg'],
    [1_100, `1${THIN_SPACE}100 kg`], // L01-intercept's probe: 420 dry + 680 propellant
  ])('%d kg -> %s', (kg, expected) => {
    expect(formatKilograms(kg)).toBe(expected);
  });
});

describe('formatJoules', () => {
  test.each([
    [0, '0 J'],
    [5_000_000_000_000, '5 TJ'], // L01-intercept's contact minimum energy
    [7_933_055_679_153.257, '7.93 TJ'],
    [1_500, '1.5 kJ'],
  ])('%d J -> %s', (joules, expected) => {
    expect(formatJoules(joules)).toBe(expected);
  });
});
