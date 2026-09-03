import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parseFrontmatter } from './lib/frontmatter.ts';
import { createIssue, listIssues, resolveIssue, triageIssue, wontfixIssue } from './issues.ts';
import { validateDocs } from './validate-docs.ts';

test('issue lifecycle: new, list, triage, resolve keeps one file and valid frontmatter', () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'grv-docs-'));
  const dir = path.join(docs, 'issues');
  const file = createIssue({
    dir,
    slug: 'Kepler drift',
    title: 'Kepler solver drifts at high eccentricity',
    priority: 'P1',
    date: '2026-09-03',
  });
  expect(path.basename(file)).toBe('2026-09-03-kepler-drift.md');
  expect(() => createIssue({ dir, slug: 'x', title: 'x', priority: 'P9' })).toThrow(/priority/);

  const open = listIssues(dir, 'open');
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ priority: 'P1', status: 'open' });
  expect(validateDocs(docs)).toEqual([]);

  triageIssue(file, 'GRV-0004');
  expect(parseFrontmatter(fs.readFileSync(file, 'utf8'))!.data).toMatchObject({
    status: 'triaged',
    work: 'GRV-0004',
  });
  expect(() => triageIssue(file, 'CR-0004')).toThrow(/GRV-0004/);

  resolveIssue(file, { work: 'GRV-0004', commit: 'abc1234', note: 'fixed', date: '2026-09-04' });
  const doc = parseFrontmatter(fs.readFileSync(file, 'utf8'))!;
  expect(doc.data.status).toBe('resolved');
  expect(doc.body).toContain('**Resolved 2026-09-04** in GRV-0004, commit abc1234. fixed');
  expect(listIssues(dir, 'open')).toEqual([]);
  expect(validateDocs(docs)).toEqual([]);

  wontfixIssue(file, { note: 'not worth it', date: '2026-09-05' });
  expect(parseFrontmatter(fs.readFileSync(file, 'utf8'))!.data.status).toBe('wontfix');
});

test('lists by priority then filing date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grv-issues-'));
  createIssue({ dir, slug: 'b', title: 'b', priority: 'P2', date: '2026-01-02' });
  createIssue({ dir, slug: 'a', title: 'a', priority: 'P2', date: '2026-01-01' });
  createIssue({ dir, slug: 'c', title: 'c', priority: 'P0', date: '2026-01-03' });
  expect(listIssues(dir).map((r) => r.title)).toEqual(['c', 'a', 'b']);
});
