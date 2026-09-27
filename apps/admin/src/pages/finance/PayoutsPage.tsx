import { useState } from 'react';
import { Link } from 'react-router';
import { Payouts } from '../../api/admin';
import type { PayoutItem } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Badge, Button, Callout, Card, DateTime, Field, IdText, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatIdr } from '../../lib/format';

type Kind = 'hold' | 'release' | 'retry';

export function payoutBlock(p: PayoutItem, kind: Kind, permReason: string | null): string | null {
  if (permReason) return permReason;
  if (kind === 'hold') return ['SCHEDULED', 'FAILED'].includes(p.status) ? null : `Hanya SCHEDULED/FAILED (status ${p.status})`;
  if (kind === 'retry') return p.status === 'FAILED' ? null : 'Hanya payout FAILED';
  if (p.status !== 'ON_HOLD') return 'Payout tidak sedang ditahan';
  if (!p.canRelease) return 'Anda yang menahan payout ini — pelepasan harus oleh admin lain (maker-checker)';
  return null;
}

export default function PayoutsPage() {
  const [status, setStatus] = useState('ON_HOLD');
  const { query, rows, pagination } = useCursorQuery(['payouts', status], (cursor) => Payouts.list({ status: status || undefined, cursor, limit: 25 }));
  const perm = useCan(CAP.payouts);
  const [dlg, setDlg] = useState<{ kind: Kind; p: PayoutItem } | null>(null);
  const run = useAdminAction({
    run: (v: { kind: Kind; p: PayoutItem; text: string }, key) => (v.kind === 'hold' ? Payouts.hold(v.p.id, v.text, key) : v.kind === 'release' ? Payouts.release(v.p.id, v.text, key) : Payouts.retry(v.p.id, v.text, key)),
    actionKey: (v) => `payout.${v.kind}:${v.p.id}`,
    invalidate: [['payouts'], ['transactions']],
    toastErrors: false,
    success: (r) => `Payout → ${r.status}${'warnings' in r && Array.isArray(r.warnings) && r.warnings.length ? ` · ${r.warnings.join('; ')}` : ''}`,
  });
  const titles: Record<Kind, string> = { hold: 'Tahan payout', release: 'Lepas hold payout', retry: 'Coba ulang payout' };

  return (
    <div className="stack stack--lg">
      <PageHeader title="Payout traveler" subtitle="Hold → release adalah maker-checker (pelepas ≠ penahan, juga dijaga DB). Rekening tujuan hanya mask." />
      <Card flush>
        <div className="filterbar">
          <Field label="Status">
            <Select value={status} onChange={setStatus} placeholder="Semua" options={['SCHEDULED', 'ON_HOLD', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED']} />
          </Field>
        </div>
        <DataTable
          caption="Payout"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(p) => p.id}
          pagination={pagination}
          empty={{ title: 'Tidak ada payout pada status ini' }}
          columns={[
            { key: 'n', header: 'Payout', render: (p) => <span className="stack" style={{ gap: 0 }}><span className="cell-primary mono">{p.number}</span>{p.transactionId ? <Link className="cell-sub mono" to={`/transactions/${p.transactionId}`}>{p.transactionNumber}</Link> : null}</span> },
            { key: 't', header: 'Traveler', render: (p) => <Link to={`/users/${p.travelerId}`}>{p.travelerDisplayName ?? p.travelerId}</Link> },
            { key: 'd', header: 'Tujuan', render: (p) => <span className="stack" style={{ gap: 0 }}><span className="mono">{p.destination.bankCode} {p.destination.accountMask}</span><span className="cell-sub">{p.destination.verificationStatus}</span></span> },
            { key: 'net', header: 'Neto', align: 'right', render: (p) => <Money value={p.netIdr} emphasize />, sortValue: (p) => p.netIdr },
            { key: 's', header: 'Status', render: (p) => <span className="row row--tight"><StatusBadge status={p.status} />{p.sandbox ? <Badge tone="warning">SANDBOX</Badge> : null}</span> },
            { key: 'h', header: 'Hold', render: (p) => (p.holdReason || p.transactionHoldReason ? <span className="stack" style={{ gap: 0 }}><span className="small">{p.holdReason ?? '—'}</span><span className="cell-sub">oleh <IdText id={p.heldBy} /> {p.transactionHoldReason ? `· tx: ${p.transactionHoldReason}` : ''}</span></span> : <span className="muted">—</span>) },
            { key: 'sch', header: 'Jadwal', render: (p) => <DateTime value={p.scheduledFor} /> },
            {
              key: 'act',
              header: 'Aksi',
              render: (p) => (
                <span className="btn-group">
                  {p.status === 'ON_HOLD' ? (
                    <Button size="sm" variant="success" mfa disabledReason={payoutBlock(p, 'release', perm.reason)} onClick={() => setDlg({ kind: 'release', p })}>
                      Lepas hold
                    </Button>
                  ) : null}
                  {['SCHEDULED', 'FAILED'].includes(p.status) ? (
                    <Button size="sm" variant="danger-outline" mfa disabledReason={payoutBlock(p, 'hold', perm.reason)} onClick={() => setDlg({ kind: 'hold', p })}>
                      Tahan
                    </Button>
                  ) : null}
                  {p.status === 'FAILED' ? (
                    <Button size="sm" mfa disabledReason={payoutBlock(p, 'retry', perm.reason)} onClick={() => setDlg({ kind: 'retry', p })}>
                      Coba ulang
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </Card>
      <ActionDialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg ? `${titles[dlg.kind]} ${dlg.p.number}` : ''}
        description={
          dlg?.kind === 'release'
            ? 'ON_HOLD → SCHEDULED. Ditolak bila review risiko transaksi masih terbuka (RISK_REVIEW_OPEN). Hold transaksi dibersihkan.'
            : dlg?.kind === 'hold'
              ? 'SCHEDULED/FAILED → ON_HOLD, penahan dicatat (pelepas harus admin lain).'
              : 'FAILED → SCHEDULED sekarang, anggaran retry sistem di-reset.'
        }
        confirmLabel={dlg ? `${titles[dlg.kind]} ${formatIdr(dlg.p.netIdr)}` : ''}
        tone={dlg?.kind === 'hold' ? 'danger' : 'success'}
        mfa
        reason={{ label: dlg?.kind === 'hold' ? 'Alasan hold' : 'Catatan', minLength: 5 }}
        idempotencyKey={dlg ? run.keyFor({ ...dlg, text: '' }) : null}
        onConfirm={(text) => run.mutateAsync({ ...dlg!, text })}
      >
        {dlg?.p.transactionHoldReason && dlg.kind === 'release' ? <Callout tone="warning">Transaksi punya payout hold: {dlg.p.transactionHoldReason}</Callout> : null}
      </ActionDialog>
    </div>
  );
}
