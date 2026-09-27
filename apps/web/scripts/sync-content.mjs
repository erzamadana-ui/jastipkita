#!/usr/bin/env node
// Pre-build sync for @jastipkita/web.
//
// 1. Parses db/seeds/0101_restricted_items.sql into src/data/restricted-items.generated.json — the static
//    fallback list used by /cek-barang-terlarang/ when the API is unreachable.
// 2. Verifies docs/legal/*.md exist (they are read at build time by the Astro glob loader in
//    src/content.config.ts with base "../../docs/legal", relative to apps/web).
//
// The generated JSON is committed, so a checkout without the db/ folder still builds (the script then
// keeps the committed file and prints a warning). Never fails the build on a missing optional source.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const repoRoot = resolve(webRoot, '../..');
const seedPath = resolve(repoRoot, 'db/seeds/0101_restricted_items.sql');
const outPath = resolve(webRoot, 'src/data/restricted-items.generated.json');
const legalDir = resolve(repoRoot, 'docs/legal');

/** Minimal tokenizer for the seed's single INSERT … VALUES (…),(…); statement. */
function parseValues(sql) {
  const start = sql.indexOf('VALUES');
  if (start < 0) throw new Error('VALUES clause not found');
  const end = sql.indexOf('ON CONFLICT', start);
  const body = sql.slice(start + 6, end < 0 ? undefined : end);
  const rows = [];
  let depth = 0;
  let row = null;
  let tok = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === "'" && body[i + 1] === "'") { tok += "'"; i++; continue; }
      if (c === "'") { quoted = false; continue; }
      tok += c;
      continue;
    }
    if (c === '-' && body[i + 1] === '-') { const nl = body.indexOf('\n', i); i = nl < 0 ? body.length : nl; continue; }
    if (c === "'") { quoted = true; wasQuoted = true; continue; }
    if (c === '(' && depth === 0) { depth = 1; row = []; tok = ''; wasQuoted = false; continue; }
    if (c === ')' && depth === 1) { row.push(finish(tok, wasQuoted)); rows.push(row); row = null; depth = 0; tok = ''; continue; }
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === ',' && depth === 1) { row.push(finish(tok, wasQuoted)); tok = ''; wasQuoted = false; continue; }
    if (c === ';' && depth === 0) break;
    if (depth >= 1) tok += c === '\u0000' ? '' : c;
  }
  return rows;
}

function finish(raw, wasQuoted) {
  const t = raw.trim();
  if (!wasQuoted && t === 'NULL') return null;
  if (!wasQuoted && (t === 'true' || t === 'false')) return t === 'true';
  if (t.startsWith('ARRAY[')) {
    // keywords were quoted inside ARRAY[...]; the tokenizer stripped the quotes, leaving a,b,c
    const inner = t.slice(6, t.lastIndexOf(']'));
    return inner.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (t === '{}::text[]' || t === '{}') return [];
  if (/^DATE\s/.test(t)) return t.replace(/^DATE\s+/, '');
  if (!wasQuoted && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t.replace(/::text\[\]$/, '');
}

function syncRestricted() {
  if (!existsSync(seedPath)) {
    console.warn(`[sync] ${seedPath} not found — keeping committed ${outPath}`);
    return;
  }
  const sql = readFileSync(seedPath, 'utf8');
  const rows = parseValues(sql);
  const cols = [
    'code', 'version', 'originCountry', 'destinationCountry', 'categoryCode', 'hsCodePrefix', 'keywords',
    'classification', 'maxQuantity', 'maxValueUsd', 'permitAuthority', 'airlineDg', 'messageId', 'messageEn',
    'sourceReference', 'sourceUrl', 'effectiveFrom', 'effectiveUntil', 'lastVerifiedAt', 'status',
  ];
  const rules = rows.map((r) => {
    if (r.length !== cols.length) throw new Error(`Unexpected column count ${r.length} in row ${r[0]}`);
    const o = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
    if (!Array.isArray(o.keywords)) o.keywords = [];
    return o;
  });
  const payload = {
    _source: 'db/seeds/0101_restricted_items.sql',
    _generatedBy: 'apps/web/scripts/sync-content.mjs',
    _note: 'Static fallback for the public restricted-items checker. The API (POST /v1/restricted/check) is authoritative.',
    lastVerifiedAt: rules.reduce((m, r) => (r.lastVerifiedAt > m ? r.lastVerifiedAt : m), ''),
    rules,
  };
  const next = `${JSON.stringify(payload, null, 1)}\n`;
  const prev = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  if (prev !== next) writeFileSync(outPath, next);
  console.log(`[sync] restricted items: ${rules.length} rules (${rules.filter((r) => r.status === 'ACTIVE').length} ACTIVE)`);
}

function checkLegal() {
  if (!existsSync(legalDir)) {
    console.warn(`[sync] ${legalDir} missing — legal pages will be empty`);
    return;
  }
  const files = readdirSync(legalDir).filter((f) => f.endsWith('.md'));
  console.log(`[sync] legal docs: ${files.length} markdown files in docs/legal`);
}

syncRestricted();
checkLegal();
