#!/usr/bin/env node
// JastipKita brand asset generator.
//
//   BRAND_DEPS_DIR=/tmp/brandtools node brand/scripts/generate-assets.mjs            # everything
//   BRAND_DEPS_DIR=/tmp/brandtools node brand/scripts/generate-assets.mjs --no-preview
//
// Produces: brand/logo/*.svg, brand/app-icon/**, brand/web/**, brand/splash/**, brand/social/**,
// brand/store/**, brand/fonts/OFL.txt, app font files, and (unless --no-preview) the contact sheet
// brand/preview/brand-sheet.png (needs Playwright + Chromium).
// All geometry is deterministic: re-running produces identical files.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './lib/lockups.mjs';
import { png, pngBuffer, iconSvg, icoFromPngs, writeText, ensureDir } from './lib/raster.mjs';
import { resolveDep } from './lib/deps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const B = (...p) => path.join(ROOT, 'brand', ...p);
const args = new Set(process.argv.slice(2));
const inventory = []; // [file, purpose]
const log = (file, purpose) => inventory.push([path.relative(ROOT, file), purpose]);

// -------------------------------------------------------------------------------------------
// 1. Logo SVGs
// -------------------------------------------------------------------------------------------
function logos() {
  const variants = ['light', 'dark', 'mono-black', 'mono-white'];
  const suffix = { light: '', dark: '-dark', 'mono-black': '-mono-black', 'mono-white': '-mono-white' };
  const purpose = {
    light: 'full colour, light backgrounds',
    dark: 'full colour, dark/navy backgrounds',
    'mono-black': 'one colour black (print, fax, emboss)',
    'mono-white': 'one colour white (photos, dark single-colour)',
  };
  for (const v of variants) {
    const c = L.COLORWAYS[v];
    const h = B('logo', `jastipkita-horizontal${suffix[v]}.svg`);
    writeText(h, L.horizontal(c).svg);
    log(h, `Horizontal lockup — ${purpose[v]}`);
    const vt = B('logo', `jastipkita-vertical${suffix[v]}.svg`);
    writeText(vt, L.vertical(c).svg);
    log(vt, `Vertical lockup — ${purpose[v]}`);
    const vtt = B('logo', `jastipkita-vertical-tagline${suffix[v]}.svg`);
    writeText(vtt, L.vertical(c, { tagline: true }).svg);
    log(vtt, `Vertical lockup + tagline — ${purpose[v]}`);
    const sy = B('logo', `jastipkita-symbol${suffix[v]}.svg`);
    writeText(sy, L.symbolSquare(c, { fill: 0.92 }).svg);
    log(sy, `Symbol only (square artboard) — ${purpose[v]}`);
  }
  const fav = B('logo', 'jastipkita-symbol-favicon.svg');
  writeText(fav, L.symbolSquare(L.COLORWAYS.light, { favicon: true, fill: 0.98 }).svg);
  log(fav, 'Simplified symbol for ≤ 32 px (no plane, bolder strokes) — light backgrounds');
  const favDark = B('logo', 'jastipkita-symbol-favicon-dark.svg');
  writeText(favDark, L.symbolSquare(L.COLORWAYS.dark, { favicon: true, fill: 0.98 }).svg);
  log(favDark, 'Simplified symbol for ≤ 32 px — dark backgrounds');
  const wm = B('logo', 'jastipkita-wordmark.svg');
  writeText(wm, L.wordmarkOnly(L.COLORWAYS.light).svg);
  log(wm, 'Wordmark only (space-constrained headers, footers)');
  const wmd = B('logo', 'jastipkita-wordmark-dark.svg');
  writeText(wmd, L.wordmarkOnly(L.COLORWAYS.dark).svg);
  log(wmd, 'Wordmark only — dark backgrounds');
}

// -------------------------------------------------------------------------------------------
// 2. App icons
// -------------------------------------------------------------------------------------------
const APP_ICON = { mark: { width: 0.74 } }; // iOS/marketing tile
const SMALL = 48; // below this pixel size the simplified geometry is used

