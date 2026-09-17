// YAML source -> canonical JSON (ADR-0006 §1, docs/work/GRV-0016-level-compiler.md): parses with
// yaml's Document API so every valibot issue and every semantic check below can be mapped back to
// a source line and column, runs the schema (schema.ts), then the checks the schema cannot
// express on its own (parent-first bodies, id references, the filename match) and finally the
// simulation's own validation, so a level that compiles is a level `createSim` accepts.
import { basename } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import * as v from 'valibot';
import { LevelSourceSchema } from './schema.ts';
import type { LevelSource } from './schema.ts';
import { createSim } from '../sim/sim.ts';
import type { BodyDef, RailDef, Scenario } from '../sim/sim.ts';

const G = 6.6743e-11; // CODATA gravitational constant; mu = G * mass (ADR-0006 §2), stated once
const TRANSFER_WINDOW_SECONDS = 40 * 86400; // ADR-0006 §6's muzzle-band warning window
const WIDE_CONE_DEG = 80; // docs/issues/2026-09-17-shallow-launch-can-self-collide.md

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  path: string;
  line: number;
  column: number;
}

/** Mirrors the sim's eventual `Scenario['contacts']` element shape. GRV-0015 (a different
 *  worktree) adds this field to `Scenario` itself; until it merges, `compile.ts` carries its own
 *  copy and strips it before handing a scenario to `createSim` -- see `buildScenario` below. */
export interface CompiledContact {
  host: number;
  longitude: number;
  captureRadius: number;
  minimumImpactEnergy: number;
}

export interface CompiledLevel {
  schema: 1;
  id: string;
  name: string;
  brief: string;
  debrief: string;
  seed: number;
  names: { bodies: string[]; rails: string[]; contacts: string[] };
  bodyIds: string[];
  railIds: string[];
  contactIds: string[];
  bodyClasses: string[];
  scenario: Scenario & { contacts: CompiledContact[] };
}

export type CompileLevelResult =
  { level: CompiledLevel; warnings: Issue[] } | { issues: Issue[]; warnings: Issue[] };

type ParsedLevelDocument = ReturnType<typeof parseDocument>;
type PathPart = string | number;

function formatPath(parts: readonly PathPart[]): string {
  let out = '';
  for (const part of parts) out += typeof part === 'number' ? `[${part}]` : out ? `.${part}` : part;
  return out;
}

interface Positions {
  root(): { line: number; column: number };
  at(pathParts: readonly PathPart[]): { line: number; column: number };
}

function toLineCol(lineCounter: LineCounter, offset: number): { line: number; column: number } {
  const pos = lineCounter.linePos(offset);
  return { line: pos.line, column: pos.col };
}

/** Maps a JSON path (a valibot issue's path, or a semantic check's own) back to the YAML node it
 *  came from via `doc.getIn`, which keeps byte ranges on every parsed node (research A.4). A path
 *  with no node of its own (e.g. a missing required key) falls back to its nearest ancestor that
 *  does have one, and finally to the document root. */
function createPositions(doc: ParsedLevelDocument, lineCounter: LineCounter): Positions {
  const nodeRange = (pathParts: readonly PathPart[]): [number, number, number] | undefined =>
    (doc.getIn(pathParts, true) as { range?: [number, number, number] } | undefined)?.range;

  const root = (): { line: number; column: number } => {
    const range = doc.contents?.range;
    return range ? toLineCol(lineCounter, range[0]) : { line: 1, column: 1 };
  };

  return {
    root,
    at(pathParts) {
      for (let end = pathParts.length; end >= 0; end--) {
        const range = nodeRange(pathParts.slice(0, end));
        if (range) return toLineCol(lineCounter, range[0]);
      }
      return root();
    },
  };
}

function errorAt(positions: Positions, pathParts: readonly PathPart[], message: string): Issue {
  return { severity: 'error', message, path: formatPath(pathParts), ...positions.at(pathParts) };
}

function warnAt(positions: Positions, pathParts: readonly PathPart[], message: string): Issue {
  return { severity: 'warning', message, path: formatPath(pathParts), ...positions.at(pathParts) };
}

function checkYamlVersionDirective(doc: ParsedLevelDocument, positions: Positions): Issue | null {
  const yamlDirective = doc.directives?.yaml;
  if (yamlDirective?.explicit && yamlDirective.version !== '1.2')
    return {
      severity: 'error',
      message: `level files must use %YAML 1.2 (found %YAML ${yamlDirective.version})`,
      path: '',
      ...positions.root(),
    };
  return null;
}

