import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, json, renderApp } from '../../test/utils';
import { mfaResetBlock } from '../users/RbacPage';
import { holdSource } from './PayoutsPage';
import RefundDestinationsPage, { refundDestinationBlock } from './RefundDestinationsPage';

const dest = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  refundId: `rf-${id}`,
  refundNumber: `RFD-260928-${id.toUpperCase()}`,
  transactionId: `tx-${id}`,
  buyerId: 'buyer-1',
  buyerDisplayName: 'Budi S.',
  bankCode: 'BCA',
  accountMask: '****0961',
  validationStatus: 'PENDING_REVIEW',
  nameMatch: 'MISMATCH',
  amountIdr: 2_450_000,
  createdAt: '2026-09-28T01:00:00Z',
  canReview: true,
  ...over,
});

describe('SEC-12 refund destination review', () => {
  it('pure rule: the buyer cannot review their own destination; decided rows are closed', () => {
    expect(refundDestinationBlock(dest('a', { canReview: false }) as never, null)).toMatch(/maker-checker/);
    expect(refundDestinationBlock(dest('b', { validationStatus: 'VALID' }) as never, null)).toMatch(/VALID/);
    expect(refundDestinationBlock(dest('c') as never, 'Butuh izin: refunds.approve')).toMatch(/refunds.approve/);
    expect(refundDestinationBlock(dest('d') as never, null)).toBeNull();
  });

  it('approves with MFA step-up and replays the review with the same Idempotency-Key', async () => {
    let attempts = 0;
    const { calls } = renderApp(<RefundDestinationsPage />, {
      roles: ['FINANCE'],
      meId: 'finance-1',
      mfaFresh: false,
      routes: [
        ['GET', '/v1/admin/refund-destinations', () => json({ data: [dest('d1'), dest('own', { canReview: false })], nextCursor: null })],
        [
          'POST',
          '/v1/admin/refund-destinations/d1/review',
          (req) => {
            attempts++;
            if (!req.headers.get('authorization')?.includes('mfa')) return apiError(403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan untuk aksi ini');
            return json({ id: 'd1', refundId: 'rf-d1', validationStatus: 'VALID' });
          },
        ],
        ['POST', '/v1/auth/mfa/verify', () => json({ accessToken: 'access-with-mfa', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), mfaAt: Math.floor(Date.now() / 1000), method: 'TOTP' })],
      ],
    });
    expect(await screen.findByTestId('approve-dest-own')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText('Tidak cocok dgn KYC').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('approve-dest-d1'));
    const dlg = within(await screen.findByRole('dialog', { name: /Setujui rekening refund RFD-260928-D1/ }));
    await userEvent.type(dlg.getByRole('textbox'), 'Rekening atas nama istri, dikonfirmasi tiket #88');
    await userEvent.click(dlg.getByTestId('confirm-action'));
    const mfa = within(await screen.findByRole('dialog', { name: 'Verifikasi MFA diperlukan' }));
    await userEvent.type(mfa.getByTestId('mfa-code'), '123456');
    await userEvent.click(mfa.getByRole('button', { name: /Verifikasi/ }));
    await waitFor(() => expect(attempts).toBe(2));
    const posts = calls.filter((c) => c.path === '/v1/admin/refund-destinations/d1/review');
    expect(posts[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1]!.headers.get('idempotency-key')).toBe(posts[0]!.headers.get('idempotency-key'));
    expect(JSON.parse(posts[1]!.body)).toEqual({ decision: 'APPROVE', note: 'Rekening atas nama istri, dikonfirmasi tiket #88' });
  });
});

describe('payout hold source', () => {
  it('distinguishes auto-released dispute holds, other system holds and manual holds', () => {
    expect(holdSource({ status: 'ON_HOLD', holdReason: 'DISPUTE_OPEN', heldBy: null })?.kind).toBe('SYSTEM_DISPUTE');
    expect(holdSource({ status: 'ON_HOLD', holdReason: 'RISK_REVIEW', heldBy: null })?.kind).toBe('SYSTEM');
    expect(holdSource({ status: 'ON_HOLD', holdReason: 'Cek manual', heldBy: 'finance-2' })?.kind).toBe('MANUAL');
    expect(holdSource({ status: 'SCHEDULED', holdReason: null, heldBy: null })).toBeNull();
  });
});

describe('SEC-13 MFA reset maker-checker', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    userId: 'admin-9',
    factorId: 'f1',
    reason: 'Ponsel hilang, identitas dikonfirmasi',
    requestedBy: 'admin-2',
    approvedBy: null,
    rejectedBy: null,
    status: 'PENDING',
    decisionNote: null,
    decidedAt: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  });
  it('requester, subject and expired requests cannot be approved', () => {
    expect(mfaResetBlock(req() as never, 'admin-2')).toMatch(/pengaju/);
    expect(mfaResetBlock(req() as never, 'admin-9')).toMatch(/sendiri/);
    expect(mfaResetBlock(req({ expiresAt: '2020-01-01T00:00:00Z' }) as never, 'admin-1')).toMatch(/kedaluwarsa/);
    expect(mfaResetBlock(req({ status: 'APPLIED' }) as never, 'admin-1')).toMatch(/APPLIED/);
    expect(mfaResetBlock(req() as never, 'admin-1')).toBeNull();
  });
});
