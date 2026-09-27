import { expect, test, type Page } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cspProblems } from '../scripts/csp-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const BASE = '/jastipkita';

/** Every built page (dir/index.html) as a URL path, plus 404.html. */
function builtPages(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === 'index.html') out.push(`${BASE}/${relative(dist, d).split('\\').join('/')}${relative(dist, d) ? '/' : ''}`);
    }
  };
  walk(dist);
  return out.sort();
}
const PAGES = builtPages();
const NOINDEX = ['/akun/', '/app/', '/masuk/', '/r/'];

async function blockApi(page: Page) {
  // The production API is not deployed; make that deterministic (no DNS wait) and assert no third parties.
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort('internetdisconnected'));
}

test('site has the expected pages', () => {
  expect(PAGES.length).toBeGreaterThanOrEqual(50);
  for (const p of ['/', '/jastip-jepang/', '/jastip-korea/', '/jastip-singapore/', '/jastip-usa/', '/jastip-malaysia/', '/jastip-australia/', '/trip/', '/kalkulator-bea-cukai/', '/cek-barang-terlarang/', '/bantuan/', '/masuk/', '/akun/', '/hapus-akun/', '/app/transactions/', '/r/', '/legal/', '/en/', '/en/customs-calculator/', '/en/restricted-items/', '/en/delete-account/']) {
    expect(PAGES, p).toContain(`${BASE}${p}`);
  }
});

for (const path of PAGES) {
  test(`page ${path}: 200, one h1, meta, canonical, JSON-LD, no CSP violations`, async ({ page }) => {
    await blockApi(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const res = await page.goto(path, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveCount(1);
    expect((await page.title()).length).toBeGreaterThan(5);
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    expect(desc && desc.length).toBeGreaterThan(40);
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(/^https:\/\/antarkitaindonesia\.com\/jastipkita\//);
    expect(await page.locator('html').getAttribute('lang')).toMatch(/^(id|en)$/);
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('a.skip-link[href="#main"]')).toHaveCount(1);
    for (const raw of await page.locator('script[type="application/ld+json"]').allTextContents()) {
      const data = JSON.parse(raw);
      expect(data['@context']).toBe('https://schema.org');
    }
    const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null);
    if (NOINDEX.some((p) => path.startsWith(`${BASE}${p}`))) expect(robots).toContain('noindex');
    // images need alt text
    const imgsWithoutAlt = await page.locator('img:not([alt])').count();
    expect(imgsWithoutAlt).toBe(0);
    // the page runs under its own CSP without violations (fonts, styles, module scripts, theme bootstrap)
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  });
}

test('no broken internal links or assets', async ({ request }) => {
  const seen = new Set<string>();
  const broken: string[] = [];
  for (const path of [...PAGES, `${BASE}/404.html`]) {
    const file = path.endsWith('.html') ? join(dist, path.slice(BASE.length)) : join(dist, path.slice(BASE.length), 'index.html');
    const html = readFileSync(file, 'utf8');
    const refs = [...html.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)].map((m) => m[1]!).filter((u) => !/^(https?:|mailto:|tel:|data:|intent:|jastipkita:)/.test(u));
    for (const ref of refs) {
      const abs = new URL(ref.replace(/&amp;/g, '&'), `http://localhost${path}`).pathname;
      if (!abs.startsWith(`${BASE}/`)) { broken.push(`${path} → ${ref} (outside base)`); continue; }
      if (seen.has(abs)) continue;
      seen.add(abs);
      const res = await request.get(abs, { maxRedirects: 0 });
      if (res.status() !== 200) broken.push(`${path} → ${abs} (${res.status()})`);
    }
  }
  expect(broken, broken.join('\n')).toEqual([]);
  expect(seen.size).toBeGreaterThan(60);
});

test('every built HTML page carries the CSP meta and no inline <script> without a matching hash (SEC-14)', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.html')) files.push(p);
    }
  };
  walk(dist);
  expect(files.length).toBeGreaterThanOrEqual(57);
  const failures = files.flatMap((f) => cspProblems(readFileSync(f, 'utf8')).map((p: string) => `${relative(dist, f)}: ${p}`));
  expect(failures, failures.join('\n')).toEqual([]);
  // the checker itself must catch an unhashed inline script, inline styles and handlers
  const bad = readFileSync(join(dist, 'index.html'), 'utf8').replace('</body>', '<script>alert(1)</script><div style="x" onclick="y"></div></body>');
  expect(cspProblems(bad).join(' ')).toMatch(/without matching hash[\s\S]*style=""[\s\S]*event handler/);
});

