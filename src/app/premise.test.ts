// Static guard for the premise ADR-0007 §6/GAME-0001 §4.6 states plainly: nothing the player sees
// about a dynamic object or a contact comes from its true, live state -- only the observed view or
// the telemetry event log (GRV-0032, docs/issues/2026-09-18-true-state-leaks-into-selection-
// contact-glyph-and-timeline.md). `sim.objects`/`sim.contactState` are `Sim`'s own live, undelayed
// tables; walking `src/app/**`, `src/ui/**` and `src/render/**` for the telltale access patterns
// (`sim.objects`, `sim.contactState`, an aliased contactState field index `.contactState[`, and an
// aliased object-table field/count access `.objects.<word>[`/`.objects.count`) catches a caller
// reading either directly. Mirrors src/levels/bundle-isolation.test.ts's own regex-walk approach
// and its own honest caveat: this is a trip-wire, not a type-level proof -- it reads *source text*,
// so it skips comment lines (many already mention these identifiers in prose, describing exactly
// the boundary this test enforces) and it can only recognise the object-table access pattern
// (`.objects.<field>[` / `.objects.count`), not a bare `.objects` used as a plain array
// (`Frame.objects`, `StateSnapshot.objects`, `TickEventSample.objects` all read that way and would
// otherwise false-positive).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { repoRoot } from '../../scripts/lib/repo.ts';

const ROOTS = ['src/app', 'src/ui', 'src/render'];

/** Files whose *entire* job is reading the live `Sim`'s dynamic state -- exempted outright rather
 *  than line by line, each with its own reason a future reviewer can check against. */
const FULLY_EXEMPT = new Map<string, string>([
  [
    'src/app/observed.ts',
    "the post's own downlink replay -- the one place a dynamic object's live state is legitimately read, to build the observed view everything else must read instead (ADR-0007 §5-6).",
  ],
  [
    'src/app/predict.ts',
    'prediction replays run on a fresh, isolated Sim of their own (never the loaded session\'s live one) to forecast an upcoming, not-yet-true event -- the same category of read observed.ts makes, not a player-facing "what is true right now" read.',
  ],
  [
    'src/app/debug-api.ts',
    "the whole module's own boundary (its header doc): the one place outside src/render a live Sim is read at all; state()/stepSampled() build the debug-only StateSnapshot/TickEventSample, never shown to the player directly (app.ts's own timelineData/captureFrame calls are what this guard actually constrains).",
  ],
]);

/** Files that must otherwise stay fully guarded, but carry exactly one pre-existing, narrowly
 *  justified exception -- unlike `FULLY_EXEMPT`, a *different* offending line in one of these
 *  files (say, `frame.ts` reading `sim.objects.x` again) must still fail this test, so each entry
 *  names the precise sub-pattern it excuses rather than exempting the file wholesale. */
const PARTIALLY_EXEMPT = new Map<string, { pattern: RegExp; reason: string }>([
  [
    'src/render/frame.ts',
    {
      pattern: /\.objects\.count\b/,
      reason:
        "captureFrame's own object loop bound -- a structural size, not a field of a dynamic object's state (never delayed by ADR-0007 rule 12 in the first place); every actual object field it draws comes from the `observed` param instead, exactly this guard's own point.",
    },
  ],
  [
    'src/app/planner.ts',
    {
      pattern: /\.objects\.count\b/,
      reason:
        "commandHorizon() checks amendProbe against a freshly-replayed, ephemeral planning Sim's own object count (light-cone/command-horizon arithmetic, GRV-0031) -- not a state readout, pre-existing and out of GRV-0032's own file list.",
    },
  ],
]);

const OBJECT_TABLE_PATTERN = /\.objects\.(count\b|[a-zA-Z]\w*\[)/;
const CONTACT_STATE_INDEX_PATTERN = /\.contactState\[/;
const SIM_OBJECTS_PATTERN = /\bsim\.objects\b/;
const SIM_CONTACT_STATE_PATTERN = /\bsim\.contactState\b/;

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**');
}

function isOffendingLine(line: string): boolean {
  return (
    SIM_OBJECTS_PATTERN.test(line) ||
    SIM_CONTACT_STATE_PATTERN.test(line) ||
    CONTACT_STATE_INDEX_PATTERN.test(line) ||
    OBJECT_TABLE_PATTERN.test(line)
  );
}

/** Every offending (non-comment) line in `file`, `except` (a `PARTIALLY_EXEMPT` entry's own
 *  pattern) filtered out -- `null` to check every line, matching a `FULLY_EXEMPT` file's own
 *  self-check below (it has no narrower pattern to filter by). */
function offendingLines(file: string, except: RegExp | null = null): string[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const offenders: string[] = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (!isOffendingLine(line)) return;
    if (except && except.test(line)) return;
    offenders.push(`${index + 1}: ${line.trim()}`);
  });
  return offenders;
}

describe("src/app, src/ui and src/render never read a live Sim's true dynamic state directly", () => {
  test.each(ROOTS)('%s has no offending reader outside the allowlist', (root) => {
    const dir = path.join(repoRoot, root);
    const offenders = allSourceFiles(dir).flatMap((file) => {
      const relative = path.relative(repoRoot, file).split(path.sep).join('/');
      if (FULLY_EXEMPT.has(relative)) return [];
      const partial = PARTIALLY_EXEMPT.get(relative);
      return offendingLines(file, partial?.pattern ?? null).map((line) => `${relative} ${line}`);
    });
    expect(offenders).toEqual([]);
  });

  test('every exempt file still exists and still has at least one matching read (a stale entry would hide a real regression elsewhere)', () => {
    for (const relative of FULLY_EXEMPT.keys()) {
      const full = path.join(repoRoot, relative);
      expect(fs.existsSync(full), `${relative} no longer exists`).toBe(true);
      expect(
        offendingLines(full).length,
        `${relative} no longer reads the live Sim`,
      ).toBeGreaterThan(0);
    }
    for (const [relative, { pattern }] of PARTIALLY_EXEMPT) {
      const full = path.join(repoRoot, relative);
      expect(fs.existsSync(full), `${relative} no longer exists`).toBe(true);
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      const stillMatches = lines.some((line) => !isCommentLine(line) && pattern.test(line));
      expect(stillMatches, `${relative} no longer has its own excused read`).toBe(true);
    }
  });

  // Proves the guard actually guards: a file with none of the four patterns reports nothing, and
  // the exact violations GRV-0032 closed (selection.ts's old sim.contactState/sim.objects reads,
  // frame.ts's old sim.contactState.cleared read) are patterns this test would have caught.
  test('sanity: the four patterns actually match the shapes GRV-0032 removed', () => {
    expect(isOffendingLine('  const state = sim.contactState;')).toBe(true);
    expect(isOffendingLine('  const o = sim.objects;')).toBe(true);
    expect(isOffendingLine('cleared: sim.contactState.cleared[i] !== 0')).toBe(true);
    // An alias's own field access, on a line by itself, evades these patterns (documented above as
    // this guard's own limitation) -- but the alias's declaration line (`const cs = sim.contactState;`)
    // still matches, which is what every real instance in this codebase's history actually did.
    expect(isOffendingLine('  cs.cleared[i]')).toBe(false);
    expect(isOffendingLine('const cs = sim.contactState;')).toBe(true);
    expect(isOffendingLine('frame.objects.forEach((object) => {')).toBe(false); // a plain array
    expect(isOffendingLine('snap.objects.length')).toBe(false); // a plain array
  });
});
