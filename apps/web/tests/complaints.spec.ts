import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Launch checklist L12 — "Layanan Pengaduan Konsumen" (Permendag 19/2026, UU 8/1999): channels, SLA, process,
// government escalation; reachable from the home page footer and the help center.
const here = dirname(fileURLToPath(import.meta.url));
const BASE = '/jastipkita';
const defaults = JSON.parse(readFileSync(resolve(here, '../../../packages/core/src/config/business-config.defaults.json'), 'utf8'));
const SLA: Record<'URGENT' | 'HIGH' | 'NORMAL' | 'LOW', number> = defaults['support.sla'].hoursByPriority;

async function blockApi(page: Page) {
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort('internetdisconnected'));
}

test('ID complaint page: pre-launch notice, channels, SLA from config, process, dispute link, escalation', async ({ page }) => {
  await blockApi(page);
  const res = await page.goto(`${BASE}/pengaduan/`);
  expect(res?.status()).toBe(200);
  await expect(page.locator('h1')).toHaveText('Layanan Pengaduan Konsumen');
  await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  await expect(page.locator('[data-prelaunch]')).toContainText('belum diluncurkan');

  // channels: in-app always; WhatsApp / e-mail come from PUBLIC_SUPPORT_* (unset in CI → honest "segera diumumkan")
  const channels = page.locator('[data-channels]');
  await expect(channels).toContainText('Bantuan → Pengaduan konsumen');
  for (const [ch, configured] of [['whatsapp', process.env.PUBLIC_SUPPORT_WHATSAPP], ['email', process.env.PUBLIC_SUPPORT_EMAIL]] as const) {
    const card = page.locator(`[data-channel="${ch}"]`);
    if (configured) await expect(card.locator('p a')).toHaveCount(1);
    else await expect(card).toContainText('Segera diumumkan');
  }

  // SLA table mirrors the versioned config defaults; complaints are HIGH priority
  for (const p of ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const) {
    await expect(page.locator(`[data-sla] tr[data-priority="${p}"] td.tnum`)).toHaveText(`${SLA[p]} jam`);
  }
  await expect(page.locator('[data-sla] tr[data-priority="HIGH"]')).toContainText('pengaduan');
  await expect(page.locator('ol.steps li')).toHaveCount(5);
  await expect(page.locator('ol.steps')).toContainText(`${SLA.HIGH} jam`);
  await expect(page.locator('main')).toContainText('Nomor transaksi (JK-…)');

  // in-app dispute flow for paid transactions
  const dispute = page.locator('[data-dispute]');
  await expect(dispute.locator(`a[href="${BASE}/bantuan/cara-membuka-dispute/"]`)).toHaveCount(1);
  await expect(dispute.locator(`a[href="${BASE}/app/transactions/"]`)).toHaveCount(1);

  // government escalation (Ditjen PKTN, Kemendag) + BPSK, with verification date and source
  const esc = page.locator('[data-escalation]');
  await expect(esc).toContainText('Direktorat Jenderal Perlindungan Konsumen dan Tertib Niaga');
  await expect(esc).toContainText('Kementerian Perdagangan');
  await expect(esc.locator('a[href="https://wa.me/6285311111010"]')).toHaveText('0853-1111-1010');
  await expect(esc.locator('a[href="mailto:pengaduan.konsumen@kemendag.go.id"]')).toHaveCount(1);
  await expect(esc.locator('a[href="tel:+62213441839"]')).toHaveCount(1);
  await expect(esc).toContainText('BPSK');
  await expect(esc).toContainText('diverifikasi pada 4 Oktober 2026');
  await expect(esc.locator('a[href^="https://ditjenpktn.kemendag.go.id/"]').first()).toBeVisible();

  // bilingual alternate + SEO
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute('href', 'https://antarkitaindonesia.com/jastipkita/en/complaints/');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://antarkitaindonesia.com/jastipkita/pengaduan/');
  const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((s) => JSON.parse(s));
  expect(ld.some((d) => d['@type'] === 'ContactPage')).toBe(true);
  // never asks for secrets
  await expect(page.locator('main')).toContainText('tidak pernah meminta PIN');
});

test('EN complaint page mirrors the content in English', async ({ page }) => {
  await blockApi(page);
  await page.goto(`${BASE}/en/complaints/`);
  await expect(page.locator('h1')).toHaveText('Consumer Complaints');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('[data-prelaunch]')).toContainText('has not launched');
  await expect(page.locator('[data-sla] tr[data-priority="HIGH"] td.tnum')).toHaveText(`${SLA.HIGH} hours`);
  await expect(page.locator('[data-escalation]')).toContainText('Ministry of Trade');
  await expect(page.locator('[data-escalation] a[href="https://wa.me/6285311111010"]')).toHaveCount(1);
  await expect(page.locator('link[rel="alternate"][hreflang="id-ID"]')).toHaveAttribute('href', 'https://antarkitaindonesia.com/jastipkita/pengaduan/');
});

test('complaint pages are linked from the home page footer (id + en) and the help center', async ({ page }) => {
  await blockApi(page);
  await page.goto(`${BASE}/`);
  await expect(page.locator(`footer a[data-footer-complaints][href="${BASE}/pengaduan/"]`)).toHaveText('Pengaduan konsumen');
  await page.goto(`${BASE}/en/`);
  await expect(page.locator(`footer a[data-footer-complaints][href="${BASE}/en/complaints/"]`)).toHaveText('Consumer complaints');
  await page.goto(`${BASE}/bantuan/`);
  await page.locator(`[data-help-complaints] a[href="${BASE}/pengaduan/"]`).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/pengaduan/$`));
});

test('sitemap lists both complaint pages', async ({ request }) => {
  const xml = await (await request.get(`${BASE}/sitemap-0.xml`)).text();
  expect(xml).toContain('https://antarkitaindonesia.com/jastipkita/pengaduan/');
  expect(xml).toContain('https://antarkitaindonesia.com/jastipkita/en/complaints/');
});