function yamlErrorIssues(doc: ParsedLevelDocument, positions: Positions): Issue[] {
  return doc.errors.map((err) => {
    const [start] = err.linePos ?? [];
    const pos = start ? { line: start.line, column: start.col } : positions.root();
    return {
      severity: 'error',
      message: err.message.replace(/ at line \d+, column \d+:$/, ''),
      path: '',
      ...pos,
    };
  });
}

function schemaIssues(issues: readonly v.BaseIssue<unknown>[], positions: Positions): Issue[] {
  return issues.map((issue) => {
    const parts: PathPart[] = (issue.path ?? []).map((item) => item.key as PathPart);
    return errorAt(positions, parts, issue.message);
  });
}

/** Every ancestor's `a * (1 + e)`, summed up the parent chain (planar, so no inclination term):
 *  a crude but honest closed-form upper bound on a body's distance from the system primary,
 *  reached only if every orbit in the chain is simultaneously at apoapsis on the same side. */
function apoapsisBoundFromPrimary(bodyDefs: readonly BodyDef[], index: number): number {
  const body = bodyDefs[index]!;
  if (!('a' in body)) return 0;
  return body.a * (1 + body.e) + apoapsisBoundFromPrimary(bodyDefs, body.parent);
}

function collectWarnings({
  source,
  bodyDefs,
  bodyIndex,
  positions,
}: {
  source: LevelSource;
  bodyDefs: readonly BodyDef[];
  bodyIndex: ReadonlyMap<string, number>;
  positions: Positions;
}): Issue[] {
  const warnings: Issue[] = [];
  const wideConeRad = (WIDE_CONE_DEG * Math.PI) / 180;

  source.rails.forEach((rail, i) => {
    if (rail.headingCone <= wideConeRad) return;
    const deg = (rail.headingCone * 180) / Math.PI;
    warnings.push(
      warnAt(
        positions,
        ['rails', i, 'headingCone'],
        `headingCone is ${deg.toFixed(1)} deg; above ${WIDE_CONE_DEG} deg a near-tangential launch ` +
          `can clip the host's own surface (docs/issues/2026-09-17-shallow-launch-can-self-collide.md)`,
      ),
    );
  });

  if (source.contacts.length === 0) return warnings;

  source.rails.forEach((rail, i) => {
    const hostIndex = bodyIndex.get(rail.host)!;
    let worst = 0;
    let worstContactId = '';
    for (const contact of source.contacts) {
      const separation =
        apoapsisBoundFromPrimary(bodyDefs, hostIndex) +
        apoapsisBoundFromPrimary(bodyDefs, bodyIndex.get(contact.host)!);
      if (separation > worst) {
        worst = separation;
        worstContactId = contact.id;
      }
    }
    const reach = rail.muzzleSpeed.max * TRANSFER_WINDOW_SECONDS;
    if (reach >= worst) return;
    warnings.push(
      warnAt(
        positions,
        ['rails', i, 'muzzleSpeed', 'max'],
        `muzzle speed ${(rail.muzzleSpeed.max / 1000).toFixed(1)} km/s over 40 d reaches ` +
          `${(reach / 1000).toFixed(0)} km, short of the ${(worst / 1000).toFixed(0)} km worst-case ` +
          `separation to "${worstContactId}" (sum of both bodies' apoapsis distance from the system ` +
          `primary -- a crude closed-form bound, not a real transfer)`,
      ),
    );
  });

  return warnings;
}

/** Bodies (parent-first, unique ids, orbit presence), rails and contacts (unique ids, known host)
 *  resolved to `BodyTable`/`RailTable`-ready indices. Collects every issue it can rather than
 *  stopping at the first -- `bodyIndex` stays valid throughout (it is keyed by id, not by
 *  position), but `bodyDefs`/`railDefs`/`contactDefs` are only complete, and only used, once
 *  `issues` is empty. */
