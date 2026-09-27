// Contact sheet: logo variants on light & dark, palette, type specimen, icon family.
// Rendered with Playwright (Chromium) so the specimen uses the real Poppins woff2 files.
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireDep } from './deps.mjs';
import { ensureDir } from './raster.mjs';

const PALETTE = [
  { name: 'navy-900', role: 'Primary · brand, headings, app bar', hex: '#0B1E4A', ratio: '25%' },
  { name: 'cobalt-500', role: 'Secondary · primary CTA, links, focus', hex: '#1E5BFF', ratio: '10%' },
  { name: 'offwhite-50', role: 'Background (light)', hex: '#F7F8FB', ratio: '55%', dark: true },
  { name: 'ink-900', role: 'Body text (light)', hex: '#0F172A' },
  { name: 'slate-500', role: 'Secondary text', hex: '#64748B' },
  { name: 'navy-950', role: 'Background (dark)', hex: '#070B19' },
  { name: 'navy-800', role: 'Elevated surface (dark)', hex: '#12295F' },
  { name: 'cobalt-400', role: 'CTA on dark', hex: '#4D7DFF' },
  { name: 'emerald-600', role: 'Success · PAYMENT SECURED', hex: '#059669', ratio: '≤5%' },
  { name: 'orange-500', role: 'Warning · price change', hex: '#F97316' },
  { name: 'red-600', role: 'Error · DO NOT PURCHASE', hex: '#DC2626' },
];

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