test('sitemap lists public pages only', async ({ request }) => {
  const res = await request.get(`${BASE}/sitemap-0.xml`);
  expect(res.status()).toBe(200);
  const xml = await res.text();
  expect(xml).toContain('https://antarkitaindonesia.com/jastipkita/jastip-jepang/');
  for (const p of NOINDEX) expect(xml).not.toContain(`https://antarkitaindonesia.com/jastipkita${p}`);
  const robots = await (await request.get(`${BASE}/robots.txt`)).text();
  expect(robots).toContain('Disallow: /jastipkita/akun/');
  expect(robots).toContain('Disallow: /jastipkita/app/');
});

test('legal pages render with TOC and template banner', async ({ page }) => {
  const legal = PAGES.filter((p) => /\/legal\/[a-z-]+\/$/.test(p));
  expect(legal.length).toBe(10);
  for (const p of legal) {
    await page.goto(p);
    await expect(page.locator('.toc li').first()).toBeVisible();
    await expect(page.locator('article.prose blockquote').first()).toContainText('TEMPLATE — wajib direview konsultan hukum');
    const text = await page.locator('article.prose').innerText();
    expect(text.length).toBeGreaterThan(1500);
    expect(await page.locator('article.prose a[href$=".md"]').count()).toBe(0);
  }
});

test.describe('mobile 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const path of PAGES) {
    test(`no horizontal overflow ${path}`, async ({ page }) => {
      await blockApi(page);
      await page.goto(path, { waitUntil: 'load' });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
  test('mobile nav toggles', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const btn = page.locator('[data-nav-toggle]');
    await btn.click();
    await expect(page.locator('#mobile-nav')).toBeVisible();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
  });
});

test('calculator falls back to the local PMK 34/2025 formula when the API is down', async ({ page }) => {
  await blockApi(page);
  await page.goto(`${BASE}/kalkulator-bea-cukai/?origin=JP`);
  await page.selectOption('#category', 'FOOTWEAR');
  await page.fill('#price', '60000');
  await page.click('#calc-submit');
  await expect(page.locator('#calc-status')).toHaveAttribute('data-state', 'offline');
  await expect(page.locator('.res-total strong')).toHaveText('Rp 1.885.000'); // docs/research/01 §6 engine value
});

test('restricted checker offline classifies CBD as prohibited', async ({ page }) => {
  await blockApi(page);
  await page.goto(`${BASE}/cek-barang-terlarang/?origin=US`);
  await page.fill('#rc-name', 'CBD oil 1000mg');
  await page.click('#rc-submit');
  await expect(page.locator('.class-banner')).toHaveClass(/class-PROHIBITED/);
});

test('trip discovery shows the honest "segera hadir" state without an API', async ({ page }) => {
  await blockApi(page);
  await page.goto(`${BASE}/trip/`);
  await expect(page.getByRole('heading', { name: 'Layanan segera hadir' })).toBeVisible();
});

test('deep link fallback validates ids and forwards from the 404 page', async ({ page }) => {
  await page.goto(`${BASE}/app/transactions/JK-260927-7QK2MD`);
  await expect(page).toHaveURL(/\/app\/transactions\/\?id=JK-260927-7QK2MD$/);
  await expect(page.locator('#dl-id strong')).toHaveText('JK-260927-7QK2MD');
  await page.goto(`${BASE}/app/transactions/?id=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
  await expect(page.locator('#dl-invalid')).toBeVisible();
  await expect(page.locator('#dl-id')).toBeHidden();
  await page.goto(`${BASE}/r/JASTIP-AB12`);
  await expect(page.locator('#ref-code')).toHaveText('JASTIP-AB12');
});

test('consent banner: shown once, strictly-necessary storage only, no third-party requests', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost')) external.push(r.url()); });
  await page.goto(`${BASE}/`);
  await expect(page.locator('[data-consent]')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.click('[data-consent-choice="necessary"]');
  await expect(page.locator('[data-consent]')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('jk:consent'))).toBe('necessary');
  expect(await page.evaluate(() => Object.keys(localStorage).every((k) => k.startsWith('jk:')))).toBe(true);
  await page.reload();
  await expect(page.locator('[data-consent]')).toBeHidden();
  expect(external, external.join('\n')).toEqual([]);
});

test('well-known files are valid JSON with the right app ids', async ({ request }) => {
  const al = await (await request.get('/.well-known/assetlinks.json')).json();
  expect(al[0].target.package_name).toBe('com.antarkitaindonesia.jastipkita');
  const aasa = await (await request.get('/.well-known/apple-app-site-association')).json();
  expect(JSON.stringify(aasa)).toContain('/jastipkita/app/*');
  expect(JSON.stringify(aasa)).toContain('/jastipkita/r/*');
});
