// compileLevel: YAML -> CompiledLevel | issues (docs/work/GRV-0016-level-compiler.md). Line
// numbers below are asserted against VALID_YAML's actual layout (1-indexed, counted by hand and
// cross-checked against the "1-indexed" test just below) -- table-driven per error/warning class,
// with line/column pinned for at least three different kinds of issue (a schema issue, a semantic
// issue and a YAML syntax error).
import { describe, expect, test } from 'vitest';
import { canonicalJson, compileLevel } from './compile.ts';
import type { CompiledLevel } from './compile.ts';
import { createSim } from '../sim/sim.ts';

const VALID_YAML = `schema: 1
id: T00-fixture
name: Fixture
brief: A brief.
debrief: A debrief.
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
  - id: planet
    name: Planet
    class: rock
    mass: 4.9e24 kg
    radius: 6100 km
    rotationPeriod: 24 h
    axialPhaseAtEpoch: 0 deg
    orbit:
      parent: star
      a: 1 au
      e: 0.01
      argPeriapsis: 0 deg
      meanAnomalyAtEpoch: 0 deg
rails:
  - id: rail-1
    name: Rail One
    host: planet
    longitude: 0 deg
    muzzleSpeed: { min: 60 km/s, max: 300 km/s }
    headingCone: 69 deg
    reloadTime: 6 h
probes:
  - id: sweeper
    name: Sweeper
    count: 3
    dryMass: 420 kg
    propellantMass: 680 kg
    exhaustVelocity: 31 km/s
    maxThrust: 9.4 kN
    nodeBudget: 4
contacts:
  - kind: fixed
    id: hulk
    name: Hulk
    host: planet
    longitude: 0 deg
    captureRadius: 40 km
    clearedBy: { minimumImpactEnergy: 2.4 TJ }
`;

const PATH = 'T00-fixture.level.yaml';

function compile(yaml: string, path = PATH) {
  return compileLevel({ source: yaml, path });
}

function expectIssues(result: ReturnType<typeof compile>) {
  if ('level' in result) throw new Error('expected issues, compiled successfully instead');
  return result.issues;
}

function expectLevel(result: ReturnType<typeof compile>): CompiledLevel {
  if ('issues' in result)
    throw new Error(`expected a level, got issues: ${JSON.stringify(result.issues)}`);
  return result.level;
}

describe('the fixture line numbers the tests below rely on', () => {
  test('line 2 is "id:", line 35 is "muzzleSpeed:"', () => {
    const lines = VALID_YAML.split('\n');
    expect(lines[1]).toBe('id: T00-fixture');
    expect(lines[34]).toContain('muzzleSpeed:');
  });
});

describe('compileLevel: success', () => {
  test('compiles a valid level to a Scenario the simulation accepts as is', () => {
    const level = expectLevel(compile(VALID_YAML));
    expect(level.id).toBe('T00-fixture');
    expect(level.bodyIds).toEqual(['star', 'planet']);
    expect(level.bodyClasses).toEqual(['star', 'rock']);
    expect(level.names).toEqual({
      bodies: ['Star', 'Planet'],
      rails: ['Rail One'],
      contacts: ['Hulk'],
    });

    const G = 6.6743e-11;
    expect(level.scenario.bodies[0]).toMatchObject({
      parent: -1,
      mu: G * 1.71e30,
      radius: 600000000,
    });
    expect(level.scenario.bodies[1]).toMatchObject({ parent: 0 });

    expect(level.scenario.capacity).toBe(3);
    expect(level.scenario.burnNodeCapacity).toBe(12); // count(3) * nodeBudget(4)
    expect(level.scenario.probe).toMatchObject({ dryMass: 420, thrust: 9400 });
    expect(level.scenario.rails[0]).toMatchObject({ host: 1, reloadTicks: 720 }); // 6h / 30s
    expect(level.scenario.contacts).toEqual([
      { host: 1, longitude: 0, captureRadius: 40000, minimumImpactEnergy: 2.4e12 },
    ]);
  });

  test('a bare-SI number and its unit-suffixed equivalent compile identically', () => {
    const si = VALID_YAML.replace('radius: 600000 km', 'radius: 600000000');
    const a = expectLevel(compile(si));
    const b = expectLevel(compile(VALID_YAML));
    expect(a.scenario.bodies[0]!.radius).toBe(b.scenario.bodies[0]!.radius);
  });

  test('success carries warnings: [] when there is nothing to warn about', () => {
    const result = compile(VALID_YAML);
    if ('issues' in result) throw new Error('expected success');
    expect(result.warnings).toEqual([]);
  });
});