async function iosIcons() {
  const dir = B('app-icon', 'ios', 'AppIcon.appiconset');
  // Flutter's default AppIcon.appiconset (legacy sizes) + 1024 marketing.
  const spec = [
    ['iphone', '20x20', '2x'], ['iphone', '20x20', '3x'],
    ['iphone', '29x29', '1x'], ['iphone', '29x29', '2x'], ['iphone', '29x29', '3x'],
    ['iphone', '40x40', '2x'], ['iphone', '40x40', '3x'],
    ['iphone', '60x60', '2x'], ['iphone', '60x60', '3x'],
    ['ipad', '20x20', '1x'], ['ipad', '20x20', '2x'],
    ['ipad', '29x29', '1x'], ['ipad', '29x29', '2x'],
    ['ipad', '40x40', '1x'], ['ipad', '40x40', '2x'],
    ['ipad', '76x76', '1x'], ['ipad', '76x76', '2x'],
    ['ipad', '83.5x83.5', '2x'],
    ['ios-marketing', '1024x1024', '1x'],
  ];
  const images = [];
  const rendered = new Set();
  for (const [idiom, sz, scale] of spec) {
    const pt = parseFloat(sz);
    const px = Math.round(pt * parseInt(scale, 10));
    const filename = `Icon-App-${sz}@${scale}.png`;
    images.push({ size: sz, idiom, filename, scale });
    if (rendered.has(filename)) continue;
    rendered.add(filename);
    const f = path.join(dir, filename);
    await png(iconSvg(px, { ...APP_ICON, favicon: px < SMALL }), f, { opaque: true, background: L.BRAND.navy900 });
    log(f, `iOS app icon ${px}×${px} px (${idiom} ${sz}pt @${scale}), opaque`);
  }
  const contents = { images, info: { author: 'xcode', version: 1 } };
  const cj = path.join(dir, 'Contents.json');
  writeText(cj, JSON.stringify(contents, null, 2) + '\n');
  log(cj, 'Xcode asset catalog manifest — Flutter default legacy layout (all sizes + ios-marketing 1024)');
  // Alternative Xcode 14+ single-size manifest. Kept OUTSIDE the .appiconset (extra files inside it
  // trigger "unassigned child" warnings). To switch: copy over Contents.json and delete other PNGs.
  const single = {
    images: [{ filename: 'Icon-App-1024x1024@1x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 },
  };
  const sj = B('app-icon', 'ios', 'Contents.single-size.json');
  writeText(sj, JSON.stringify(single, null, 2) + '\n');
  log(sj, 'Optional Xcode 14+ single-size (1024 universal) manifest');
}

async function androidIcons() {
  const base = B('app-icon', 'android');
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const px = Math.round(48 * k);
    const dir = path.join(base, `mipmap-${d}`);
    // Legacy (pre-Oreo) launcher icons: rounded square / circle with 1dp transparent margin.
    const f1 = path.join(dir, 'ic_launcher.png');
    await png(iconSvg(px, { shape: 'rounded', inset: 1 / 48, radius: 0.2, mark: { width: 0.68 }, favicon: px < SMALL }), f1);
    log(f1, `Legacy launcher icon ${px} px (${d})`);
    const f2 = path.join(dir, 'ic_launcher_round.png');
    await png(iconSvg(px, { shape: 'circle', inset: 1 / 48, mark: { safeRadius: 0.4 }, favicon: px < SMALL }), f2);
    log(f2, `Legacy round launcher icon ${px} px (${d})`);
    // Adaptive icon layers: 108dp canvas, symbol inside the 66dp safe circle (radius 33dp).
    const fp = Math.round(108 * k);
    const f3 = path.join(dir, 'ic_launcher_foreground.png');
    await png(iconSvg(fp, { bg: 'none', mark: { safeRadius: (31 / 108) } }), f3);
    log(f3, `Adaptive icon foreground ${fp} px (${d}) — symbol within 66dp safe zone`);
    const f4 = path.join(dir, 'ic_launcher_monochrome.png');
    await png(iconSvg(fp, { bg: 'none', mark: { safeRadius: (31 / 108) }, colors: L.COLORWAYS['mono-white'] }), f4);
    log(f4, `Android 13 themed (monochrome) icon layer ${fp} px (${d})`);
    // Notification (status bar) icon: 24dp, pure white silhouette, 2dp padding.
    const np = Math.round(24 * k);
    const f5 = path.join(base, `drawable-${d}`, 'ic_stat_jastipkita.png');
    await png(iconSvg(np, { bg: 'none', mark: { width: 20 / 24 }, favicon: true, colors: L.COLORWAYS['mono-white'] }), f5);
    log(f5, `Notification small icon ${np} px (${d}) — white on transparent`);
  }
  const xml = (round) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by brand/scripts/generate-assets.mjs — ${round ? 'round' : 'default'} adaptive launcher icon -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
  const a1 = path.join(base, 'mipmap-anydpi-v26', 'ic_launcher.xml');
  writeText(a1, xml(false));
  log(a1, 'Adaptive icon definition (background + foreground + monochrome)');
  const a2 = path.join(base, 'mipmap-anydpi-v26', 'ic_launcher_round.xml');
  writeText(a2, xml(true));
  log(a2, 'Adaptive round icon definition');
  const col = path.join(base, 'values', 'ic_launcher_background.xml');
  writeText(col, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- navy-900 — JastipKita primary -->
    <color name="ic_launcher_background">${L.BRAND.navy900}</color>
</resources>
`);
  log(col, 'Adaptive icon background colour (navy-900)');
  const ps = path.join(base, 'playstore-icon-512.png');
  await png(iconSvg(512, APP_ICON), ps, { opaque: true, background: L.BRAND.navy900 });
  log(ps, 'Google Play store listing icon 512×512 (full bleed, Play applies the mask)');
}

// -------------------------------------------------------------------------------------------
// 3. Web / PWA
// -------------------------------------------------------------------------------------------
async function web() {
  const dir = B('web');
  const tile = (px, favicon = px < SMALL) =>
    iconSvg(px, { shape: 'rounded', radius: 0.225, mark: { width: favicon ? 0.86 : 0.72 }, favicon });
  for (const px of [192, 512]) {
    const f = path.join(dir, `icon-${px}.png`);
    await png(tile(px), f);
    log(f, `PWA icon ${px} px (purpose "any", rounded tile)`);
  }
  const mk = path.join(dir, 'icon-maskable-512.png');
  await png(iconSvg(512, { mark: { safeRadius: 0.36 } }), mk, { opaque: true, background: L.BRAND.navy900 });
  log(mk, 'PWA maskable icon 512 px (symbol inside the 80 % safe circle)');
  const at = path.join(dir, 'apple-touch-icon.png');
  await png(iconSvg(180, APP_ICON), at, { opaque: true, background: L.BRAND.navy900 });
  log(at, 'Apple touch icon 180 px (opaque, iOS rounds corners)');
  const icoEntries = [];
  for (const px of [16, 32, 48, 64, 256, 512]) {
    const svg = tile(px, px <= 48);
    if ([16, 32, 64, 256, 512].includes(px)) {
      const f = path.join(dir, `favicon-${px}.png`);
      await png(svg, f);
      log(f, `Favicon ${px} px`);
    }
    if ([16, 32, 48].includes(px)) icoEntries.push({ size: px, buf: await pngBuffer(svg) });
  }
  const ico = path.join(dir, 'favicon.ico');
  writeFileSync(ico, icoFromPngs(icoEntries));
  log(ico, 'Multi-size favicon (16/32/48)');
  const fsvg = path.join(dir, 'favicon.svg');
  writeText(fsvg, tile(64, true).replace('<svg ', '<svg role="img" aria-label="JastipKita" '));
  log(fsvg, 'Scalable favicon (simplified symbol on navy tile)');
  const manifest = {
    name: 'JastipKita — Titip Mudah, Aman, Terpercaya.',
    short_name: 'JastipKita',
    description: 'Titip belanja dari luar negeri lewat traveler terverifikasi, dengan pembayaran SafePay.',
    lang: 'id',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: L.BRAND.navy900,
    background_color: L.BRAND.offwhite50,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
  const mf = path.join(dir, 'site.webmanifest');
  writeText(mf, JSON.stringify(manifest, null, 2) + '\n');
  log(mf, 'Web app manifest (PWA)');
}

// -------------------------------------------------------------------------------------------
// 4. Splash (flutter_native_splash)
// -------------------------------------------------------------------------------------------
function centered(svgInner, innerW, innerH, canvasW, canvasH, targetW) {
  const s = targetW / innerW;
  const tx = (canvasW - innerW * s) / 2;
  const ty = (canvasH - innerH * s) / 2;
  const inner = svgInner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasW} ${canvasH}" width="${canvasW}" height="${canvasH}"><g transform="translate(${tx} ${ty}) scale(${s})">${inner}</g></svg>`;
}

async function splash() {
  const dir = B('splash');
  for (const [v, name] of [['light', 'splash-logo-light.png'], ['dark', 'splash-logo-dark.png']]) {
    const lk = L.vertical(L.COLORWAYS[v]);
    const f = path.join(dir, name);
    await png(centered(lk.svg, lk.width, lk.height, 1152, 1152, 1152 * 0.62), f);
    log(f, `Splash logo (vertical lockup, ${v}) — 1152² transparent, flutter_native_splash "image"`);
  }
  for (const [v, name] of [['light', 'android12-splash-icon.png'], ['dark', 'android12-splash-icon-dark.png']]) {
    const f = path.join(dir, name);
    // 1152² canvas; icon must stay inside the inner 768 px circle (radius 384). Keep ≤ 0.3 × 1152.
    await png(iconSvg(1152, { bg: 'none', mark: { safeRadius: 0.3 }, colors: L.COLORWAYS[v] }), f);
    log(f, `Android 12+ splash icon (${v}) — symbol inside the 768 px safe circle`);
  }
  for (const [v, name] of [['light', 'splash-branding.png'], ['dark', 'splash-branding-dark.png']]) {
    const wm = L.wordmarkOnly(L.COLORWAYS[v]);
    const f = path.join(dir, name);
    await png(centered(wm.svg, wm.width, wm.height, 800, 240, 640), f);
    log(f, `Splash bottom branding wordmark (${v}) — 800×240 (200×60 dp @4x)`);
  }
}

// -------------------------------------------------------------------------------------------
// 5. Social & store graphics
// -------------------------------------------------------------------------------------------
function orbitPattern(w, h, cx, cy, { count = 7, rx0 = 180, step = 120, ratio = 0.36, rot = -15, color = L.BRAND.cobalt400, opacity = 0.14 } = {}) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const rx = rx0 + i * step;
    const o = opacity * (1 - i / (count + 1));
    out += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${rx * ratio}" transform="rotate(${rot} ${cx} ${cy})" fill="none" stroke="${color}" stroke-opacity="${o.toFixed(3)}" stroke-width="${1.5 + i * 0.25}"/>`;
  }
  // a couple of dotted "flight path" arcs for texture
  return `<g>${out}</g>`;
}

