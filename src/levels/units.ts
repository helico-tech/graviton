// Dimension-scoped unit suffixes (ADR-0006 §2, docs/research/2026-09-03-03-level-format-and-
// solvability.md A.5): the schema knows each field's dimension, so "m" is metres in a length and
// minutes in a duration rather than one global table silently picking the wrong one. A bare
// number is already SI. Unit conversion rounds (research A.5's "24.1 d" example): the compiled
// JSON, not the YAML source, is the canonical artefact that a golden replay hashes.

export const DIMENSIONS = [
  'length',
  'mass',
  'duration',
  'speed',
  'force',
  'angle',
  'energy',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const LIGHT_SECOND = 299792458; // m, exact by definition of the metre
const DEG_TO_RAD = Math.PI / 180;

// Every table's key order is the order accepted-unit lists are reported in, so an error message
// reads the same every time it names a dimension's units.
const TABLES: Record<Dimension, Record<string, number>> = {
  length: {
    m: 1,
    km: 1e3,
    Mm: 1e6,
    Gm: 1e9,
    au: 1.495978707e11,
    ls: LIGHT_SECOND,
    lm: LIGHT_SECOND * 60,
  },
  mass: { kg: 1, t: 1e3, Mt: 1e9 },
  duration: { s: 1, m: 60, min: 60, h: 3600, d: 86400, a: 365.25 * 86400 },
  speed: { 'm/s': 1, 'km/s': 1e3, c: LIGHT_SECOND },
  force: { N: 1, kN: 1e3, MN: 1e6 },
  angle: { deg: DEG_TO_RAD, rad: 1, turn: 2 * Math.PI },
  energy: { J: 1, kJ: 1e3, MJ: 1e6, GJ: 1e9, TJ: 1e12 },
};

export type QuantityResult = { ok: true; value: number } | { ok: false; message: string };

const NUMBER_ONLY = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_PART = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
// A single `<number><unit>` token: the optional internal whitespace is what lets "71492 km" (one
// quantity) and "9h 55m" (two, no space before the unit) both tokenize correctly -- see the
// walk-through in units.test.ts.
const TOKEN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*[A-Za-z]+(?:\/[A-Za-z0-9]+)?/y;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Parses a dimension-scoped quantity string, e.g. "71492 km" or "9h 55m". A bare number (no
 *  unit at all) is accepted as already-SI. Never throws: an unreadable string or a unit from the
 *  wrong dimension is a `QuantityResult` failure, for the caller to turn into a validation issue
 *  rather than an exception. */
export function parseQuantity(raw: string, dimension: Dimension): QuantityResult {
  const table = TABLES[dimension];
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, message: `cannot read "${raw}" as a ${dimension}` };
  if (NUMBER_ONLY.test(trimmed)) return { ok: true, value: Number(trimmed) };

  let total = 0;
  let matchedAny = false;
  let cursor = 0;
  while (cursor < trimmed.length) {
    while (cursor < trimmed.length && isWhitespace(trimmed[cursor]!)) cursor++;
    if (cursor >= trimmed.length) break;

    TOKEN.lastIndex = cursor;
    const match = TOKEN.exec(trimmed);
    if (!match) return { ok: false, message: `cannot read "${raw}" as a ${dimension}` };

    const numberPart = NUMBER_PART.exec(match[0])![0];
    const unit = match[0].slice(numberPart.length).trim();
    const factor = table[unit];
    if (factor === undefined) {
      const accepted = Object.keys(table).join(', ');
      return {
        ok: false,
        message: `unit "${unit}" is not a ${dimension} unit (accepted: ${accepted})`,
      };
    }

    total += Number(numberPart) * factor;
    matchedAny = true;
    cursor += match[0].length;
  }

  if (!matchedAny) return { ok: false, message: `cannot read "${raw}" as a ${dimension}` };
  return { ok: true, value: total };
}
