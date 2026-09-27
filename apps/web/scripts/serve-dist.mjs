#!/usr/bin/env node
// Minimal static server that mimics production: dist/ is mounted at /jastipkita/, the files in
// well-known/ at /.well-known/, and unknown paths get dist/404.html with status 404 (like GitHub Pages).
// Usage: node scripts/serve-dist.mjs [--port 4321]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const wellKnown = join(root, 'well-known');
const BASE = '/jastipkita';
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp', '.jpg': 'image/jpeg',
};

function send(res, file, status = 200) {
  const type = TYPES[extname(file)] ?? (file.endsWith('apple-app-site-association') ? 'application/json' : 'application/octet-stream');
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

function resolveFile(base, rel) {
  const p = normalize(join(base, rel));
  if (!p.startsWith(base)) return null;
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(p) && statSync(p).isDirectory() && existsSync(join(p, 'index.html'))) return join(p, 'index.html');
  return null;
}

const server = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(u.pathname);
  if (path === '/' || path === '') {
    res.writeHead(302, { location: `${BASE}/` });
    return res.end();
  }
  if (path.startsWith('/.well-known/')) {
    const f = resolveFile(wellKnown, path.slice('/.well-known/'.length));
    if (f) return send(res, f);
  }
  if (path === BASE) {
    res.writeHead(301, { location: `${BASE}/` });
    return res.end();
  }
  if (path.startsWith(`${BASE}/`)) {
    const rel = path.slice(BASE.length);
    // GitHub Pages redirects /dir → /dir/ when dir/index.html exists
    if (!rel.endsWith('/') && !extname(rel) && existsSync(join(dist, rel, 'index.html'))) {
      res.writeHead(301, { location: `${path}/${u.search}` });
      return res.end();
    }
    const f = resolveFile(dist, rel);
    if (f) return send(res, f);
  }
  const notFound = join(dist, '404.html');
  if (existsSync(notFound)) return send(res, notFound, 404);
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(port, () => {
  console.log(`JastipKita dist served at http://localhost:${port}${BASE}/`);
});
