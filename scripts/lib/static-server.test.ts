import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { resolveStaticPath, serveStatic } from './static-server.ts';

test('resolves the root request to index.html', () => {
  expect(resolveStaticPath('/dist', '/')).toBe(path.join('/dist', 'index.html'));
});

test('resolves a nested asset', () => {
  expect(resolveStaticPath('/dist', '/assets/index-abc123.js')).toBe(
    path.join('/dist', 'assets/index-abc123.js'),
  );
});

test('strips a query string', () => {
  expect(resolveStaticPath('/dist', '/assets/app.js?v=2')).toBe(
    path.join('/dist', 'assets/app.js'),
  );
});

test('rejects a literal .. traversal outside root', () => {
  expect(resolveStaticPath('/dist', '/../secret.txt')).toBeNull();
  expect(resolveStaticPath('/dist', '/assets/../../secret.txt')).toBeNull();
});

test('rejects an encoded traversal', () => {
  expect(resolveStaticPath('/dist', '/%2e%2e/secret.txt')).toBeNull();
});

test('rejects an absolute path escape disguised as a request path', () => {
  expect(resolveStaticPath('/dist', '//etc/passwd')).toBeNull();
});

test('serves an existing file and 404s a missing one over real HTTP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grv-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<p>hi</p>');
  const server = await serveStatic(root);
  try {
    const ok = await fetch(server.url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<p>hi</p>');

    const missing = await fetch(`${server.url}nope.html`);
    expect(missing.status).toBe(404);
  } finally {
    await server.close();
  }
});