function lockupAt(lk, x, y, width) {
  const s = width / lk.width;
  const inner = lk.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');
  return { el: `<g transform="translate(${x} ${y}) scale(${s})">${inner}</g>`, h: lk.height * s, w: width };
}

function navyBackground(w, h, id = 'g') {
  return `<defs>
    <linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${L.BRAND.navy800}"/>
      <stop offset="0.6" stop-color="${L.BRAND.navy900}"/>
      <stop offset="1" stop-color="${L.BRAND.navy950}"/>
    </linearGradient>
    <radialGradient id="${id}-glow" cx="0.78" cy="0.2" r="0.7">
      <stop offset="0" stop-color="${L.BRAND.cobalt500}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="${L.BRAND.cobalt500}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#${id}-bg)"/>
  <rect width="${w}" height="${h}" fill="url(#${id}-glow)"/>`;
}

async function social() {
  const dir = B('social');
  for (const px of [1080, 400]) {
    const f = path.join(dir, `profile-${px}.png`);
    // safe for circular crop: symbol outline stays within 34 % radius of the centre
    await png(iconSvg(px, { mark: { safeRadius: 0.34 } }), f, { opaque: true, background: L.BRAND.navy900 });
    log(f, `Social profile picture ${px}² (circle-crop safe)`);
  }
  // OG image 1200×630
  {
    const W = 1200;
    const H = 630;
    const lk = L.horizontal(L.COLORWAYS.dark);
    const lw = 640;
    const g = lockupAt(lk, (W - lw) / 2, 0, lw);
    const tagSize = 34;
    const tag = L.taglinePaths(L.BRAND.slate300, tagSize, 0, 0);
    const blockH = g.h + 28 + tagSize;
    const top = (H - blockH) / 2 - 6;
    const lockEl = lockupAt(lk, (W - lw) / 2, top, lw).el;
    const tagX = (W - tag.ink.width) / 2 - tag.ink.x;
    const tagBase = top + g.h + 28 - tag.ink.y;
    const tagEl = L.taglinePaths(L.BRAND.slate300, tagSize, tagX, tagBase).d;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${navyBackground(W, H, 'og')}${orbitPattern(W, H, W / 2, H / 2 + 10, { rx0: 360, step: 110, count: 6 })}${lockEl}${tagEl}</svg>`;
    const f = path.join(dir, 'og-image-1200x630.png');
    await png(svg, f, { opaque: true, background: L.BRAND.navy900 });
    log(f, 'Open Graph / link preview image 1200×630');
  }
  // Cover 1500×500 (X/Twitter header; LinkedIn scales similar). Content kept in the centre-right
  // to avoid the avatar overlap at bottom-left.
  {
    const W = 1500;
    const H = 500;
    const lk = L.horizontal(L.COLORWAYS.dark);
    const lw = 620;
    const g = lockupAt(lk, 0, 0, lw);
    const tagSize = 32;
    const tag = L.taglinePaths(L.BRAND.slate300, tagSize, 0, 0);
    const blockH = g.h + 24 + tagSize;
    const top = (H - blockH) / 2 - 4;
    const x = (W - lw) / 2 + 60;
    const lockEl = lockupAt(lk, x, top, lw).el;
    const tagEl = L.taglinePaths(L.BRAND.slate300, tagSize, x + (lw - tag.ink.width) / 2 - tag.ink.x, top + g.h + 24 - tag.ink.y).d;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${navyBackground(W, H, 'cv')}${orbitPattern(W, H, W / 2 + 60, H / 2 + 10, { rx0: 380, step: 120, count: 6 })}${lockEl}${tagEl}</svg>`;
    const f = path.join(dir, 'cover-1500x500.png');
    await png(svg, f, { opaque: true, background: L.BRAND.navy900 });
    log(f, 'Social cover/header 1500×500');
  }
}

