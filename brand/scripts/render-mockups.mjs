#!/usr/bin/env node
// Render the high-fidelity mockups in docs/design/mockups/src/*.html → PNG (390×844 @2x),
// light + dark, plus an overview contact sheet.
//
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BRAND_DEPS_DIR=/tmp/brandtools \
//     node brand/scripts/render-mockups.mjs [screen-name …]
//
// Requires packages/design-tokens/dist/tokens.css (run `node packages/design-tokens/scripts/build.mjs`)
// and apps/web/public/fonts (run brand/scripts/generate-assets.mjs).
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDep, resolveDep } from './lib/deps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const SRC = path.join(ROOT, 'docs', 'design', 'mockups', 'src');
const OUT = path.join(ROOT, 'docs', 'design', 'mockups');
const ICONS = path.dirname(resolveDep('lucide-static/icons/house.svg'));
const only = process.argv.slice(2);

function icon(name) {
  const raw = readFileSync(path.join(ICONS, `${name}.svg`), 'utf8');
  return raw.replace(/<!--.*?-->/s, '').replace(/\s*\n\s*/g, ' ').trim();
}

function prepare(html, theme) {
  const withIcons = html.replace(/<i data-i="([a-z0-9-]+)"(?: class="([^"]*)")?><\/i>/g, (_, n, cls = '') => `<i class="${cls}" aria-hidden="true">${icon(n)}</i>`);
  return withIcons
    .replace('<html lang="id">', `<html lang="id" data-theme="${theme}">`)
    .replace('<head>', `<head><base href="${pathToFileURL(SRC).href}/">`);
}

async function main() {
  const { chromium } = requireDep('playwright');
  const sharp = requireDep('sharp');
  const screens = readdirSync(SRC)
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.replace(/\.html$/, ''))
    .filter((n) => !only.length || only.includes(n))
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const browser = await chromium.launch();
  const shots = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    for (const name of screens) {
      const html = readFileSync(path.join(SRC, `${name}.html`), 'utf8');
      for (const theme of ['light', 'dark']) {
        const tmp = path.join(os.tmpdir(), `jk-mock-${name}-${theme}.html`);
        writeFileSync(tmp, prepare(html, theme));
        await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await bakeGlass(page, sharp);
        const file = path.join(OUT, `${name}-${theme}.png`);
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 390, height: 844 } });
        shots.push({ name, theme, file });
        console.log('  rendered', path.relative(ROOT, file));
      }
    }
  } finally {
    await browser.close();
  }
  if (!only.length) {
    // Overview: light row above dark row, each screen scaled to 360 px wide.
    const w = 360;
    const h = Math.round((844 / 390) * w);
    const gap = 28;
    const cols = screens.length;
    const W = cols * w + (cols + 1) * gap;
    const H = 2 * h + 3 * gap;
    const comps = [];
    for (const s of shots) {
      const col = screens.indexOf(s.name);
      const row = s.theme === 'light' ? 0 : 1;
      const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="36" fill="#fff"/></svg>`);
      const buf = await sharp(s.file).resize(w, h).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
      comps.push({ input: buf, left: gap + col * (w + gap), top: gap + row * (h + gap) });
    }
    const f = path.join(OUT, 'mockups-overview.png');
    await sharp({ create: { width: W, height: H, channels: 4, background: '#DDE3EC' } }).composite(comps).png().toFile(f);
    console.log('  rendered', path.relative(ROOT, f));
  }
}

/**
 * Headless Chromium drops `backdrop-filter` in some layer configurations, so the glass layer is
 * baked deterministically: screenshot the page without the glass elements, blur + saturate the
 * area beneath each one with sharp (same σ / saturation as the tokens), and paint it as the
 * element's background under the translucent glass tint.
 */
async function bakeGlass(page, sharp) {
  const SEL = '.tabbar, .glass';
  const rects = await page.$$eval(SEL, (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(document.documentElement);
      return { x: r.x, y: r.y, w: r.width, h: r.height, blur: parseFloat(cs.getPropertyValue('--jk-glass-blur')) || 20, sat: parseFloat(cs.getPropertyValue('--jk-glass-saturation')) || 1.8 };
    }),
  );
  if (!rects.length) return;
  const dsf = await page.evaluate(() => window.devicePixelRatio);
  await page.evaluate((sel) => {
    const s = document.createElement('style');
    s.id = '__noglass';
    s.textContent = `${sel} { visibility: hidden !important; }`;
    document.head.appendChild(s);
  }, SEL);
  const base = await page.screenshot({ clip: { x: 0, y: 0, width: 390, height: 844 } });
  await page.evaluate(() => document.getElementById('__noglass').remove());
  const meta = await sharp(base).metadata();
  const datas = [];
  for (const r of rects) {
    const pad = Math.ceil(r.blur * 2);
    const left = Math.max(0, Math.floor((r.x - pad) * dsf));
    const top = Math.max(0, Math.floor((r.y - pad) * dsf));
    const width = Math.min(meta.width - left, Math.ceil((r.w + 2 * pad) * dsf));
    const height = Math.min(meta.height - top, Math.ceil((r.h + 2 * pad) * dsf));
    const buf = await sharp(base).extract({ left, top, width, height }).blur(r.blur * dsf * 0.5).modulate({ saturation: r.sat }).png().toBuffer();
    datas.push({ url: `data:image/png;base64,${buf.toString('base64')}`, ox: left / dsf - r.x, oy: top / dsf - r.y, w: width / dsf, h: height / dsf });
  }
  await page.evaluate(
    ({ sel, datas }) => {
      document.querySelectorAll(sel).forEach((el, i) => {
        const d = datas[i];
        el.style.backdropFilter = 'none';
        el.style.webkitBackdropFilter = 'none';
        el.style.backgroundImage = `linear-gradient(var(--jk-color-surface-glass), var(--jk-color-surface-glass)), url(${d.url})`;
        el.style.backgroundSize = `100% 100%, ${d.w}px ${d.h}px`;
        el.style.backgroundPosition = `0 0, ${d.ox}px ${d.oy}px`;
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundOrigin = 'border-box';
      });
    },
    { sel: SEL, datas },
  );
}

const ORDER = ['buyer-home', 'checkout-breakdown', 'traveler-do-not-purchase', 'payment-secured'];

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
