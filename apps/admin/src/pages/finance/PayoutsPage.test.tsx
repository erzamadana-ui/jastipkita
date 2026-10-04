import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '../../test/utils';
import PayoutsPage, { payoutCooldown } from './PayoutsPage';

const future = new Date(Date.now() + 20 * 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();

const payout = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  number: `PO-261004-${id.toUpperCase().padEnd(6, '0').slice(0, 6)}`,
  travelerId: `trav-${id}`,
  travelerDisplayName: 'Dimas P.',
  transactionId: `tx-${id}`,
  transactionNumber: `JK-261004-${id.toUpperCase().padEnd(6, '0').slice(0, 6)}`,
  amountIdr: 650_000,
  feeIdr: 0,
  netIdr: 650_000,
  status: 'SCHEDULED',
  holdReason: null,
  heldBy: null,
  heldAt: null,
  releasedBy: null,
  releasedAt: null,
  transactionHoldReason: null,
  scheduledFor: future,
  cooldownUntil: null,
  paidAt: null,
  provider: 'MOCK',
  sandbox: true,
  failureReason: null,
  attempts: 0,
  destination: { bankCode: 'BCA', accountMask: '****0002', verificationStatus: 'VERIFIED' },
  canRelease: false,
  createdAt: '2026-10-04T01:00:00Z',
  ...over,
});

describe('new payout account cooldown (2026-10-04)', () => {
  it('pure rule: shown only for pending payouts whose cooldown is still running', () => {
    const now = new Date();
    expect(payoutCooldown({ status: 'SCHEDULED', cooldownUntil: future }, now)?.until).toBe(future);
    expect(payoutCooldown({ status: 'ON_HOLD', cooldownUntil: future }, now)).not.toBeNull();
    expect(payoutCooldown({ status: 'SCHEDULED', cooldownUntil: past }, now)).toBeNull();
    expect(payoutCooldown({ status: 'PAID', cooldownUntil: future }, now)).toBeNull();
    expect(payoutCooldown({ status: 'SCHEDULED', cooldownUntil: null }, now)).toBeNull();
    // older API builds without the field
    expect(payoutCooldown({ status: 'SCHEDULED' }, now)).toBeNull();
  });

  it('the payout list flags payouts waiting for a new destination account', async () => {
    renderApp(<PayoutsPage />, {
      roles: ['FINANCE'],
      routes: [['GET', '/v1/admin/payouts', () => json({ data: [payout('cool', { cooldownUntil: future }), payout('norm')], nextCursor: null })]],
    });
    const badge = await screen.findByTestId('cooldown-cool');
    expect(within(badge).getByText('Jeda rekening baru')).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', expect.stringMatching(/masa jeda/));
    expect(badge.querySelector('time')).toHaveAttribute('dateTime', future);
    expect(screen.queryByTestId('cooldown-norm')).toBeNull();
  });
});
