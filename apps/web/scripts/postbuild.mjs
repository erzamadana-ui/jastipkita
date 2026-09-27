#!/usr/bin/env node
// Post-build fixes on dist/:
// 1. Legal docs cross-link each other as "privacy-policy.md" (so links also work when browsing docs/legal on
//    GitHub). Rewrite those hrefs to the site's /jastipkita/legal/<slug>/ URLs.
// 2. Sanity check: every HTML file must reference the /jastipkita base (fails the build otherwise).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const BASE = '/jastipkita';
let rewritten = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.html')) {
      let html = readFileSync(p, 'utf8');
      const before = html;
      html = html.replace(/href="([a-z0-9-]+)\.md(#[^"]*)?"/g, (_m, slug, hash = '') => `href="${BASE}/legal/${slug}/${hash}"`);
      if (html !== before) { writeFileSync(p, html); rewritten++; }
      if (!html.includes(`${BASE}/`)) throw new Error(`${p} has no ${BASE}/ reference — base path misconfigured?`);
    }
  }
}
walk(dist);
console.log(`[postbuild] legal .md links rewritten in ${rewritten} file(s)`);
