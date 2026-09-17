// Serves a built dist/ over HTTP for scripts/screenshot.ts (ADR-0004 §3, §5,
// docs/work/GRV-0012): Playwright refuses `file:` URLs, and an ephemeral
// in-process server needs no lifecycle beyond the browser session that uses
// it, unlike `vite preview`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Resolves a request path under `root`, rejecting anything that would
 *  escape it (`..`, an encoded `..`, a request path that starts with `//`
 *  and so is absolute rather than root-relative) -- returns null instead of
 *  a path outside `root` rather than ever serving one. */
export function resolveStaticPath(root: string, requestPath: string): string | null {
  const withoutQuery = requestPath.split('?')[0] ?? '/';
  if (withoutQuery.startsWith('//')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

/** Binds an ephemeral port on the loopback interface and serves `root`. */
export function serveStatic(root: string): Promise<StaticServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const filePath = resolveStaticPath(root, req.url ?? '/');
      if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      const contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('static server: no port was assigned'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