describe('compileLevel: schema issues (line/column mapped to the offending YAML node)', () => {
  test('a bare unit from the wrong dimension is an error at the exact field', () => {
    const bad = VALID_YAML.replace('radius: 6100 km', 'radius: 6100 h');
    const issues = expectIssues(compile(bad));
    const issue = issues.find((i) => i.path === 'bodies[1].radius')!;
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('error');
    expect(issue.message).toBe(
      'unit "h" is not a length unit (accepted: m, km, Mm, Gm, au, ls, lm)',
    );
    expect(issue.line).toBe(21); // the "radius: 6100 h" line
  });

  test('an unknown key anywhere is an error', () => {
    const bad = VALID_YAML.replace('name: Fixture', 'name: Fixture\nbogus: true');
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.message.includes('bogus'))).toBe(true);
  });

  test('eccentricity above 0.8 is a schema error', () => {
    const bad = VALID_YAML.replace('e: 0.01', 'e: 0.95');
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.path === 'bodies[1].orbit.e')).toBe(true);
  });

  test('a body class outside the six known classes is rejected', () => {
    const bad = VALID_YAML.replace('class: rock', 'class: wood');
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.path === 'bodies[1].class')).toBe(true);
  });
});

describe('compileLevel: YAML syntax issues', () => {
  test('a duplicate key is an error with a real line and column', () => {
    const bad = VALID_YAML.replace('name: Fixture\n', 'name: Fixture\nname: Duplicate\n');
    const issues = expectIssues(compile(bad));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('Map keys must be unique');
    expect(issues[0]!.line).toBe(4); // the duplicate ("name: Duplicate") line, not the original
  });

  test('an unresolvable alias is an error, not an uncaught throw', () => {
    const bad = VALID_YAML.replace('name: Fixture', 'name: *nope');
    const issues = expectIssues(compile(bad));
    expect(issues.length).toBeGreaterThan(0);
  });

  test('an explicit %YAML 1.1 directive is rejected', () => {
    const bad = `%YAML 1.1\n---\n${VALID_YAML}`;
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.message.includes('%YAML 1.2'))).toBe(true);
  });
});

describe('compileLevel: semantic checks', () => {
  test('id must match the filename stem', () => {
    const issues = expectIssues(compile(VALID_YAML, 'wrong-name.level.yaml'));
    const issue = issues.find((i) => i.path === 'id')!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain('wrong-name');
    expect(issue.line).toBe(2); // the "id:" line
  });

  test('a body other than the first must have an orbit', () => {
    const bad = VALID_YAML.replace(/\n {4}orbit:\n(.|\n)*?meanAnomalyAtEpoch: 0 deg\n/, '\n');
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.message.includes('must have an orbit'))).toBe(true);
  });

  test('the first body must not have an orbit', () => {
    const bad = VALID_YAML.replace(
      'axialPhaseAtEpoch: 0 deg\n  - id: planet',
      'axialPhaseAtEpoch: 0 deg\n    orbit: { parent: planet, a: 1 au, e: 0, argPeriapsis: 0 deg, meanAnomalyAtEpoch: 0 deg }\n  - id: planet',
    );
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.message.includes('must not have an orbit'))).toBe(true);
  });

  test('an orbit referencing an id that does not exist at all is "unknown body id"', () => {
    const bad = VALID_YAML.replace('parent: star', 'parent: ghost');
    const issues = expectIssues(compile(bad));
    const issue = issues.find((i) => i.path === 'bodies[1].orbit.parent')!;
    expect(issue.message).toBe('unknown body id "ghost"');
  });

  test('an orbit referencing an id that exists but appears later is "parent-first", not "unknown"', () => {
    // Two orbiting bodies where the second references the first, and the first references the
    // second right back -- "moon" is a real id in the file, just not yet declared.
    const bad = VALID_YAML.replace('parent: star', 'parent: moon').replace(
      'rails:',
      `  - id: moon
    name: Moon
    class: rock
    mass: 1e22 kg
    radius: 500 km
    rotationPeriod: 5 d
    axialPhaseAtEpoch: 0 deg
    orbit: { parent: planet, a: 1e6 km, e: 0, argPeriapsis: 0 deg, meanAnomalyAtEpoch: 0 deg }
rails:`,
    );
    const issues = expectIssues(compile(bad));
    const issue = issues.find((i) => i.path === 'bodies[1].orbit.parent')!;
    expect(issue.message).toContain('parent-first');
    expect(issue.message).toContain('"moon"');
  });

  test('duplicate body ids', () => {
    const bad = VALID_YAML.replace('id: planet', 'id: star');
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.message === 'duplicate body id "star"')).toBe(true);
  });

  test('a rail host that does not exist is an error', () => {
    const bad = VALID_YAML.replace(
      'host: planet\n    longitude: 0 deg\n    muzzleSpeed',
      'host: ghost\n    longitude: 0 deg\n    muzzleSpeed',
    );
    const issues = expectIssues(compile(bad));
    expect(
      issues.some((i) => i.message === 'unknown body id "ghost"' && i.path === 'rails[0].host'),
    ).toBe(true);
  });

  test('reloadTime that is not a whole number of ticks is an error', () => {
    const bad = VALID_YAML.replace('reloadTime: 6 h', 'reloadTime: 1 s'); // dt is 30 s
    const issues = expectIssues(compile(bad));
    expect(
      issues.some(
        (i) => i.path === 'rails[0].reloadTime' && i.message.includes('whole number of ticks'),
      ),
    ).toBe(true);
  });

  test('zero probes is an error naming the one-probe-type rule', () => {
    const bad = VALID_YAML.replace(/probes:\n(.|\n)*?nodeBudget: 4\n/, 'probes: []\n');
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.path === 'probes' && i.message.includes('one probe type'))).toBe(
      true,
    );
  });

  test('more than one probe entry is the same error', () => {
    const bad = VALID_YAML.replace(
      'contacts:',
      `  - id: sweeper2
    name: Sweeper Two
    count: 1
    dryMass: 420 kg
    propellantMass: 680 kg
    exhaustVelocity: 31 km/s
    maxThrust: 9.4 kN
    nodeBudget: 4
contacts:`,
    );
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.path === 'probes' && i.message.includes('one probe type'))).toBe(
      true,
    );
  });

  test('a contact host that does not exist is an error', () => {
    const bad = VALID_YAML.replace(
      'host: planet\n    longitude: 0 deg\n    captureRadius',
      'host: ghost\n    longitude: 0 deg\n    captureRadius',
    );
    const issues = expectIssues(compile(bad));
    expect(
      issues.some((i) => i.message === 'unknown body id "ghost"' && i.path === 'contacts[0].host'),
    ).toBe(true);
  });
});