async function store() {
  const dir = B('store');
  {
    const W = 1024;
    const H = 500;
    const lk = L.vertical(L.COLORWAYS.dark);
    const lw = 360;
    const g = lockupAt(lk, 0, 0, lw);
    const tagSize = 26;
    const tag = L.taglinePaths(L.BRAND.slate300, tagSize, 0, 0);
    const blockH = g.h + 18 + tagSize;
    const top = (H - blockH) / 2;
    const x = (W - lw) / 2;
    const lockEl = lockupAt(lk, x, top, lw).el;
    const tagEl = L.taglinePaths(L.BRAND.slate300, tagSize, (W - tag.ink.width) / 2 - tag.ink.x, top + g.h + 18 - tag.ink.y).d;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${navyBackground(W, H, 'fg')}${orbitPattern(W, H, W / 2, H / 2 - 20, { rx0: 300, step: 100, count: 6 })}${lockEl}${tagEl}</svg>`;
    const f = path.join(dir, 'play-feature-graphic-1024x500.png');
    await png(svg, f, { opaque: true, background: L.BRAND.navy900 });
    log(f, 'Google Play feature graphic 1024×500 (24-bit PNG, no alpha)');
  }
  const f = path.join(dir, 'app-store-icon-1024.png');
  await png(iconSvg(1024, APP_ICON), f, { opaque: true, background: L.BRAND.navy900 });
  log(f, 'App Store Connect icon 1024² (no alpha, no rounded corners)');
}

// -------------------------------------------------------------------------------------------
// 6. Fonts
// -------------------------------------------------------------------------------------------
function fonts() {
  const ttf = {
    Regular: '@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf',
    Italic: '@expo-google-fonts/poppins/400Regular_Italic/Poppins_400Regular_Italic.ttf',
    Medium: '@expo-google-fonts/poppins/500Medium/Poppins_500Medium.ttf',
    SemiBold: '@expo-google-fonts/poppins/600SemiBold/Poppins_600SemiBold.ttf',
    Bold: '@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf',
  };
  for (const [name, id] of Object.entries(ttf)) {
    const dst = path.join(ROOT, 'apps', 'mobile', 'assets', 'fonts', `Poppins-${name}.ttf`);
    ensureDir(dst);
    copyFileSync(resolveDep(id), dst);
    log(dst, `Poppins ${name} TTF (Flutter)`);
  }
  const files = path.dirname(resolveDep('@fontsource/poppins/files/poppins-latin-400-normal.woff2'));
  const unicode = JSON.parse(readFileSync(path.join(path.dirname(files), 'unicode.json'), 'utf8'));
  const faces = [];
  for (const app of ['web', 'admin']) {
    const outDir = path.join(ROOT, 'apps', app, 'public', 'fonts');
    mkdirSync(outDir, { recursive: true });
    for (const w of [400, 500, 600, 700]) {
      for (const style of w === 400 ? ['normal', 'italic'] : ['normal']) {
        for (const subset of ['latin', 'latin-ext']) {
          const fn = `poppins-${subset}-${w}-${style}.woff2`;
          copyFileSync(path.join(files, fn), path.join(outDir, fn));
          if (app === 'web') {
            faces.push(`/* Poppins ${w} ${style} — ${subset} */
@font-face {
  font-family: 'Poppins';
  font-style: ${style};
  font-weight: ${w};
  font-display: swap;
  src: url('./${fn}') format('woff2');
  unicode-range: ${unicode[subset]};
}`);
          }
        }
      }
    }
  }
  const css = `/* Generated by brand/scripts/generate-assets.mjs — Poppins (SIL OFL 1.1, see brand/fonts/OFL.txt) */\n${faces.join('\n')}\n`;
  for (const app of ['web', 'admin']) {
    const f = path.join(ROOT, 'apps', app, 'public', 'fonts', 'poppins.css');
    writeText(f, css);
    log(f, `@font-face declarations for apps/${app} (latin + latin-ext subsets, woff2)`);
  }
  const ofl = B('fonts', 'OFL.txt');
  // Upstream LICENSE repeats the copyright line once per style on a single line — normalise it.
  const license = readFileSync(resolveDep('@fontsource/poppins/LICENSE'), 'utf8');
  const body = license.slice(license.indexOf('This Font Software is licensed'));
  writeText(ofl, `Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)\n\n${body}`);
  log(ofl, 'Poppins licence (SIL Open Font License 1.1)');
}

// -------------------------------------------------------------------------------------------
// 7. Contact sheet (Playwright)
// -------------------------------------------------------------------------------------------
async function previewSheet() {
  const { renderBrandSheet, renderAnatomy } = await import('./lib/brand-sheet.mjs');
  const f = B('preview', 'brand-sheet.png');
  await renderBrandSheet(ROOT, f);
  log(f, 'Contact sheet: all logo variants on light & dark, palette, type specimen, icons');
  const a = B('preview', 'logo-anatomy.png');
  await renderAnatomy(ROOT, a);
  log(a, 'Logo anatomy, clear-space and minimum-size diagram');
}

async function main() {
  logos();
  await iosIcons();
  await androidIcons();
  await web();
  await splash();
  await social();
  await store();
  fonts();
  if (!args.has('--no-preview')) {
    try {
      await previewSheet();
    } catch (e) {
      console.warn('! brand sheet skipped:', e.message);
    }
  }
  const inv = B('preview', 'asset-inventory.json');
  writeText(inv, JSON.stringify(inventory.map(([file, purpose]) => ({ file, purpose })), null, 2) + '\n');
  console.log(`Generated ${inventory.length} assets. Inventory → ${path.relative(ROOT, inv)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