export async function renderBrandSheet(ROOT, outFile) {
  const { chromium } = requireDep('playwright');
  const logo = (f) => readFileSync(path.join(ROOT, 'brand', 'logo', f), 'utf8').replace(/<title>.*?<\/title>/, '');
  const url = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;
  const font = (w, s = 'normal') => url('apps', 'web', 'public', 'fonts', `poppins-latin-${w}-${s}.woff2`);

  const tile = (svg, bg, label, cls = '') => `<figure class="tile ${cls}" style="background:${bg}"><div class="art">${svg}</div><figcaption>${label}</figcaption></figure>`;

  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>JastipKita brand sheet</title><style>
  @font-face{font-family:Poppins;font-weight:400;src:url(${font(400)}) format('woff2')}
  @font-face{font-family:Poppins;font-weight:500;src:url(${font(500)}) format('woff2')}
  @font-face{font-family:Poppins;font-weight:600;src:url(${font(600)}) format('woff2')}
  @font-face{font-family:Poppins;font-weight:700;src:url(${font(700)}) format('woff2')}
  *{box-sizing:border-box;margin:0}
  body{font-family:Poppins,sans-serif;background:#EEF1F6;color:#0F172A;padding:56px 64px;width:1600px;text-rendering:geometricPrecision;-webkit-font-smoothing:antialiased}
  header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:36px}
  header .t{font-size:40px;font-weight:600;letter-spacing:-0.02em;color:#0B1E4A}
  header .s{font-size:16px;color:#64748B;margin-top:4px}
  header .meta{font-size:13px;color:#64748B;text-align:right;line-height:1.6}
  h2{font-size:14px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#64748B;margin:40px 0 16px}
  .grid{display:grid;gap:16px}
  .g4{grid-template-columns:2fr 1.2fr 1.2fr 1fr}
  .g5{grid-template-columns:repeat(5,1fr)}
  .tile{border-radius:20px;padding:28px;display:flex;flex-direction:column;justify-content:space-between;min-height:220px;border:1px solid rgba(15,23,42,.06)}
  .tile .art{flex:1;display:flex;align-items:center;justify-content:center;padding:8px}
  .tile .art svg{max-width:100%;max-height:150px;height:auto}
  .tile.sm .art svg{max-height:110px}
  .tile figcaption{font-size:12px;font-weight:500;color:#64748B;margin-top:14px}
  .dk figcaption{color:#94A3B8}
  .pal{display:grid;grid-template-columns:repeat(6,1fr);gap:14px}
  .sw{border-radius:16px;overflow:hidden;background:#fff;border:1px solid rgba(15,23,42,.06)}
  .sw .c{height:92px;display:flex;align-items:flex-end;padding:10px 12px;font-size:12px;font-weight:600}
  .sw .i{padding:10px 12px 12px;font-size:12px;line-height:1.5}
  .sw .n{font-weight:600;font-size:13px}
  .sw .h{font-variant-numeric:tabular-nums;color:#334155}
  .sw .r{color:#64748B}
  .ratio{display:flex;height:28px;border-radius:10px;overflow:hidden;margin-top:14px;font-size:11px;font-weight:600}
  .ratio div{display:flex;align-items:center;padding-left:10px}
  .type{display:grid;grid-template-columns:1.3fr 1fr;gap:16px}
  .card{background:#fff;border-radius:20px;padding:28px 32px;border:1px solid rgba(15,23,42,.06)}
  .spec div{display:flex;align-items:baseline;gap:18px;padding:8px 0;border-bottom:1px solid #EEF1F6}
  .spec span.k{width:150px;flex:none;font-size:12px;color:#64748B}
  .glyphs{font-size:30px;line-height:1.35;color:#0B1E4A}
  .money{font-feature-settings:"tnum";font-variant-numeric:tabular-nums}
  .icons{display:flex;gap:28px;align-items:flex-end;flex-wrap:wrap}
  .icons figure{display:flex;flex-direction:column;align-items:center;gap:8px;font-size:11px;color:#64748B}
  .icons img{display:block}
  .sq{border-radius:22.37%}
  .ci{border-radius:50%}
  .note{font-size:12px;color:#64748B;margin-top:12px}
  </style></head><body>
  <header><div><div class="t">JastipKita — Brand Sheet</div><div class="s">Titip Mudah, Aman, Terpercaya. · Shopping bag + airplane + orbital swoosh</div></div>
  <div class="meta">Logo v1.0 · Poppins SemiBold wordmark (outlined)<br>Generated by brand/scripts/generate-assets.mjs</div></header>

  <h2>Logo · light backgrounds</h2>
  <div class="grid g4">
    ${tile(logo('jastipkita-horizontal.svg'), '#FFFFFF', 'Horizontal · primary')}
    ${tile(logo('jastipkita-vertical.svg'), '#FFFFFF', 'Vertical')}
    ${tile(logo('jastipkita-vertical-tagline.svg'), '#F7F8FB', 'Vertical + tagline')}
    ${tile(logo('jastipkita-symbol.svg'), '#FFFFFF', 'Symbol')}
  </div>
  <h2>Logo · dark backgrounds</h2>
  <div class="grid g4">
    ${tile(logo('jastipkita-horizontal-dark.svg'), '#070B19', 'Horizontal · dark', 'dk')}
    ${tile(logo('jastipkita-vertical-dark.svg'), '#0B1E4A', 'Vertical · on navy-900', 'dk')}
    ${tile(logo('jastipkita-vertical-tagline-dark.svg'), '#070B19', 'Vertical + tagline · dark', 'dk')}
    ${tile(logo('jastipkita-symbol-dark.svg'), '#12295F', 'Symbol · on navy-800', 'dk')}
  </div>
  <h2>One-colour &amp; small-size</h2>
  <div class="grid g5">
    ${tile(logo('jastipkita-horizontal-mono-black.svg'), '#FFFFFF', 'Mono black', 'sm')}
    ${tile(logo('jastipkita-horizontal-mono-white.svg'), 'linear-gradient(135deg,#1E5BFF,#0B1E4A)', 'Mono white · on imagery/colour', 'sm dk')}
    ${tile(logo('jastipkita-symbol-mono-black.svg'), '#F7F8FB', 'Symbol mono black', 'sm')}
    ${tile(logo('jastipkita-symbol-mono-white.svg'), '#0B1E4A', 'Symbol mono white', 'sm dk')}
    ${tile(logo('jastipkita-symbol-favicon.svg'), '#FFFFFF', 'Favicon symbol (≤ 32 px)', 'sm')}
  </div>

  <h2>App icon family</h2>
  <div class="card"><div class="icons">
    <figure><img class="sq" src="${url('brand/app-icon/ios/AppIcon.appiconset/Icon-App-1024x1024@1x.png')}" width="180" height="180">iOS (masked preview)</figure>
    <figure><img class="ci" src="${url('brand/app-icon/android/playstore-icon-512.png')}" width="140" height="140">Android · circle mask</figure>
    <figure><img style="border-radius:30%" src="${url('brand/app-icon/android/playstore-icon-512.png')}" width="140" height="140">Android · squircle</figure>
    <figure><img src="${url('brand/app-icon/android/mipmap-xxxhdpi/ic_launcher_round.png')}" width="96" height="96">Legacy round</figure>
    <figure><img src="${url('brand/web/icon-192.png')}" width="96" height="96">PWA</figure>
    <figure><img src="${url('brand/web/favicon-64.png')}" width="64" height="64">64</figure>
    <figure><img src="${url('brand/web/favicon-32.png')}" width="32" height="32">32</figure>
    <figure><img src="${url('brand/web/favicon-16.png')}" width="16" height="16">16</figure>
    <figure style="background:#1F2937;padding:10px;border-radius:12px;color:#CBD5E1"><img src="${url('brand/app-icon/android/drawable-xxxhdpi/ic_stat_jastipkita.png')}" width="48" height="48">Notification</figure>
    <figure style="background:#3F3F46;padding:10px;border-radius:50%"><img src="${url('brand/app-icon/android/mipmap-xxxhdpi/ic_launcher_monochrome.png')}" width="96" height="96"></figure>
  </div><p class="note">Android 13 themed icon (last) is tinted by the system; adaptive foreground keeps the symbol inside the 66 dp safe circle.</p></div>

  <h2>Colour</h2>
  <div class="pal">
    ${PALETTE.map((p) => `<div class="sw"><div class="c" style="background:${p.hex};color:${['#F7F8FB'].includes(p.hex) ? '#0B1E4A' : '#fff'}">${p.ratio ?? ''}</div><div class="i"><div class="n">${p.name}</div><div class="h">${p.hex} · rgb(${rgb(p.hex)})</div><div class="r">${p.role}</div></div></div>`).join('')}
  </div>
  <div class="ratio"><div style="flex:55;background:#F7F8FB;color:#0B1E4A">Off-white / white 55%</div><div style="flex:25;background:#0B1E4A;color:#fff">Navy 25%</div><div style="flex:10;background:#1E5BFF;color:#fff">Cobalt 10%</div><div style="flex:5;background:#64748B;color:#fff">Slate 5%</div><div style="flex:5;background:linear-gradient(90deg,#059669 0 33%,#F97316 33% 66%,#DC2626 66%)"></div></div>

  <h2>Typography · Poppins</h2>
  <div class="type">
    <div class="card spec">
      <div><span class="k">Display · 700 / 40</span><span style="font:700 40px/48px Poppins;letter-spacing:-.02em;color:#0B1E4A">Titip Mudah, Aman.</span></div>
      <div><span class="k">Headline M · 600 / 28</span><span style="font:600 28px/36px Poppins;letter-spacing:-.01em;color:#0B1E4A">Traveler terverifikasi</span></div>
      <div><span class="k">Title M · 600 / 18</span><span style="font:600 18px/26px Poppins">Rincian biaya transparan</span></div>
      <div><span class="k">Body L · 400 / 16</span><span style="font:400 16px/24px Poppins;color:#334155">Dana kamu diamankan SafePay sampai barang diterima.</span></div>
      <div><span class="k">Label M · 500 / 13</span><span style="font:500 13px/18px Poppins;letter-spacing:.01em;color:#64748B">ESTIMASI · BEA MASUK</span></div>
      <div><span class="k">Money · 600 / 24 tnum</span><span class="money" style="font:600 24px/32px Poppins;color:#0B1E4A">Rp 12.450.000 &nbsp; Rp 1.111.111</span></div>
    </div>
    <div class="card"><div class="glyphs"><span style="font-weight:700">Aa</span> <span style="font-weight:600">Aa</span> <span style="font-weight:500">Aa</span> <span style="font-weight:400">Aa</span><br>
      <span style="font-weight:500;font-size:22px;color:#334155">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br><span class="money">0123456789</span> Rp ¥ $ € ₩ %</span></div>
      <p class="note">Weights: 400 Regular · 500 Medium · 600 SemiBold · 700 Bold. Money always uses tabular figures (font-feature-settings: "tnum").</p></div>
  </div>
  </body></html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1728, height: 1200 }, deviceScaleFactor: 1 });
    const tmp = path.join(os.tmpdir(), `jk-brand-sheet-${process.pid}.html`);
    writeFileSync(tmp, html);
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    ensureDir(outFile);
    const body = await page.$('body');
    await body.screenshot({ path: outFile });
  } finally {
    await browser.close();
  }
}

/** Logo anatomy + clear-space + minimum-size diagram → brand/preview/logo-anatomy.png */
export async function renderAnatomy(ROOT, outFile) {
  const { chromium } = requireDep('playwright');
  const L = await import('./lockups.mjs');
  const S = L.SYMBOL;
  const url = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;
  const font = (w) => url('apps', 'web', 'public', 'fonts', `poppins-latin-${w}-normal.woff2`);
  // Callout anchors in the 512-unit design grid (see geometry.mjs DEFAULT_PARAMS).
  const callouts = [
    { n: 1, x: 244, y: 121, lx: 70, ly: 70, t: 'Handle — busur ½ lingkaran, tebal konstan 19 u' },
    { n: 2, x: 299.5, y: 226, lx: 470, ly: 110, t: 'Grommet + strap — ciri tas belanja (bukan gembok)' },
    { n: 3, x: 206, y: 260, lx: 40, ly: 190, t: 'Badan tas — trapesium, fillet 22 / 34 u' },
    { n: 4, x: 132, y: 262, lx: 20, ly: 300, t: 'Ekor orbit — muncul dari BELAKANG tas' },
    { n: 5, x: 207, y: 382, lx: 40, ly: 470, t: 'Sisi dekat orbit — lewat DI DEPAN tas, maks 29 u' },
    { n: 6, x: 312, y: 374, lx: 380, ly: 490, t: 'Celah knock-out 11 u — wajib di semua varian' },
    { n: 7, x: 456, y: 228, lx: 470, ly: 300, t: 'Pesawat — hidung naik 42°, terpisah dari swoosh' },
  ];
  const sym = `<svg viewBox="0 0 512 512" width="560" height="560" style="overflow:visible">
    <rect x="${S.bounds.x}" y="${S.bounds.y}" width="${S.bounds.width}" height="${S.bounds.height}" fill="none" stroke="#CBD5E1" stroke-dasharray="4 4"/>
    <path d="${S.bag}" fill="#0B1E4A"/><path d="${S.swoosh}" fill="#1E5BFF"/><path d="${S.plane}" fill="#1E5BFF"/>
    ${callouts.map((c) => `<line x1="${c.x}" y1="${c.y}" x2="${c.lx}" y2="${c.ly}" stroke="#F97316" stroke-width="1.2"/><circle cx="${c.x}" cy="${c.y}" r="4" fill="#F97316"/><circle cx="${c.lx}" cy="${c.ly}" r="13" fill="#F97316"/><text x="${c.lx}" y="${c.ly + 5}" text-anchor="middle" font-family="Poppins" font-weight="600" font-size="14" fill="#fff">${c.n}</text>`).join('')}
  </svg>`;
  const h = L.horizontal(L.COLORWAYS.light);
  const X = L.WORD.capHeight;
  const pad = L.PROPORTIONS.padding * X;
  const k = 640 / h.width; // display scale
  const inner = h.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');
  const inkW = h.width - 2 * pad;
  const inkH = h.height - 2 * pad;
  const W = inkW + 2 * X + 2 * pad + 40;
  const H = inkH + 2 * X + 2 * pad + 40;
  const ox = 20 + X; // ink origin inside diagram
  const oy = 20 + X;
  const clear = `<svg viewBox="0 0 ${W} ${H}" width="${W * k}" height="${H * k}">
    <rect x="20" y="20" width="${inkW + 2 * X}" height="${inkH + 2 * X}" fill="#EEF3FF" stroke="#1E5BFF" stroke-dasharray="6 5" stroke-width="1.5"/>
    <rect x="${ox}" y="${oy}" width="${inkW}" height="${inkH}" fill="#fff"/>
    <g transform="translate(${ox - pad} ${oy - pad})">${inner}</g>
    ${[[20, 20 + X / 2 + inkH / 2, 'h'], [ox + inkW, 20 + X / 2 + inkH / 2, 'h'], [ox + inkW / 2 - X / 2, 20, 'v'], [ox + inkW / 2 - X / 2, oy + inkH, 'v']]
      .map(([x, y, o]) => (o === 'h' ? `<rect x="${x}" y="${y - X / 2}" width="${X}" height="${X}" fill="#1E5BFF" opacity=".18"/><text x="${x + X / 2}" y="${y + 9}" text-anchor="middle" font-family="Poppins" font-weight="600" font-size="26" fill="#1E5BFF">X</text>` : `<rect x="${x}" y="${y}" width="${X}" height="${X}" fill="#1E5BFF" opacity=".18"/><text x="${x + X / 2}" y="${y + X / 2 + 9}" text-anchor="middle" font-family="Poppins" font-weight="600" font-size="26" fill="#1E5BFF">X</text>`))
      .join('')}
  </svg>`;
  const sizes = [
    ['jastipkita-horizontal.svg', 140, 'Horizontal ≥ 140 px'],
    ['jastipkita-vertical.svg', 80, 'Vertikal ≥ 80 px'],
    ['jastipkita-symbol.svg', 40, 'Simbol ≥ 40 px'],
    ['jastipkita-symbol-favicon.svg', 16, 'Favicon 16–39 px'],
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Poppins;font-weight:400;src:url(${font(400)})}@font-face{font-family:Poppins;font-weight:500;src:url(${font(500)})}@font-face{font-family:Poppins;font-weight:600;src:url(${font(600)})}
    *{margin:0;box-sizing:border-box} body{width:1600px;padding:56px 64px;background:#F7F8FB;font-family:Poppins;color:#0F172A;text-rendering:geometricPrecision}
    h1{font-size:32px;font-weight:600;color:#0B1E4A;letter-spacing:-.02em} h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#64748B;margin:0 0 16px;font-weight:600}
    .row{display:grid;grid-template-columns:600px 1fr;gap:40px;margin-top:32px} .card{background:#fff;border-radius:20px;padding:28px;border:1px solid #E2E8F0}
    ol{padding-left:0;list-style:none;display:grid;gap:12px;font-size:15px} li{display:flex;gap:12px;align-items:baseline} li b{flex:none;width:26px;height:26px;border-radius:50%;background:#F97316;color:#fff;font-size:13px;display:inline-flex;align-items:center;justify-content:center}
    .note{font-size:13px;color:#475569;margin-top:14px;line-height:1.6} .sizes{display:flex;gap:36px;align-items:flex-end;margin-top:8px} .sizes figure{display:flex;flex-direction:column;align-items:flex-start;gap:10px;font-size:12px;color:#475569}
  </style></head><body>
  <h1>Logo anatomy, clear space &amp; minimum size</h1>
  <div class="row"><div class="card">${sym}</div><div class="card"><h2>Anatomi</h2><ol>${callouts.map((c) => `<li><b>${c.n}</b><span>${c.t}</span></li>`).join('')}</ol>
    <p class="note">Grid desain 512 × 512 u. Garis putus-putus abu = bounding box simbol (435 × 315 u, rasio 1,38 : 1). Semua bentuk = path hasil operasi boolean; tidak ada stroke, mask, atau font di file SVG.</p></div></div>
  <div class="row" style="grid-template-columns:1fr 1fr"><div class="card"><h2>Ruang bebas — X = tinggi kapital "J"</h2>${clear}<p class="note">Area biru = ruang bebas minimum 1 X di keempat sisi. Untuk simbol saja: 25 % tinggi simbol.</p></div>
  <div class="card"><h2>Ukuran minimum (digital)</h2><div class="sizes">${sizes.map(([f, w, t]) => `<figure><img src="${url('brand', 'logo', f)}" width="${w}">${t}</figure>`).join('')}</div>
  <p class="note">Di bawah 40 px gunakan simbol favicon (tanpa pesawat, stroke lebih tebal). Cetak: horizontal ≥ 35 mm, vertikal ≥ 22 mm, simbol ≥ 10 mm.</p></div></div>
  </body></html>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1728, height: 1200 } });
    const tmp = path.join(os.tmpdir(), `jk-anatomy-${process.pid}.html`);
    writeFileSync(tmp, html);
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    ensureDir(outFile);
    await (await page.$('body')).screenshot({ path: outFile });
  } finally {
    await browser.close();
  }
}
