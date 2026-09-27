import { expect, test } from '@playwright/test';
import { NOW } from './fixtures';
import { installMockApi } from './mock-api';

test('login → dashboard → approve refund with MFA step-up → config propose & approve', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.clock.setFixedTime(NOW);
  const { state } = await installMockApi(page);

  // --- login: e-mail OTP + TOTP gate
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Masuk ke Admin' })).toBeVisible();
  await page.getByTestId('login-email').fill('rina.ops@jastipkita.id');
  await page.getByTestId('login-request').click();
  await expect(page.getByText(/OTP_DEV_ECHO aktif/)).toBeVisible();
  await page.getByTestId('login-code').fill('424242');
  await page.getByTestId('login-verify').click();
  await expect(page.getByRole('heading', { name: 'Verifikasi TOTP' })).toBeVisible();
  await page.getByTestId('login-totp').fill('123456');
  await page.getByTestId('login-totp-submit').click();

  // --- dashboard
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('kpi-gmv')).toContainText('Rp');
  await expect(page.getByTestId('kpi-customsVarianceRatio')).toContainText('Sampel kecil');
  await expect(page.getByTestId('env-ribbon')).toContainText('SANDBOX');
  await expect(page.getByTestId('env-ribbon')).toContainText('payments SANDBOX');
  await expect(page.getByTestId('mfa-status')).toContainText('MFA aktif');
  // keyboard: definition tooltip is reachable
  await page.getByRole('button', { name: 'Definisi GMV' }).focus();
  await expect(page.getByRole('tooltip').filter({ hasText: 'ITEM_PRICE' })).toBeVisible();

  // --- refunds: maker-checker + MFA step-up + idempotent replay
  await page.getByRole('link', { name: 'Persetujuan refund' }).click();
  await expect(page.getByRole('heading', { name: 'Persetujuan refund' })).toBeVisible();
  await expect(page.getByTestId('approve-rf-2')).toHaveAttribute('aria-disabled', 'true');
  state.forceMfaStale = true; // server clock: step-up older than 15 min
  await page.getByTestId('approve-rf-1').click();
  const confirm = page.getByRole('dialog', { name: /Setujui refund RFD-260926-8F3K2Q/ });
  await expect(confirm).toContainText('Rp 12.450.000');
  await confirm.getByTestId('confirm-action').click();
  const mfa = page.getByRole('dialog', { name: 'Verifikasi MFA diperlukan' });
  await expect(mfa).toBeVisible();
  await mfa.getByTestId('mfa-code').fill('123456');
  await mfa.getByRole('button', { name: /Verifikasi/ }).click();
  await expect(page.getByText(/Refund disetujui · status PROCESSING/)).toBeVisible();
  const keys = state.idempotencyKeys['/v1/admin/refunds/rf-1/approve'] ?? [];
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(page.getByTestId('approve-rf-1')).toHaveCount(0);

  // --- config: propose a new version (form generated from the value) → pending, maker-checker blocks self-approval
  await page.getByRole('link', { name: 'Business config' }).click();
  await page.getByRole('row', { name: /Buka config dispute\.sla/ }).click();
  await page.getByRole('tab', { name: 'Ajukan versi baru' }).click();
  await page.locator('input[data-path="reviewHours"]').fill('96');
  await expect(page.getByRole('region', { name: /Pratinjau perubahan \(1\)/ })).toContainText('reviewHours');
  await page.getByTestId('config-reason').fill('Percepat SLA review dispute menjadi 4 hari');
  await page.getByTestId('config-propose').click();
  await expect(page.getByText(/Usulan v2 dibuat/)).toBeVisible();
  await expect(page.getByTestId('config-approve')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('config-approve')).toHaveAttribute('title', /pengusul/);

  // --- config: approve another admin's proposal. A full reload re-creates the access token through the refresh
  // token, which (API rule) drops mfa_at → the approval asks for a new step-up.
  await page.goto('/config/pricing.platform_fee');
  await expect(page.getByTestId('diff-table').first()).toContainText('rateBps');
  await expect(page.getByTestId('mfa-status')).toContainText('MFA perlu verifikasi');
  await page.getByTestId('config-approve').click();
  const dlg = page.getByRole('dialog', { name: /Setujui & aktifkan pricing\.platform_fee v3/ });
  await dlg.getByTestId('confirm-action').click();
  const mfa2 = page.getByRole('dialog', { name: 'Verifikasi MFA diperlukan' });
  await mfa2.getByTestId('mfa-code').fill('123456');
  await mfa2.getByRole('button', { name: /Verifikasi/ }).click();
  await expect(page.getByText(/pricing\.platform_fee v3 → ACTIVE/)).toBeVisible();
  await expect(page.getByText('Aktif v3')).toBeVisible();
  expect(state.mfaPrompts).toBe(3);

  expect(state.unmatched).toEqual([]);
  expect(errors.filter((e) => !/status of 40[0-9]/.test(e))).toEqual([]);
});

test('permission-aware nav, keyboard table rows and dialog focus trap', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await installMockApi(page);
  await page.addInitScript(() => {
    window.sessionStorage.setItem('jk_admin_rt', 'rt-seed');
    window.sessionStorage.setItem('jk_admin_mfa_gate', '1');
  });
  await page.goto('/transactions');
  await expect(page.getByRole('heading', { name: 'Transaksi' })).toBeVisible();
  const row = page.getByRole('row', { name: /Buka transaksi JK-260921-7KQ2MD/ });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'JK-260921-7KQ2MD' })).toBeVisible();
  await expect(page.locator('[data-line="TOTAL"]')).toContainText('Rp 8.963.461');
  await page.getByTestId('tx-refund').click();
  const dialog = page.getByRole('dialog', { name: /Refund admin/ });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('tx-refund')).toBeFocused();
});
