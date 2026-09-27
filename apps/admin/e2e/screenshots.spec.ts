/** Visual review screenshots (light & dark) → apps/admin/screenshots/. */
import { expect, test, type Page } from '@playwright/test';
import { TX_ID } from './fixtures';
import { installMockApi, signedIn } from './mock-api';

const SHOTS: { name: string; path: string; ready: (p: Page) => Promise<void> }[] = [
  { name: 'dashboard', path: '/', ready: async (p) => { await expect(p.getByTestId('kpi-gmv')).toContainText('Rp'); await expect(p.locator('.series-line').first()).toBeVisible(); } },
  { name: 'transaction-detail', path: `/transactions/${TX_ID}`, ready: async (p) => { await expect(p.locator('[data-line="TOTAL"]')).toBeVisible(); } },
  { name: 'transaction-ledger', path: `/transactions/${TX_ID}`, ready: async (p) => { await p.getByRole('tab', { name: /Ledger/ }).click(); await expect(p.getByText('Saldo per bucket')).toBeVisible(); } },
  { name: 'config-diff', path: '/config/pricing.platform_fee?tab=diff&version=3', ready: async (p) => { await expect(p.getByTestId('diff-table').first()).toContainText('rateBps'); } },
  { name: 'refund-destinations', path: '/refund-destinations', ready: async (p) => { await expect(p.getByText('RFD-260927-K4P9WZ')).toBeVisible(); } },
  { name: 'payouts', path: '/payouts', ready: async (p) => { await expect(p.getByTestId('hold-po-1')).toContainText('Otomatis · dispute'); } },
  { name: 'db-center', path: '/infra', ready: async (p) => { await expect(p.getByText('PostgreSQL 17.5', { exact: false })).toBeVisible(); await expect(p.getByText('REFUND_APPROVAL_BACKLOG')).toBeVisible(); } },
  { name: 'db-center-workflow', path: '/infra', ready: async (p) => { await p.getByRole('tab', { name: 'Workflow migrasi' }).click(); await expect(p.getByText('Migrasi skema (CI)')).toBeVisible(); } },
];

for (const scheme of ['light', 'dark'] as const) {
  for (const s of SHOTS) {
    test(`${s.name} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await signedIn(page);
      await installMockApi(page);
      await page.goto(s.path);
      await s.ready(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `screenshots/${s.name}-${scheme}.png`, fullPage: true });
    });
  }
}
