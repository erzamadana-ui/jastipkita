// Resolve third-party tooling without installing it inside the monorepo workspace.
// Priority: $BRAND_DEPS_DIR (e.g. /tmp/brandtools) → brand/scripts/node_modules → /tmp/brandtools.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.BRAND_DEPS_DIR,
  path.resolve(here, '..'),
  '/tmp/brandtools',
].filter(Boolean);

const base = candidates.find((dir) => existsSync(path.join(dir, 'node_modules'))) ?? path.resolve(here, '..');
export const depsDir = base;
export const requireDep = createRequire(path.join(base, 'package.json'));
export const resolveDep = (id) => requireDep.resolve(id);
