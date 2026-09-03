import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createWorkItem, nextWorkItemId } from './new-work-item.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grv-work-'));
}

test('allocates the next zero-padded id from existing files', () => {
  const dir = tmp();
  expect(nextWorkItemId(dir)).toBe('GRV-0001');
  fs.writeFileSync(path.join(dir, 'GRV-0007-x.md'), '');
  fs.writeFileSync(path.join(dir, 'EPIC-01-y.md'), '');
  expect(nextWorkItemId(dir)).toBe('GRV-0008');
});

test('creates a story with valid frontmatter and slugified name', () => {
  const dir = tmp();
  const file = createWorkItem({ dir, epic: 'EPIC-02', slug: 'Hello World!', title: 'Hello' });
  expect(path.basename(file)).toBe('GRV-0001-hello-world.md');
  const text = fs.readFileSync(file, 'utf8');
  expect(
    text.startsWith('---\nid: GRV-0001\nepic: EPIC-02\nstatus: todo\n---\n# GRV-0001 Hello'),
  ).toBe(true);
  expect(() => createWorkItem({ dir, epic: 'nope', slug: 'x', title: 'x' })).toThrow(/epic/);
});
