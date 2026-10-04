import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '../../test/utils';
import { AuditCheckpointCard } from './InfraPage';

const base = {
  checkedAt: '2026-10-04T03:00:00.000Z',
  durationMs: 12,
  checkpoint: {
    id: 1,
    day: '2026-10-04',
    lastId: 120,
    lastHash: 'ab'.repeat(32),
    rowCount: 120,
    headUpdatedAt: '2026-10-04T00:00:00.000Z',
    createdAt: '2026-10-04T00:01:00.000Z',
    ageSec: 3600,
    storageKey: 'audit-checkpoints/2026/10/04.json',
    storageMode: 'MOCK',
    objectSha256: 'cd'.repeat(32),
  },
  anchor: { hashMatches: true, rowCountMatches: true, actualRowCount: 120 },
  segment: { fromId: 121, toId: 135, rowsSinceCheckpoint: 15, brokenAtId: null },
  head: { lastId: 135, lastHash: 'ef'.repeat(32), updatedAt: '2026-10-04T02:59:00.000Z' },
  history: { checkpoints: 1, mismatched: [] },
  storage: { status: 'MATCH', mode: 'MOCK', key: 'audit-checkpoints/2026/10/04.json', error: null },
  findings: [],
  warnings: [],
  recent: [{ day: '2026-10-04', lastId: 120, rowCount: 120, createdAt: '2026-10-04T00:01:00.000Z', storageKey: 'audit-checkpoints/2026/10/04.json', storageMode: 'MOCK' }],
  note: 'Checkpoint harian.',
};

describe('audit checkpoint card (DB & Infra Center)', () => {
  it('shows the latest checkpoint, the verified segment and the storage object status', async () => {
    renderApp(<AuditCheckpointCard />, { roles: ['SUPER_ADMIN'], routes: [['GET', '/v1/admin/infra/audit/checkpoints/verify', () => json({ status: 'OK', ...base })]] });
    expect(await screen.findByText('#120 / 120')).toBeInTheDocument();
    expect(screen.getAllByText('2026-10-04').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Objek cocok')).toBeInTheDocument();
    expect(screen.getByText('#121 … #135')).toBeInTheDocument();
    expect(screen.queryByText(/insiden keamanan/)).not.toBeInTheDocument();
  });

  it('a broken chain is shown as an incident with every finding', async () => {
    const broken = {
      status: 'BROKEN',
      ...base,
      anchor: { hashMatches: false, rowCountMatches: true, actualRowCount: 120 },
      storage: { ...base.storage, status: 'MISMATCH' },
      findings: ['Hash baris audit #120 berbeda dengan checkpoint 2026-10-04 (rantai ditulis ulang).'],
    };
    renderApp(<AuditCheckpointCard />, { roles: ['SUPER_ADMIN'], routes: [['GET', '/v1/admin/infra/audit/checkpoints/verify', () => json(broken)]] });
    expect(await screen.findByText(/insiden keamanan/)).toBeInTheDocument();
    expect(screen.getByText(/rantai ditulis ulang/)).toBeInTheDocument();
    expect(screen.getByText('Objek TIDAK cocok')).toBeInTheDocument();
    expect(screen.getByText('tidak cocok')).toBeInTheDocument();
  });
});
