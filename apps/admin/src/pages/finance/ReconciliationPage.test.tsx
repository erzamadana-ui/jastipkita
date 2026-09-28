import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '../../test/utils';
import ReconciliationPage, { runTone } from './ReconciliationPage';

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  provider: 'MOCK',
  sandbox: true,
  periodStart: '2026-09-26T17:00:00.000Z',
  periodEnd: '2026-09-27T17:00:00.000Z',
  status: 'COMPLETED_WITH_DIFFS',
  payments: 12,
  mismatches: 1,
  internalCapturedIdr: 9_900_000,
  providerSecuredIdr: 10_000_000,
  openItems: 1,
  resolvedItems: 0,
  manual: false,
  error: null,
  startedAt: '2026-09-27T17:30:00.000Z',
  finishedAt: '2026-09-27T17:30:05.000Z',
  ...over,
});
const item = {
  id: 'i1',
  itemType: 'PAYMENT',
  internalRef: 'p1',
  providerRef: 'mock_1',
  transactionId: 'tx1',
  transactionNumber: 'JK-260927-AAAA',
  channel: 'VA',
  internalAmountIdr: 400_000,
  providerAmountIdr: 500_000,
  diffIdr: 100_000,
  status: 'MISMATCH',
  resolutionNote: null,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: '2026-09-27T17:30:01.000Z',
};

describe('reconciliation page', () => {
  it('run tone reflects open differences', () => {
    expect(runTone({ status: 'COMPLETED_WITH_DIFFS', openItems: 2 })).toBe('warning');
    expect(runTone({ status: 'COMPLETED_WITH_DIFFS', openItems: 0 })).toBe('success');
    expect(runTone({ status: 'FAILED', openItems: 0 })).toBe('danger');
  });

  it('lists runs, opens items and resolves a difference with a note', async () => {
    let resolved: unknown = null;
    let itemQuery = '';
    renderApp(<ReconciliationPage />, {
      roles: ['FINANCE'],
      routes: [
        ['GET', '/v1/admin/reconciliation/runs', () => json({ data: [run('r1')], nextCursor: null })],
        [
          'GET',
          '/v1/admin/reconciliation/runs/r1/items',
          (_req, url) => {
            itemQuery = url.searchParams.get('status') ?? '';
            return json({ data: [item], nextCursor: null });
          },
        ],
        [
          'POST',
          '/v1/admin/reconciliation/items/i1/resolve',
          async (req) => {
            resolved = await req.json();
            return json({ id: 'i1', runId: 'r1', status: 'RESOLVED', previousStatus: 'MISMATCH' });
          },
        ],
      ],
    });
    expect(await screen.findByText('SANDBOX')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lihat item' }));
    expect(await screen.findByText('JK-260927-AAAA')).toBeInTheDocument();
    expect(itemQuery).toBe('MISMATCH,MISSING_INTERNAL,MISSING_PROVIDER');
    await userEvent.click(screen.getByRole('button', { name: /Tandai selesai/ }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Tandai selisih selesai' }));
    await userEvent.type(dlg.getByRole('textbox'), 'Selisih biaya kanal VA, jurnal penyesuaian dibuat');
    await userEvent.click(dlg.getByTestId('confirm-action'));
    await waitFor(() => expect(resolved).toEqual({ note: 'Selisih biaya kanal VA, jurnal penyesuaian dibuat' }));
  });

  it('SUPPORT-like roles without payouts.manage see the resolve action disabled', async () => {
    renderApp(<ReconciliationPage />, {
      roles: ['RISK'],
      routes: [['GET', '/v1/admin/reconciliation/runs', () => json({ data: [], nextCursor: null })]],
    });
    const btn = await screen.findByRole('button', { name: /Jalankan manual/ });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
  });
});
