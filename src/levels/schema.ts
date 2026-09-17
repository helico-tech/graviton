// Level source schema (ADR-0006 §2-3, docs/work/GRV-0016-level-compiler.md): only what the
// simulation implements today -- bodies with spin, rails, one probe type, fixed contacts,
// streams, dt. Unit-suffixed fields accept a bare SI number or a dimension-scoped string
// (units.ts); everything else is validated structurally. `strictObject` throughout: an unknown
// key is an error, not a silently ignored typo (research A.3's whole argument for YAML over a
// format that lets that pass).
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import type { Dimension } from './units.ts';
import { parseQuantity } from './units.ts';

const MAX_UINT32 = 4294967295;
const MAX_ECCENTRICITY = 0.8; // mirrors src/sim/ephemeris/bodies.ts's own ceiling
const HALF_TURN = Math.PI;

/** A field accepting either an already-SI number or a dimension-scoped unit string
 *  ("9.4 kN"), converted to SI during validation so every later stage sees plain doubles. */
function quantity(dimension: Dimension) {
  return v.pipe(
    v.union([v.number(), v.string()]),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const raw = dataset.value;
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) {
          addIssue({ message: `must be a finite ${dimension}, got ${raw}` });
          return NEVER;
        }
        return raw;
      }
      const result = parseQuantity(raw, dimension);
      if (!result.ok) {
        addIssue({ message: result.message });
        return NEVER;
      }
      return result.value;
    }),
  );
}

function positiveQuantity(dimension: Dimension) {
  return v.pipe(
    quantity(dimension),
    v.check(
      (n) => n > 0,
      (issue) => `must be a positive ${dimension}, got ${issue.input}`,
    ),
  );
}

function nonNegativeQuantity(dimension: Dimension) {
  return v.pipe(
    quantity(dimension),
    v.check(
      (n) => n >= 0,
      (issue) => `must be a non-negative ${dimension}, got ${issue.input}`,
    ),
  );
}

const nonEmpty = v.pipe(v.string(), v.minLength(1, 'must not be empty'));

const OrbitSchema = v.strictObject({
  parent: nonEmpty,
  a: positiveQuantity('length'),
  e: v.pipe(
    v.number(),
    v.minValue(0, 'eccentricity must be >= 0'),
    v.maxValue(MAX_ECCENTRICITY, `eccentricity must be <= ${MAX_ECCENTRICITY}`),
  ),
  argPeriapsis: quantity('angle'),
  meanAnomalyAtEpoch: quantity('angle'),
});

export const BODY_CLASSES = ['star', 'rock', 'ice', 'gas', 'molten', 'metal'] as const;

const BodySchema = v.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  class: v.picklist(BODY_CLASSES),
  mass: positiveQuantity('mass'),
  radius: positiveQuantity('length'),
  rotationPeriod: positiveQuantity('duration'),
  axialPhaseAtEpoch: quantity('angle'),
  orbit: v.optional(OrbitSchema),
});

const RailSchema = v.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  host: nonEmpty,
  longitude: quantity('angle'),
  // max >= min is exactly the kind of thing createSim already rejects (createRailTable) --
  // left to the compileLevel's createSim fallback rather than duplicated here.
  muzzleSpeed: v.strictObject({ min: positiveQuantity('speed'), max: positiveQuantity('speed') }),
  headingCone: v.pipe(
    quantity('angle'),
    v.check(
      (n) => n > 0 && n <= HALF_TURN,
      (issue) => `headingCone must be in (0 deg, 180 deg], got ${issue.input} rad`,
    ),
  ),
  reloadTime: nonNegativeQuantity('duration'),
});

const ProbeSchema = v.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  count: v.pipe(
    v.number(),
    v.integer('count must be an integer'),
    v.minValue(1, 'count must be >= 1'),
  ),
  dryMass: positiveQuantity('mass'),
  propellantMass: nonNegativeQuantity('mass'),
  exhaustVelocity: positiveQuantity('speed'),
  maxThrust: positiveQuantity('force'),
  nodeBudget: v.pipe(
    v.number(),
    v.integer('nodeBudget must be an integer'),
    v.minValue(0, 'nodeBudget must be >= 0'),
  ),
});

const ContactSchema = v.strictObject({
  kind: v.literal('fixed'),
  id: nonEmpty,
  name: nonEmpty,
  host: nonEmpty,
  longitude: quantity('angle'),
  captureRadius: positiveQuantity('length'),
  clearedBy: v.strictObject({ minimumImpactEnergy: positiveQuantity('energy') }),
});

export const LevelSourceSchema = v.strictObject({
  schema: v.literal(1),
  id: nonEmpty,
  name: nonEmpty,
  brief: nonEmpty,
  debrief: nonEmpty,
  seed: v.pipe(
    v.number(),
    v.integer('seed must be an integer'),
    v.minValue(0, 'seed must be >= 0'),
    v.maxValue(MAX_UINT32, `seed must be <= ${MAX_UINT32}`),
  ),
  streams: v.array(nonEmpty),
  dt: positiveQuantity('duration'),
  bodies: v.pipe(v.array(BodySchema), v.minLength(1, 'at least one body is required')),
  rails: v.array(RailSchema),
  probes: v.array(ProbeSchema),
  contacts: v.array(ContactSchema),
});

export type LevelSource = v.InferOutput<typeof LevelSourceSchema>;
export type BodySource = v.InferOutput<typeof BodySchema>;
export type OrbitSource = v.InferOutput<typeof OrbitSchema>;
export type RailSource = v.InferOutput<typeof RailSchema>;
export type ProbeSource = v.InferOutput<typeof ProbeSchema>;
export type ContactSource = v.InferOutput<typeof ContactSchema>;

/** JSON Schema for editors (research A.11): generated from the same valibot schema that
 *  validates at build time, so there is one definition and no drift. Unit-suffixed fields
 *  degrade to `anyOf: [number, string]` (`errorMode: 'ignore'`) because a transform pipe has no
 *  JSON Schema representation of its own -- exactly the right hint for a field that accepts
 *  `9400` or `"9.4 kN"`. */
export function generateLevelJsonSchema(): Record<string, unknown> {
  return toJsonSchema(LevelSourceSchema, { errorMode: 'ignore' }) as Record<string, unknown>;
}