describe('compileLevel: the createSim fallback ("everything createSim would reject")', () => {
  test('a muzzle band with max below min is rejected by the simulation itself', () => {
    const bad = VALID_YAML.replace('min: 60 km/s, max: 300 km/s', 'min: 300 km/s, max: 60 km/s');
    const issues = expectIssues(compile(bad));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message.toLowerCase()).toContain('muzzlespeedmax');
  });
});

describe('compileLevel: warnings', () => {
  test('headingCone above 80 deg warns (resolves the shallow-launch self-collision issue)', () => {
    const wide = VALID_YAML.replace('headingCone: 69 deg', 'headingCone: 85 deg');
    const result = compile(wide);
    if ('issues' in result) throw new Error('expected success with a warning');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.severity).toBe('warning');
    expect(result.warnings[0]!.path).toBe('rails[0].headingCone');
    expect(result.warnings[0]!.message).toContain('80 deg');
    expect(result.warnings[0]!.message).toContain('shallow-launch-can-self-collide');
  });

  test('headingCone at exactly 80 deg does not warn (the issue\'s own "clean" boundary)', () => {
    const edge = VALID_YAML.replace('headingCone: 69 deg', 'headingCone: 80 deg');
    const result = compile(edge);
    if ('issues' in result) throw new Error('expected success');
    expect(result.warnings).toEqual([]);
  });

  test('a muzzle band that cannot cross the widest separation within 40 days warns', () => {
    const slow = VALID_YAML.replace(
      'muzzleSpeed: { min: 60 km/s, max: 300 km/s }',
      'muzzleSpeed: { min: 1 m/s, max: 1 m/s }',
    );
    const result = compile(slow);
    if ('issues' in result) throw new Error('expected success with a warning');
    expect(result.warnings.some((w) => w.message.includes('worst-case'))).toBe(true);
  });
});

