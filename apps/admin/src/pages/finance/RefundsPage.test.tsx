import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, json, renderApp } from '../../test/utils';
import RefundsPage, { refundApproveBlock } from './RefundsPage';

const refund = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  number: `RFD-260927-${id.toUpperCase()}`,
  transactionId: `tx-${id}`,
  transactionNumber: `JK-260927-${id.toUpperCase()}`,
  transactionStatus: 'REFUND_PENDING',
  paymentId: 'p1',
  channel: 'VA',
  sandbox: true,
  reasonCode: 'ADMIN',
  reasonNote: 'Barang rusak',
  amountIdr: 12_500_000,
  type: 'FULL',
  status: 'PENDING_APPROVAL',
  method: 'PROVIDER_REFUND',
  requestedBy: 'finance-2',
  approvedBy: null,
  canApprove: true,
  failureReason: null,
  attempts: 0,
  waitingHours: 30,
  createdAt: '2026-09-26T02:00:00Z',
  ...over,
});

describe('maker-checker button states', () => {
  it('pure rule: requester cannot approve, reason is explicit', () => {
    expect(refundApproveBlock(refund('a', { canApprove: false }) as never, null)).toMatch(/maker-checker/);
    expect(refundApproveBlock(refund('b') as never, null)).toBeNull();
    expect(refundApproveBlock(refund('c') as never, 'Butuh izin: refunds.approve')).toMatch(/refunds.approve/);
  });

  it('disables Approve (focusable, with reason) for the requester and enables it for another admin', async () => {
    renderApp(<RefundsPage />, {
      roles: ['FINANCE'],
      meId: 'finance-1',
      routes: [['GET', '/v1/admin/refunds', () => json({ data: [refund('own', { requestedBy: 'finance-1', canApprove: false }), refund('other')], nextCursor: null })]],
    });
    const own = await screen.findByTestId('approve-own');
    const other = screen.getByTestId('approve-other');
    expect(own).toHaveAttribute('aria-disabled', 'true');
    expect(own).toHaveAccessibleDescription(/pengaju refund ini .*maker-checker/i);
    expect(other).not.toHaveAttribute('aria-disabled');
    await userEvent.click(own);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('refund approval: MFA step-up + idempotency through the UI', () => {
  it('asks for TOTP on MFA_REQUIRED, verifies, and replays the approval with the same Idempotency-Key', async () => {
    let attempts = 0;
    const { calls } = renderApp(<RefundsPage />, {
      roles: ['FINANCE'],
      meId: 'finance-1',
      mfaFresh: false,
      routes: [
        ['GET', '/v1/admin/refunds', () => json({ data: [refund('r1')], nextCursor: null })],
        [
          'POST',
          '/v1/admin/refunds/r1/approve',
          (req) => {
            attempts++;
            if (!req.headers.get('authorization')?.includes('mfa')) return apiError(403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan untuk aksi ini');
            return json({ id: 'r1', status: 'PROCESSING', approvedBy: 'finance-1' });
          },
        ],
        ['POST', '/v1/auth/mfa/verify', async (req) => ((await req.json()) as { code: string }).code === '123456' ? json({ accessToken: 'access-with-mfa', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), mfaAt: Math.floor(Date.now() / 1000), method: 'TOTP' }) : apiError(400, 'MFA_CODE_INVALID', 'Kode salah')],
      ],
    });
    await userEvent.click(await screen.findByTestId('approve-r1'));
    const confirm = within(await screen.findByRole('dialog', { name: /Setujui refund RFD-260927-R1/ }));
    const keyHint = confirm.getByText(/Idempotency-Key/);
    await userEvent.click(confirm.getByTestId('confirm-action'));

    const mfa = within(await screen.findByRole('dialog', { name: 'Verifikasi MFA diperlukan' }));
    await userEvent.type(mfa.getByTestId('mfa-code'), '123456');
    await userEvent.click(mfa.getByRole('button', { name: /Verifikasi/ }));

    await waitFor(() => expect(attempts).toBe(2));
    const approvals = calls.filter((c) => c.path === '/v1/admin/refunds/r1/approve');
    expect(approvals).toHaveLength(2);
    const k1 = approvals[0]!.headers.get('idempotency-key');
    expect(k1).toMatch(/^[0-9a-f-]{36}$/);
    expect(approvals[1]!.headers.get('idempotency-key')).toBe(k1);
    expect(keyHint.textContent).toContain(k1!.slice(0, 8));
    expect(approvals[1]!.headers.get('authorization')).toBe('Bearer access-with-mfa');
    expect(await screen.findByText(/Refund disetujui · status PROCESSING/)).toBeInTheDocument();
  });
});
