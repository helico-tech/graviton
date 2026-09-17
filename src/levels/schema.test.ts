// Schema-level behaviour that compile.ts depends on: unknown keys are errors, unit fields accept
// SI numbers or unit strings, and the generated JSON Schema is valid draft-07 with unit fields
// degraded to `anyOf: [number, string]` (research A.11).
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { generateLevelJsonSchema, LevelSourceSchema } from './schema.ts';

const MINIMAL = {
  schema: 1,
  id: 'x',
  name: 'X',
  brief: 'b',
  debrief: 'd',
  seed: 1,
  streams: [],
  dt: '30 s',
  bodies: [
    {
      id: 'star',
      name: 'Star',
      class: 'star',
      mass: '1e30 kg',
      radius: '600000 km',
      rotationPeriod: '25 d',
      axialPhaseAtEpoch: 0,
    },
  ],
  rails: [],
  probes: [],
  contacts: [],
};

describe('LevelSourceSchema', () => {
  test('accepts a minimal valid source', () => {
    const result = v.safeParse(LevelSourceSchema, MINIMAL);
    expect(result.success).toBe(true);
  });

  test('rejects an unknown top-level key', () => {
    const result = v.safeParse(LevelSourceSchema, { ...MINIMAL, bogus: true });
    expect(result.success).toBe(false);
  });

  test('rejects an unknown key nested inside a body', () => {
    const result = v.safeParse(LevelSourceSchema, {
      ...MINIMAL,
      bodies: [{ ...MINIMAL.bodies[0], extra: 1 }],
    });
    expect(result.success).toBe(false);
  });

  test('converts a unit-suffixed string quantity to SI', () => {
    const result = v.safeParse(LevelSourceSchema, MINIMAL);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.dt).toBe(30);
      expect(result.output.bodies[0]!.radius).toBeCloseTo(600000000, 6);
    }
  });

  test('rejects a body with eccentricity above 0.8', () => {
    const result = v.safeParse(LevelSourceSchema, {
      ...MINIMAL,
      bodies: [
        MINIMAL.bodies[0],
        {
          id: 'planet',
          name: 'Planet',
          class: 'rock',
          mass: '1e24 kg',
          radius: '6000 km',
          rotationPeriod: '1 d',
          axialPhaseAtEpoch: 0,
          orbit: { parent: 'star', a: '1 au', e: 0.9, argPeriapsis: 0, meanAnomalyAtEpoch: 0 },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('requires probes to have exactly one entry -- rejected at the semantic layer, not here', () => {
    // Schema alone allows any array length; compile.ts's semantic pass gives the specific
    // "one probe type" message. This test just pins that the schema itself does not reject it.
    const result = v.safeParse(LevelSourceSchema, {
      ...MINIMAL,
      probes: [
        {
          id: 'a',
          name: 'A',
          count: 1,
          dryMass: '1 kg',
          propellantMass: '1 kg',
          exhaustVelocity: '1 km/s',
          maxThrust: '1 kN',
          nodeBudget: 1,
        },
        {
          id: 'b',
          name: 'B',
          count: 1,
          dryMass: '1 kg',
          propellantMass: '1 kg',
          exhaustVelocity: '1 km/s',
          maxThrust: '1 kN',
          nodeBudget: 1,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('generateLevelJsonSchema', () => {
  test('is a draft-07 object schema with unit fields as anyOf[number, string]', () => {
    const schema = generateLevelJsonSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, { anyOf?: unknown }>;
    expect(properties.dt?.anyOf).toBeDefined();
  });
});
