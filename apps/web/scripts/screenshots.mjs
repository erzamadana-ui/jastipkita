#!/usr/bin/env node
// Screenshots of key pages (desktop & mobile, light & dark) into apps/web/screenshots/.
// Requires a built dist/. Uses the preinstalled Playwright Chromium (PLAYWRIGHT_BROWSERS_PATH).
// Usage: node scripts/screenshots.mjs [--pages landing,jastip-jepang] [--full]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'screenshots');
mkdirSync(out, { recursive: true });
const PORT = 4399;
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const full = !process.argv.includes('--viewport-only');

const ALL = {
  landing: '/jastipkita/',
  'jastip-jepang': '/jastipkita/jastip-jepang/',
  kalkulator: '/jastipkita/kalkulator-bea-cukai/',
};
const wanted = (arg('--pages') ?? Object.keys(ALL).join(',')).split(',');
const extra = arg('--paths'); // e.g. "/jastipkita/trip/,/jastipkita/akun/"

const server = spawn(process.execPath, [join(root, 'scripts/serve-dist.mjs'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch();
try {
  const targets = wanted.filter((k) => ALL[k]).map((k) => [k, ALL[k]]);
  if (extra) for (const p of extra.split(',')) targets.push([p.replace(/^\/jastipkita\/?/, '').replace(/\/$/, '').replace(/\//g, '-') || 'root', p]);
  for (const [name, path] of targets) {
    for (const [vpName, viewport] of [['desktop', { width: 1366, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: vpName === 'mobile' ? 2 : 1, reducedMotion: 'reduce' });
        await ctx.addInitScript(() => { try { localStorage.setItem('jk-consent', 'necessary'); } catch {} });
        const page = await ctx.newPage();
        // The production API is not deployed yet: fail fast so pages show their offline/"segera hadir" states.
        await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort('internetdisconnected'));
        await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle' });
        if (name === 'kalkulator') {
          await page.click('#calc-submit');
          await page.waitForSelector('.res-total');
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        const file = join(out, `${name}-${vpName}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: full });
        console.log('saved', file);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}
