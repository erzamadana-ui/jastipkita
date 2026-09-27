// Static CSP verification of a built HTML page (SEC-14). Shared by scripts/postbuild.mjs (build gate) and
// tests/smoke.spec.ts. Returns a list of problems; empty = the page is safe under its own CSP meta.
import { createHash } from 'node:crypto';

const NON_EXECUTABLE = /^(application\/(ld\+)?json|text\/template)$/i;

/** Returns human-readable CSP violations found statically in a built page (empty = OK). */
export function cspProblems(html) {
  const out = [];
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  if (!meta) return ['missing <meta http-equiv="Content-Security-Policy">'];
  const policy = meta[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const firstAsset = html.search(/<script|<link rel="stylesheet"|<style/);
  if (firstAsset !== -1 && meta.index > firstAsset) out.push('CSP meta must come before the first script/stylesheet');
  if (!/<meta name="referrer" content="strict-origin-when-cross-origin"/.test(html)) out.push('missing referrer meta');
  const scriptSrc = (/(?:^|;\s*)script-src ([^;]+)/.exec(policy)?.[1] ?? '').split(/\s+/);
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "style-src 'self'"]) {
    if (!policy.includes(d)) out.push(`policy lacks ${d}`);
  }
  if (/'unsafe-inline'|'unsafe-eval'/.test(policy)) out.push('policy must not allow unsafe-inline/unsafe-eval');
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? '';
    if (/\ssrc=/.test(attrs)) continue;
    const type = /\stype="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (type && NON_EXECUTABLE.test(type)) continue;
    const hash = `'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`;
    if (!scriptSrc.includes(hash)) out.push(`inline <script${attrs}> without matching hash ${hash}`);
  }
  if (/<style[\s>]/.test(html)) out.push('inline <style> element (style-src has no hashes)');
  if (/\sstyle="/.test(html)) out.push('inline style="" attribute');
  if (/<[a-z][^>]*\son[a-z]+="/i.test(html)) out.push('inline event handler attribute');
  return out;
}
