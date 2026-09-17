// Dimension-scoped unit parsing (docs/research/2026-09-03-03-level-format-and-solvability.md
// A.5): a bare number is already SI, a unit from the wrong dimension is an error naming the
// accepted units, and durations may be compound ("1d 2h 3m 4s").
import { describe, expect, test } from 'vitest';
import { parseQuantity } from './units.ts';

function value(result: ReturnType<typeof parseQuantity>): number {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.message}`);
  return result.value;
}

describe('parseQuantity: bare numbers are already SI', () => {
  test.each([
    ['length', '71492000'],
    ['duration', '30'],
    ['angle', '0'],
    ['energy', '-5'],
  ] as const)('%s "%s" passes through unconverted', (dimension, raw) => {
    expect(value(parseQuantity(raw, dimension))).toBe(Number(raw));
  });
});

describe('parseQuantity: single-unit conversion, one case per dimension', () => {
  test('length: 71492 km', () => {
    expect(value(parseQuantity('71492 km', 'length'))).toBeCloseTo(71492000, 6);
  });
  test('length: 1 au', () => {
    expect(value(parseQuantity('1 au', 'length'))).toBe(1.495978707e11);
  });
  test('length: 1 ls', () => {
    expect(value(parseQuantity('1 ls', 'length'))).toBe(299792458);
  });
  test('length: 1 lm', () => {
    expect(value(parseQuantity('1 lm', 'length'))).toBe(299792458 * 60);
  });
  test('mass: 4.9e24 kg', () => {
    expect(value(parseQuantity('4.9e24 kg', 'mass'))).toBe(4.9e24);
  });
  test('mass: 1 t', () => {
    expect(value(parseQuantity('1 t', 'mass'))).toBe(1000);
  });
  test('duration: 25.5 d', () => {
    expect(value(parseQuantity('25.5 d', 'duration'))).toBeCloseTo(25.5 * 86400, 6);
  });
  test('duration: 1 min', () => {
    expect(value(parseQuantity('1 min', 'duration'))).toBe(60);
  });
  test('speed: 300 km/s', () => {
    expect(value(parseQuantity('300 km/s', 'speed'))).toBe(300000);
  });
  test('force: 9.4 kN', () => {
    expect(value(parseQuantity('9.4 kN', 'force'))).toBeCloseTo(9400, 6);
  });
  test('angle: 90 deg is pi/2', () => {
    expect(value(parseQuantity('90 deg', 'angle'))).toBeCloseTo(Math.PI / 2, 15);
  });
  test('angle: 180 deg is exactly pi (bit-identical)', () => {
    expect(value(parseQuantity('180 deg', 'angle'))).toBe(Math.PI);
  });
  test('angle: 0.25 turn is pi/2', () => {
    expect(value(parseQuantity('0.25 turn', 'angle'))).toBeCloseTo(Math.PI / 2, 15);
  });
  test('energy: 2.4 TJ', () => {
    expect(value(parseQuantity('2.4 TJ', 'energy'))).toBeCloseTo(2.4e12, 6);
  });
});

describe('parseQuantity: compound durations', () => {
  test('9h 55m is 35700 s (the m-means-minutes case that bit the prototype)', () => {
    expect(value(parseQuantity('9h 55m', 'duration'))).toBe(35700);
  });
  test('1d 2h 3m 4s is 93784 s', () => {
    expect(value(parseQuantity('1d 2h 3m 4s', 'duration'))).toBe(93784);
  });
});

describe('parseQuantity: the research report rejection cases', () => {
  test('length "9 h": unit from the wrong dimension names the accepted length units', () => {
    const result = parseQuantity('9 h', 'length');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toBe(
        'unit "h" is not a length unit (accepted: m, km, Mm, Gm, au, ls, lm)',
      );
  });

  test('duration "5 km": unit from the wrong dimension names the accepted duration units', () => {
    const result = parseQuantity('5 km', 'duration');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toBe(
        'unit "km" is not a duration unit (accepted: s, m, min, h, d, a)',
      );
  });

  test('length "3 furlong": an unknown unit is rejected', () => {
    const result = parseQuantity('3 furlong', 'length');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unit "furlong" is not a length unit');
  });

  test('length "5 km banana": trailing garbage cannot be read at all', () => {
    const result = parseQuantity('5 km banana', 'length');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('cannot read "5 km banana" as a length');
  });
});

describe('parseQuantity: malformed input', () => {
  test('empty string', () => {
    expect(parseQuantity('', 'length').ok).toBe(false);
  });
  test('unit with no number', () => {
    expect(parseQuantity('km', 'length').ok).toBe(false);
  });
  test('two bare numbers with no units is not a valid compound', () => {
    expect(parseQuantity('5 3', 'length').ok).toBe(false);
  });
});
