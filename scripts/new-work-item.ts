// Allocates the next GRV-NNNN id and writes a story file. Usage:
//   node scripts/new-work-item.ts EPIC-03 my-slug --title "Human title"
import fs from 'node:fs';
import path from 'node:path';
import { parseFlags, repoRoot, slugify } from './lib/repo.ts';

export const WORK_DIR = path.join(repoRoot, 'docs', 'work');
export const WORK_ID = /^GRV-\d{4}$/;
export const EPIC_ID = /^EPIC-\d{2}$/;

export function nextWorkItemId(dir: string): string {
  let max = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /^GRV-(\d{4})-/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `GRV-${String(max + 1).padStart(4, '0')}`;
}

export function workItemTemplate({
  id,
  epic,
  title,
}: {
  id: string;
  epic: string;
  title: string;
}): string {
  return `---
id: ${id}
epic: ${epic}
status: todo
---
# ${id} ${title}

**Goal.**

**Files.**

**Acceptance.**
-

**Verification.**
`;
}

export function createWorkItem({
  dir,
  epic,
  slug,
  title,
}: {
  dir: string;
  epic: string;
  slug: string;
  title: string;
}): string {
  if (!EPIC_ID.test(epic)) throw new Error(`epic must look like EPIC-01, got ${epic}`);
  const id = nextWorkItemId(dir);
  const file = path.join(dir, `${id}-${slugify(slug)}.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, workItemTemplate({ id, epic, title }));
  return file;
}

if (import.meta.main) {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const [epic, slug] = positional;
  if (!epic || !slug) {
    console.error('usage: node scripts/new-work-item.ts <EPIC-NN> <slug> [--title "..."]');
    process.exit(2);
  }
  const file = createWorkItem({ dir: WORK_DIR, epic, slug, title: flags.title ?? slug });
  console.log(path.relative(repoRoot, file));
}