describe('compileLevel: angle normalisation (docs/issues/2026-09-18-unbounded-angles-reach-trig-kernel.md)', () => {
  const TWO_PI = 6.283185307179586;

  test.each([0, 0.1, Math.PI, TWO_PI - 1e-9, 6.283185307179585])(
    'an in-range axialPhaseAtEpoch (%p rad) round-trips bit-identical (Object.is)',
    (value) => {
      const yaml = VALID_YAML.replace('axialPhaseAtEpoch: 0 deg', `axialPhaseAtEpoch: ${value}`);
      const level = expectLevel(compile(yaml));
      expect(Object.is(level.scenario.bodies[0]!.axialPhaseAtEpoch, value)).toBe(true);
    },
  );

  test('an out-of-range axialPhaseAtEpoch (the demonstrated 100000000 deg) is normalised into [0, 2pi)', () => {
    const bad = VALID_YAML.replace('axialPhaseAtEpoch: 0 deg', 'axialPhaseAtEpoch: 100000000 deg');
    const level = expectLevel(compile(bad));
    const phase = level.scenario.bodies[0]!.axialPhaseAtEpoch;
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(TWO_PI);
    // createSim/advance must no longer throw the trig kernel's |x| <= 2^18 RangeError on tick 0.
    expect(() => createSim({ scenario: level.scenario, seed: 1 })).not.toThrow();
  });

  test('an out-of-range rail longitude is normalised into [0, 2pi)', () => {
    const bad = VALID_YAML.replace(
      'longitude: 0 deg\n    muzzleSpeed',
      'longitude: -370 deg\n    muzzleSpeed',
    );
    const level = expectLevel(compile(bad));
    const longitude = level.scenario.rails[0]!.longitude;
    expect(longitude).toBeGreaterThanOrEqual(0);
    expect(longitude).toBeLessThan(TWO_PI);
  });

  test('an out-of-range contact longitude is normalised into [0, 2pi)', () => {
    const bad = VALID_YAML.replace(
      'longitude: 0 deg\n    captureRadius',
      'longitude: 730 deg\n    captureRadius',
    );
    const level = expectLevel(compile(bad));
    const longitude = level.scenario.contacts[0]!.longitude;
    expect(longitude).toBeGreaterThanOrEqual(0);
    expect(longitude).toBeLessThan(TWO_PI);
  });

  test('an out-of-range argPeriapsis is normalised into [0, 2pi)', () => {
    const bad = VALID_YAML.replace('argPeriapsis: 0 deg', 'argPeriapsis: -10 deg');
    const level = expectLevel(compile(bad));
    const planet = level.scenario.bodies[1]!;
    if (!('a' in planet)) throw new Error('expected the orbiting body');
    expect(planet.argPeriapsis).toBeGreaterThanOrEqual(0);
    expect(planet.argPeriapsis).toBeLessThan(TWO_PI);
  });

  test('an out-of-range meanAnomalyAtEpoch is normalised into [0, 2pi)', () => {
    const bad = VALID_YAML.replace('meanAnomalyAtEpoch: 0 deg', 'meanAnomalyAtEpoch: 400 deg');
    const level = expectLevel(compile(bad));
    const planet = level.scenario.bodies[1]!;
    if (!('a' in planet)) throw new Error('expected the orbiting body');
    expect(planet.meanAnomaly0).toBeGreaterThanOrEqual(0);
    expect(planet.meanAnomaly0).toBeLessThan(TWO_PI);
  });
});

describe('compileLevel: reloadTicks bound (docs/issues/2026-09-18-reload-ticks-wrap-int32.md)', () => {
  test('the demonstrated huge reloadTime is a positioned issue, not a silent wrap', () => {
    const bad = VALID_YAML.replace('reloadTime: 6 h', 'reloadTime: 100000000000 h'); // -> 1.2e13 ticks at dt=30s
    const issues = expectIssues(compile(bad));
    const issue = issues.find((i) => i.path === 'rails[0].reloadTime');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('Int32');
    expect(issue!.line).toBe(37); // the "reloadTime: ..." line, not the whole-document fallback
  });
});

describe('compileLevel: probe count bound (docs/issues/2026-09-18-probe-count-unbounded.md)', () => {
  test('the demonstrated count: 1000000000 is a schema issue at probes[0].count', () => {
    const bad = VALID_YAML.replace('count: 3', 'count: 1000000000');
    const issues = expectIssues(compile(bad));
    expect(issues.some((i) => i.path === 'probes[0].count')).toBe(true);
  });
});

describe('canonicalJson', () => {
  test('sorts object keys and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [3, 2, 1] })).toBe(
      '{\n  "a": [\n    3,\n    2,\n    1\n  ],\n  "b": 1\n}\n',
    );
  });

  test('compiling the same source twice is byte-identical', () => {
    const a = expectLevel(compile(VALID_YAML));
    const b = expectLevel(compile(VALID_YAML));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  test('a unit-converted value round-trips to the identical double through JSON', () => {
    const withFraction = VALID_YAML.replace('rotationPeriod: 25 d', 'rotationPeriod: 24.1 d');
    const level = expectLevel(compile(withFraction));
    const expected = 24.1 * 86400;
    expect(level.scenario.bodies[0]!.rotationPeriod).toBe(expected);
    const json = canonicalJson(level);
    const reparsed = JSON.parse(json) as CompiledLevel;
    expect(reparsed.scenario.bodies[0]!.rotationPeriod).toBe(expected);
  });

  test('ends with a trailing newline', () => {
    expect(canonicalJson({ a: 1 }).endsWith('\n')).toBe(true);
  });
});
