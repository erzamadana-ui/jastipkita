import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '../../test/utils';
import { payoutBlock } from '../finance/PayoutsPage';
import { trustApproveBlock } from '../risk/TrustPage';
import ConfigKeyPage, { clientValidate, configApproveBlock } from './ConfigKeyPage';

const version = (v: number, status: string, createdBy: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  id: `cfg-${v}`,
  key: 'pricing.platform_fee',
  version: v,
  value,
  status,
  effectiveFrom: '2026-09-01T00:00:00Z',
  changeReason: v === 1 ? 'seed' : 'Turunkan platform fee untuk kampanye Q4',
  isAssumption: false,
  notes: null,
  createdBy,
  approvedBy: status === 'ACTIVE' ? 'sa-1' : null,
  approvedAt: null,
  rejectedReason: null,
  supersededAt: null,
  createdAt: '2026-09-20T00:00:00Z',
  diffFromActive: [],
  ...extra,
});

function detail(proposer: string) {
  const active = { rateBps: 500, minIdr: 10000, maxIdr: 750000 };
  return {
    key: 'pricing.platform_fee',
    active: version(1, 'ACTIVE', 'seed', active),
    history: [version(2, 'PENDING_APPROVAL', proposer, { ...active, rateBps: 450 }, { diffFromActive: [{ path: 'rateBps', op: 'changed', before: 500, after: 450 }] }), version(1, 'ACTIVE', 'seed', active)],
  };
}

describe('maker-checker: business config approval', () => {
  it('disables approval for the proposer with an explanation', async () => {
    renderApp(<ConfigKeyPage />, { roles: ['FINANCE_SUPER_ADMIN'], meId: 'fsa-1', path: '/config/:key', route: '/config/pricing.platform_fee', routes: [['GET', '/v1/admin/config/pricing.platform_fee', () => json(detail('fsa-1'))]] });
    const btn = await screen.findByTestId('config-approve');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription(/pengusul versi ini/);
    expect(screen.getByTestId('diff-table')).toHaveTextContent('rateBps');
  });

  it('enables approval for a different admin holding config.approve, and not for one without it', async () => {
    const { unmount } = renderApp(<ConfigKeyPage />, { roles: ['FINANCE_SUPER_ADMIN'], meId: 'fsa-2', path: '/config/:key', route: '/config/pricing.platform_fee', routes: [['GET', '/v1/admin/config/pricing.platform_fee', () => json(detail('fsa-1'))]] });
    expect(await screen.findByTestId('config-approve')).not.toHaveAttribute('aria-disabled');
    unmount();
    renderApp(<ConfigKeyPage />, { roles: ['MARKETING'], meId: 'mkt-1', path: '/config/:key', route: '/config/pricing.platform_fee', routes: [['GET', '/v1/admin/config/pricing.platform_fee', () => json(detail('fsa-1'))]] });
    const btn = await screen.findByTestId('config-approve');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription(/config\.approve/);
  });

  it('pure rules for other maker-checker flows', () => {
    const v = version(3, 'PENDING_APPROVAL', 'a', {}) as never;
    expect(configApproveBlock(v, 'a', null)).toMatch(/maker-checker/);
    expect(configApproveBlock(v, 'b', null)).toBeNull();
    const payout = { status: 'ON_HOLD', canRelease: false } as never;
    expect(payoutBlock(payout, 'release', null)).toMatch(/menahan payout ini/);
    expect(payoutBlock({ status: 'ON_HOLD', canRelease: true } as never, 'release', null)).toBeNull();
    const o = { status: 'PENDING', requestedBy: 'r1', userId: 'u1', canApprove: true } as never;
    expect(trustApproveBlock(o, 'u1', null)).toMatch(/milik sendiri/);
    expect(trustApproveBlock(o, 'r1', null)).toMatch(/pengaju/);
    expect(trustApproveBlock(o, 'x', null)).toBeNull();
  });

  it('validates proposals client-side with the same core validator as the API', () => {
    expect(clientValidate('pricing.platform_fee', { rateBps: 500, minIdr: 10000, maxIdr: 750000 })).toEqual([]);
    expect(clientValidate('pricing.platform_fee', { rateBps: -1, minIdr: 10000, maxIdr: 750000 }).length).toBeGreaterThan(0);
    expect(clientValidate('nope.key', {})).toHaveLength(1);
  });
});
