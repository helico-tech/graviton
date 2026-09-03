import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { repoRoot } from './lib/repo.ts';
import { validateDocs } from './validate-docs.ts';

function docsTree(files: Record<string, string>): string {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'grv-validate-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(docs, rel)), { recursive: true });
    fs.writeFileSync(path.join(docs, rel), text);
  }
  return docs;
}

test('the repository docs validate', () => {
  expect(validateDocs(path.join(repoRoot, 'docs'))).toEqual([]);
});

test('reports layout drift, malformed frontmatter and evidence without a unit', () => {
  const docs = docsTree({
    'plans/x.md': '',
    'notes.md': '',
    'issues/2026-09-03-a.md': '---\nstatus: weird\npriority: P1\nfiled: 2026-09-03\n---\n# a\n',
    'issues/2026-09-03-b.md': '---\nstatus: triaged\npriority: P5\nfiled: 2026-09-03\n---\n# b\n',
    'issues/no-date.md': '---\nstatus: open\npriority: P1\nfiled: 2026-09-03\n---\n# c\n',
    'work/GRV-0001-x.md': '---\nid: GRV-0002\nstatus: maybe\n---\n# x\n',
    'work/EPIC-01-y.md': '---\nid: EPIC-01\nstatus: todo\n---\n# y\n',
    'adr/0001-no-date.md': '# adr\n',
    'specs/2026-09-03-ok.md': '# spec\n',
    'research/2026-09-03-stack.md': '# needs sequence\n',
    'evidence/GRV-0001/README.md': '# ok\n',
    'evidence/GRV-0009/shot.png': 'x',
    'evidence/stray.txt': 'x',
  });
  const errors = validateDocs(docs);
  expect(errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining('docs/plans: not in the declared layout'),
      expect.stringContaining('docs/notes.md: only README.md'),
      expect.stringContaining('issues/2026-09-03-a.md: status must be'),
      expect.stringContaining('issues/2026-09-03-b.md: priority must be'),
      expect.stringContaining('issues/2026-09-03-b.md: triaged issues need a work: link'),
      expect.stringContaining('issues/no-date.md: filename must start with'),
      expect.stringContaining('work/GRV-0001-x.md: id: GRV-0002 does not match'),
      expect.stringContaining('work/GRV-0001-x.md: status must be'),
      expect.stringContaining('work/GRV-0001-x.md: stories need epic'),
      expect.stringContaining('adr/0001-no-date.md: filename must start with'),
      expect.stringContaining('research/2026-09-03-stack.md: needs a 2-digit sequence'),
      expect.stringContaining('evidence/GRV-0009: no matching docs/work/GRV-0009-*.md'),
      expect.stringContaining('evidence/GRV-0009: missing README.md'),
      expect.stringContaining('evidence/stray.txt: only README.md'),
    ]),
  );
  expect(
    errors.filter(
      (e) => e.includes('EPIC-01-y') || e.includes('specs/') || e.includes('GRV-0001/'),
    ),
  ).toEqual([]);
});