function resolveIds(
  source: LevelSource,
  positions: Positions,
): {
  issues: Issue[];
  bodyDefs: BodyDef[];
  bodyIndex: Map<string, number>;
  railDefs: RailDef[];
  contactDefs: CompiledContact[];
} {
  const issues: Issue[] = [];

  const bodyIndex = new Map<string, number>();
  source.bodies.forEach((body, i) => {
    if (bodyIndex.has(body.id))
      issues.push(errorAt(positions, ['bodies', i, 'id'], `duplicate body id "${body.id}"`));
    else bodyIndex.set(body.id, i);
  });

  const bodyDefs: BodyDef[] = [];
  source.bodies.forEach((body, i) => {
    const mu = G * body.mass;
    if (i === 0) {
      if (body.orbit)
        issues.push(
          errorAt(
            positions,
            ['bodies', i, 'orbit'],
            'the first body is the system primary and must not have an orbit',
          ),
        );
      bodyDefs.push({
        parent: -1,
        mu,
        radius: body.radius,
        rotationPeriod: body.rotationPeriod,
        axialPhaseAtEpoch: body.axialPhaseAtEpoch,
      });
      return;
    }
    if (!body.orbit) {
      issues.push(
        errorAt(
          positions,
          ['bodies', i],
          `body "${body.id}" must have an orbit -- only the first body may be the primary`,
        ),
      );
      return;
    }
    const parentId = body.orbit.parent;
    if (!bodyIndex.has(parentId)) {
      issues.push(
        errorAt(positions, ['bodies', i, 'orbit', 'parent'], `unknown body id "${parentId}"`),
      );
      return;
    }
    const parentIndex = bodyIndex.get(parentId)!;
    if (parentIndex >= i) {
      issues.push(
        errorAt(
          positions,
          ['bodies', i, 'orbit', 'parent'],
          `bodies must be parent-first: "${body.id}" references parent "${parentId}", which appears later`,
        ),
      );
      return;
    }
    bodyDefs.push({
      parent: parentIndex,
      mu,
      radius: body.radius,
      a: body.orbit.a,
      e: body.orbit.e,
      argPeriapsis: body.orbit.argPeriapsis,
      meanAnomaly0: body.orbit.meanAnomalyAtEpoch,
      rotationPeriod: body.rotationPeriod,
      axialPhaseAtEpoch: body.axialPhaseAtEpoch,
    });
  });

  const railIndex = new Map<string, number>();
  source.rails.forEach((rail, i) => {
    if (railIndex.has(rail.id))
      issues.push(errorAt(positions, ['rails', i, 'id'], `duplicate rail id "${rail.id}"`));
    else railIndex.set(rail.id, i);
  });

  const railDefs: RailDef[] = [];
  source.rails.forEach((rail, i) => {
    if (!bodyIndex.has(rail.host)) {
      issues.push(errorAt(positions, ['rails', i, 'host'], `unknown body id "${rail.host}"`));
      return;
    }
    // The command log wants whole ticks (ADR-0006 §4); a small relative tolerance absorbs the
    // sub-ULP rounding a unit conversion can introduce (research A.5's "24.1 d" example) without
    // accepting a genuinely fractional reload time.
    const ratio = rail.reloadTime / source.dt;
    const reloadTicks = Math.round(ratio);
    if (Math.abs(ratio - reloadTicks) > 1e-6 * Math.max(1, ratio)) {
      issues.push(
        errorAt(
          positions,
          ['rails', i, 'reloadTime'],
          `reloadTime (${rail.reloadTime} s) must be a whole number of ticks at dt=${source.dt} s, got ${ratio} ticks`,
        ),
      );
      return;
    }
    railDefs.push({
      host: bodyIndex.get(rail.host)!,
      longitude: rail.longitude,
      muzzleSpeedMin: rail.muzzleSpeed.min,
      muzzleSpeedMax: rail.muzzleSpeed.max,
      headingCone: rail.headingCone,
      reloadTicks,
    });
  });

  if (source.probes.length !== 1)
    issues.push(
      errorAt(positions, ['probes'], 'one probe type until the simulation supports several'),
    );

  const contactIndex = new Map<string, number>();
  source.contacts.forEach((contact, i) => {
    if (contactIndex.has(contact.id))
      issues.push(
        errorAt(positions, ['contacts', i, 'id'], `duplicate contact id "${contact.id}"`),
      );
    else contactIndex.set(contact.id, i);
  });

  const contactDefs: CompiledContact[] = [];
  source.contacts.forEach((contact, i) => {
    if (!bodyIndex.has(contact.host)) {
      issues.push(errorAt(positions, ['contacts', i, 'host'], `unknown body id "${contact.host}"`));
      return;
    }
    contactDefs.push({
      host: bodyIndex.get(contact.host)!,
      longitude: contact.longitude,
      captureRadius: contact.captureRadius,
      minimumImpactEnergy: contact.clearedBy.minimumImpactEnergy,
    });
  });

  return { issues, bodyDefs, bodyIndex, railDefs, contactDefs };
}

