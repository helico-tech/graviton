import { expect, test } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.ts';

test('parses keys, strips inline comments, keeps the body', () => {
  const doc = parseFrontmatter(
    '---\nstatus: open   # comment\npriority: P1\n---\n# Title\n\nbody\n',
  );
  expect(doc).toEqual({ data: { status: 'open', priority: 'P1' }, body: '# Title\n\nbody\n' });
});

test('rejects text without frontmatter or with a broken line', () => {
  expect(parseFrontmatter('# no frontmatter')).toBeNull();
  expect(parseFrontmatter('---\nnot a pair\n---\n')).toBeNull();
});

test('round-trips', () => {
  const text = '---\na: 1\nb: two\n---\nbody\n';
  expect(serializeFrontmatter(parseFrontmatter(text)!)).toBe(text);
});
