// buildLevels: the staleness/--check behaviour, exercised against a temp levels/ tree rather
// than the real one (docs/work/GRV-0016-level-compiler.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildLevels } from './levels-build.ts';

const VALID_LEVEL = `schema: 1
id: solo
name: Solo
brief: b
debrief: d
seed: 1
streams: []
dt: 30 s
bodies:
  - id: star
    name: Star
    class: star
    mass: 1.71e30 kg
    radius: 600000 km
    rotationPeriod: 25 d
    axialPhaseAtEpoch: 0 deg
rails: []
probes:
  - id: sweeper
    name: Sweeper
    count: 3
    dryMass: 420 kg
    propellantMass: 680 kg
    exhaustVelocity: 31 km/s
    maxThrust: 9.4 kN
    nodeBudget: 4
contacts: []
post:
  host: star
  longitude: 0 deg
`;

let levelsDir: string;

beforeEach(() => {
  levelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grv-levels-'));
});

afterEach(() => {
  fs.rmSync(levelsDir, { recursive: true, force: true });
});

test('an empty levels directory writes only the schema, and check then passes', () => {
  const write = buildLevels({ levelsDir, check: false });
  expect(write.ok).toBe(true);
  expect(fs.existsSync(path.join(levelsDir, 'schema', 'level.schema.json'))).toBe(true);

  const check = buildLevels({ levelsDir, check: true });
  expect(check).toEqual({ ok: true, messages: [] });
});

test('a valid level compiles, writes its JSON, and leaves check passing', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.yaml'), VALID_LEVEL);

  const write = buildLevels({ levelsDir, check: false });
  expect(write.ok).toBe(true);
  const compiled = fs.readFileSync(path.join(levelsDir, 'solo.level.json'), 'utf8');
  expect(JSON.parse(compiled).id).toBe('solo');
  expect(compiled.endsWith('\n')).toBe(true);

  expect(buildLevels({ levelsDir, check: true })).toEqual({ ok: true, messages: [] });
});

test('--check writes nothing when a level file is missing its compiled output', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.yaml'), VALID_LEVEL);

  const check = buildLevels({ levelsDir, check: true });
  expect(check.ok).toBe(false);
  expect(
    check.messages.some((m) => m.includes('solo.level.json') && m.includes('stale or missing')),
  ).toBe(true);
  expect(fs.existsSync(path.join(levelsDir, 'solo.level.json'))).toBe(false);
});

test('--check fails when the committed JSON no longer matches the source', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.yaml'), VALID_LEVEL);
  buildLevels({ levelsDir, check: false });

  fs.writeFileSync(
    path.join(levelsDir, 'solo.level.yaml'),
    VALID_LEVEL.replace('name: Solo', 'name: Renamed'),
  );
  const check = buildLevels({ levelsDir, check: true });
  expect(check.ok).toBe(false);
  expect(check.messages.some((m) => m.includes('solo.level.json'))).toBe(true);
});

test('a level with issues is reported and not written, and fails --check', () => {
  fs.writeFileSync(
    path.join(levelsDir, 'broken.level.yaml'),
    VALID_LEVEL.replace('mass: 1.71e30 kg', 'mass: 1.71e30 h'),
  );

  const write = buildLevels({ levelsDir, check: false });
  expect(write.ok).toBe(false);
  expect(write.messages.some((m) => m.includes('broken.level.yaml') && m.includes('error'))).toBe(
    true,
  );
  expect(fs.existsSync(path.join(levelsDir, 'broken.level.json'))).toBe(false);

  expect(buildLevels({ levelsDir, check: true }).ok).toBe(false);
});

test('a warning is reported but does not fail --check', () => {
  fs.writeFileSync(
    path.join(levelsDir, 'solo.level.yaml'),
    VALID_LEVEL.replace(
      'rails: []',
      `rails:
  - id: r
    name: R
    host: star
    longitude: 0 deg
    muzzleSpeed: { min: 60 km/s, max: 300 km/s }
    headingCone: 85 deg
    reloadTime: 30 s`,
    ),
  );

  const write = buildLevels({ levelsDir, check: false });
  expect(write.ok).toBe(true);
  expect(write.messages.some((m) => m.includes('solo.level.yaml') && m.includes('warning'))).toBe(
    true,
  );

  expect(buildLevels({ levelsDir, check: true }).ok).toBe(true);
});

test('the JSON Schema is regenerated and checked alongside the levels', () => {
  buildLevels({ levelsDir, check: false });
  const schemaPath = path.join(levelsDir, 'schema', 'level.schema.json');
  const original = fs.readFileSync(schemaPath, 'utf8');
  expect(JSON.parse(original).type).toBe('object');

  fs.writeFileSync(schemaPath, '{}\n');
  const check = buildLevels({ levelsDir, check: true });
  expect(check.ok).toBe(false);
  expect(check.messages.some((m) => m.includes('schema/level.schema.json'))).toBe(true);
});