function buildScenario({
  source,
  bodyDefs,
  railDefs,
  contactDefs,
}: {
  source: LevelSource;
  bodyDefs: BodyDef[];
  railDefs: RailDef[];
  contactDefs: CompiledContact[];
}): Scenario & { contacts: CompiledContact[] } {
  const probeSource = source.probes[0]!;
  return {
    dt: source.dt,
    capacity: probeSource.count,
    burnNodeCapacity: probeSource.count * probeSource.nodeBudget,
    bodies: bodyDefs,
    rails: railDefs,
    probe: {
      dryMass: probeSource.dryMass,
      propellantMass: probeSource.propellantMass,
      exhaustVelocity: probeSource.exhaustVelocity,
      thrust: probeSource.maxThrust,
    },
    streams: source.streams,
    contacts: contactDefs,
  };
}

function compileSemantics({
  source,
  filePath,
  positions,
}: {
  source: LevelSource;
  filePath: string;
  positions: Positions;
}): CompileLevelResult {
  const issues: Issue[] = [];

  const stem = basename(filePath).replace(/\.level\.ya?ml$/, '');
  if (source.id !== stem)
    issues.push(
      errorAt(
        positions,
        ['id'],
        `id "${source.id}" must match the filename ("${stem}.level.yaml")`,
      ),
    );

  const resolved = resolveIds(source, positions);
  issues.push(...resolved.issues);

  if (issues.length > 0) return { issues, warnings: [] };

  const scenario = buildScenario({ source, ...resolved });

  // Scenario does not have `contacts` yet (GRV-0015 lands it in a different worktree): strip it
  // before calling the real simulation, which is the simplest honest way to enforce "everything
  // createBodyTable/createRailTable/validateScenario would reject" for everything they do know
  // about.
  const { contacts: _contacts, ...scenarioForSim } = scenario;
  try {
    createSim({ scenario: scenarioForSim, seed: source.seed });
  } catch (err) {
    issues.push({
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
      path: '',
      ...positions.root(),
    });
  }

  if (issues.length > 0) return { issues, warnings: [] };

  const warnings = collectWarnings({
    source,
    bodyDefs: resolved.bodyDefs,
    bodyIndex: resolved.bodyIndex,
    positions,
  });

  const level: CompiledLevel = {
    schema: 1,
    id: source.id,
    name: source.name,
    brief: source.brief,
    debrief: source.debrief,
    seed: source.seed,
    names: {
      bodies: source.bodies.map((b) => b.name),
      rails: source.rails.map((r) => r.name),
      contacts: source.contacts.map((c) => c.name),
    },
    bodyIds: source.bodies.map((b) => b.id),
    railIds: source.rails.map((r) => r.id),
    contactIds: source.contacts.map((c) => c.id),
    bodyClasses: source.bodies.map((b) => b.class),
    scenario,
  };

  return { level, warnings };
}

/** YAML source -> `CompiledLevel` or a list of positioned issues, plus warnings in both cases
 *  (ADR-0006 §1, §6). Shared by the CLI (scripts/levels-build.ts) and the tests, so the build and
 *  the tests validate exactly the same thing. */
export function compileLevel({
  source,
  path: filePath,
}: {
  source: string;
  path: string;
}): CompileLevelResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, version: '1.2', schema: 'core' });
  const positions = createPositions(doc, lineCounter);

  const directiveIssue = checkYamlVersionDirective(doc, positions);
  const parseIssues = yamlErrorIssues(doc, positions);
  if (directiveIssue) parseIssues.push(directiveIssue);
  if (parseIssues.length > 0) return { issues: parseIssues, warnings: [] };

  let raw: unknown;
  try {
    // Duplicate keys are already caught above via doc.errors; this catches the other failure
    // research A.4 found `doc.errors` silent on: an alias with no matching anchor.
    raw = doc.toJS();
  } catch (err) {
    return {
      issues: [
        {
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
          path: '',
          ...positions.root(),
        },
      ],
      warnings: [],
    };
  }

  const result = v.safeParse(LevelSourceSchema, raw);
  if (!result.success) return { issues: schemaIssues(result.issues, positions), warnings: [] };

  return compileSemantics({ source: result.output, filePath, positions });
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

/** Sorted keys, arrays kept in order, `JSON.stringify`'s own shortest-round-trip number
 *  formatting, 2-space indent, trailing newline (ADR-0006 §1, research A.5): compiling the same
 *  source twice is byte-identical, and a unit-converted double round-trips through it exactly. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
