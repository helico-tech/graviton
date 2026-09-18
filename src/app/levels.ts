// Bundled compiled levels (GRV-0021): every levels/*.level.json is inlined into the app bundle at
// build time via Vite's import.meta.glob, so there is no runtime fetch and no level compiler in
// the shipped bundle. `CompiledLevel` is restated here rather than imported from
// src/levels/compile.ts: src/levels/bundle-isolation.test.ts forbids src/app from importing
// src/levels/{compile,schema,units} at all -- its check is a static regex over import specifiers,
// so even a type-only import trips it. This shape must stay structurally identical to
// compile.ts's own `CompiledLevel`, which src/app never otherwise touches (ADR-0002 layout).
import type { Scenario } from '../sim/sim.ts';

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
  scenario: Scenario;
}

const modules = import.meta.glob('../../levels/*.level.json', {
  eager: true,
  import: 'default',
}) as Record<string, CompiledLevel>;

const levels = new Map<string, CompiledLevel>();
for (const level of Object.values(modules)) levels.set(level.id, level);

export function levelIds(): string[] {
  return [...levels.keys()].sort();
}

export function getLevel(id: string): CompiledLevel | undefined {
  return levels.get(id);
}
