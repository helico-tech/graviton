// verifyLevels: the CLI's write/--check semantics, exercised against a temp levels/ tree rather
// than the real one (mirrors levels-build.test.ts's own style). The scenarios here are the
// smallest createSim accepts, not physically meaningful -- verify.test.ts already covers the real
// replay/evidence logic against the compiler fixture; this file is only the file-wiring layer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { verifyLevels } from './levels-verify.ts';
import { canonicalJson } from '../src/levels/compile.ts';
import { SIM_VERSION } from '../src/sim/version.ts';

const PROBE = { dryMass: 1, propellantMass: 1, exhaustVelocity: 1, thrust: 1 };

function noContactLevel(id: string) {
  return {
    schema: 1,
    id,
    name: id,
    brief: 'b',
    debrief: 'd',
    seed: 1,
    names: { bodies: [], rails: [], contacts: [] },
    bodyIds: [],
    railIds: [],
    contactIds: [],
    bodyClasses: [],
    scenario: {
      dt: 30,
      capacity: 1,
      burnNodeCapacity: 0,
      bodies: [],
      rails: [],
      contacts: [],
      probe: PROBE,
      streams: [],
    },
  };
}

function uncleanableContactLevel(id: string) {
  return {
    schema: 1,
    id,
    name: id,
    brief: 'b',
    debrief: 'd',
    seed: 1,
    names: { bodies: ['Star'], rails: [], contacts: ['c'] },
    bodyIds: ['star'],
    railIds: [],
    contactIds: ['c'],
    bodyClasses: ['star'],
    scenario: {
      dt: 30,
      capacity: 1,
      burnNodeCapacity: 0,
      bodies: [{ parent: -1, mu: 1e10, radius: 1000, rotationPeriod: 86400, axialPhaseAtEpoch: 0 }],
      rails: [],
      contacts: [{ host: 0, longitude: 0, captureRadius: 1, minimumImpactEnergy: 1 }],
      probe: PROBE,
      streams: [],
    },
  };
}

function solutionFor(id: string) {
  return { level: id, simVersion: SIM_VERSION, ticks: 1, log: [] };
}

let levelsDir: string;

beforeEach(() => {
  levelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grv-levels-verify-'));
});

afterEach(() => {
  fs.rmSync(levelsDir, { recursive: true, force: true });
});

test('a level with a solution that clears writes evidence and reports ok', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.json'), canonicalJson(noContactLevel('solo')));
  fs.writeFileSync(path.join(levelsDir, 'solo.solution.json'), canonicalJson(solutionFor('solo')));

  const result = verifyLevels({ levelsDir, check: false });

  expect(result).toEqual({ ok: true, messages: ['levels: solo ok'] });
  const evidencePath = path.join(levelsDir, 'solo.evidence.json');
  expect(fs.existsSync(evidencePath)).toBe(true);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  expect(evidence.level).toBe('solo');
  expect(evidence.outcome).toEqual({
    contactsCleared: 0,
    contactsTotal: 0,
    probesGranted: 1,
    probesLaunched: 0,
    propellantRemaining: [],
  });
});

test('--check is clean once the evidence has been written', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.json'), canonicalJson(noContactLevel('solo')));
  fs.writeFileSync(path.join(levelsDir, 'solo.solution.json'), canonicalJson(solutionFor('solo')));
  verifyLevels({ levelsDir, check: false });

  expect(verifyLevels({ levelsDir, check: true })).toEqual({
    ok: true,
    messages: ['levels: solo ok'],
  });
});

test('--check writes nothing and fails when the evidence file is missing', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.json'), canonicalJson(noContactLevel('solo')));
  fs.writeFileSync(path.join(levelsDir, 'solo.solution.json'), canonicalJson(solutionFor('solo')));

  const check = verifyLevels({ levelsDir, check: true });

  expect(check.ok).toBe(false);
  expect(
    check.messages.some((m) => m.includes('solo.evidence.json') && m.includes('stale or missing')),
  ).toBe(true);
  expect(fs.existsSync(path.join(levelsDir, 'solo.evidence.json'))).toBe(false);
});

test('--check fails when the committed evidence no longer matches what verify would produce', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.json'), canonicalJson(noContactLevel('solo')));
  fs.writeFileSync(path.join(levelsDir, 'solo.solution.json'), canonicalJson(solutionFor('solo')));
  verifyLevels({ levelsDir, check: false });

  fs.writeFileSync(path.join(levelsDir, 'solo.evidence.json'), '{}\n');
  const check = verifyLevels({ levelsDir, check: true });

  expect(check.ok).toBe(false);
  expect(check.messages.some((m) => m.includes('solo.evidence.json'))).toBe(true);
});

test('a level without a solution is reported, not failed', () => {
  fs.writeFileSync(path.join(levelsDir, 'solo.level.json'), canonicalJson(noContactLevel('solo')));

  const result = verifyLevels({ levelsDir, check: false });

  expect(result).toEqual({ ok: true, messages: ['levels: solo no solution'] });
  expect(fs.existsSync(path.join(levelsDir, 'solo.evidence.json'))).toBe(false);
});

test('a level whose solution does not clear every contact writes evidence and fails', () => {
  fs.writeFileSync(
    path.join(levelsDir, 'uncleared.level.json'),
    canonicalJson(uncleanableContactLevel('uncleared')),
  );
  fs.writeFileSync(
    path.join(levelsDir, 'uncleared.solution.json'),
    canonicalJson(solutionFor('uncleared')),
  );

  const result = verifyLevels({ levelsDir, check: false });

  expect(result.ok).toBe(false);
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toContain('levels: uncleared FAILED:');
  expect(result.messages[0]).toContain('not all contacts cleared');
  expect(fs.existsSync(path.join(levelsDir, 'uncleared.evidence.json'))).toBe(true);
});

test('multiple levels are each reported on their own line, sorted by filename', () => {
  fs.writeFileSync(path.join(levelsDir, 'b.level.json'), canonicalJson(noContactLevel('b')));
  fs.writeFileSync(path.join(levelsDir, 'b.solution.json'), canonicalJson(solutionFor('b')));
  fs.writeFileSync(path.join(levelsDir, 'a.level.json'), canonicalJson(noContactLevel('a')));
  fs.writeFileSync(path.join(levelsDir, 'a.solution.json'), canonicalJson(solutionFor('a')));

  const result = verifyLevels({ levelsDir, check: false });

  expect(result).toEqual({ ok: true, messages: ['levels: a ok', 'levels: b ok'] });
});
