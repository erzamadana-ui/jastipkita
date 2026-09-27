#!/usr/bin/env node
// Bundles the Node entry points of @jastipkita/api into self-contained ESM files for the container image
// (apps/api/Dockerfile). No new dependency: esbuild is resolved through tsx, which already depends on it.
//
//   node infra/docker/bundle-api.mjs [outDir]      # default: apps/api/dist-node
//
// Output: server.mjs (HTTP + in-process worker loop) and worker.mjs (standalone job worker).
// Everything (hono, postgres, zod, jose, aws4fetch, @jastipkita/core) is bundled; the runtime image needs no node_modules.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = join(ROOT, 'apps', 'api');
const outDir = resolve(process.argv[2] ?? join(API, 'dist-node'));

const requireFromApi = createRequire(join(API, 'package.json'));
const requireFromTsx = createRequire(requireFromApi.resolve('tsx/package.json'));
const esbuild = await import(requireFromTsx.resolve('esbuild'));

const result = await esbuild.build({
  absWorkingDir: API,
  entryPoints: { server: 'src/server.node.ts', worker: 'src/worker.node.ts' },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'info',
  metafile: true,
  // Some dependencies are CommonJS; give them a working `require` inside the ESM bundle.
  banner: { js: "import { createRequire as __jkCreateRequire } from 'node:module'; const require = __jkCreateRequire(import.meta.url);" },
});

const bytes = Object.entries(result.metafile.outputs)
  .filter(([f]) => f.endsWith('.mjs'))
  .map(([f, o]) => `${f.split('/').pop()} ${(o.bytes / 1024).toFixed(0)} KiB`);
console.log(`bundled → ${outDir}: ${bytes.join(', ')}`);
