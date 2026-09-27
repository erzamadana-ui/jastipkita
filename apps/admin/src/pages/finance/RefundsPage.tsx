import { useState } from 'react';
import { Link } from 'react-router';
import { Refunds } from '../../api/admin';
import type { RefundQueueItem } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Badge, Button, Callout, Card, Field, IdText, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatHours, formatIdr, humanize } from '../../lib/format';

/** Maker-checker: the API marks `canApprove=false` for the requester; the UI explains why. */
export function refundApproveBlock(r: RefundQueueItem, permReason: string | null): string | null {
  if (permReason) return permReason;
  if (r.status !== 'PENDING_APPROVAL') return `Status ${r.status}`;
  if (!r.canApprove) return 'Anda pengaju refund ini — persetujuan harus oleh admin lain (maker-checker)';
  return null;
}

export default function RefundsPage() {
  const [status, setStatus] = useState('PENDING_APPROVAL');
  const { query, rows, pagination } = useCursorQuery(['refunds', status], (cursor) => Refunds.queue({ status, cursor, limit: 25 }));
  const perm = useCan(CAP.refundApprove);
  const [dlg, setDlg] = useState<{ kind: 'approve' | 'reject'; r: RefundQueueItem } | null>(null);
  const approve = useAdminAction({
    run: (r: RefundQueueItem, key) => Refunds.approve(r.id, key),
    actionKey: (r) => `refund.approve:${r.id}`,
    invalidate: [['refunds'], ['transactions']],
    toastErrors: false,
    success: (res) => `Refund disetujui · status ${res.status}`,
  });
  const reject = useAdminAction({
    run: (v: { r: RefundQueueItem; reason: string }, key) => Refunds.reject(v.r.id, v.reason, key),
    actionKey: (v) => `refund.reject:${v.r.id}`,
    invalidate: [['refunds'], ['transactions']],
    toastErrors: false,
    success: (res) => res.note ?? 'Refund ditolak',
  });

  return (
    <div className="stack stack--lg">
      <PageHeader title="Persetujuan refund" subtitle="Refund di atas batas auto-approve menunggu persetujuan admin lain. Setiap aksi: MFA + Idempotency-Key." />
      <Card flush>
        <div className="filterbar">
          <Field label="Status">
            <Select value={status} onChange={setStatus} options={['PENDING_APPROVAL', 'REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED', 'SUCCEEDED', 'REJECTED', 'CANCELLED']} />
          </Field>
        </div>
        <DataTable
          caption="Antrean refund"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(r) => r.id}
          pagination={pagination}
          empty={{ title: 'Tidak ada refund pada status ini' }}
          columns={[
            { key: 'n', header: 'Refund', render: (r) => <span className="stack" style={{ gap: 0 }}><span className="cell-primary mono">{r.number}</span><Link to={`/transactions/${r.transactionId}`} className="cell-sub mono">{r.transactionNumber}</Link></span> },
            { key: 'reason', header: 'Alasan', render: (r) => <span className="stack" style={{ gap: 0 }}>{humanize(r.reasonCode)}<span className="cell-sub">{r.reasonNote}</span></span> },
            { key: 'a', header: 'Nominal', align: 'right', render: (r) => <Money value={r.amountIdr} emphasize />, sortValue: (r) => r.amountIdr },
            { key: 'ch', header: 'Kanal', render: (r) => <span className="row row--tight">{r.channel ?? '—'}{r.sandbox ? <Badge tone="warning">SANDBOX</Badge> : null}</span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'by', header: 'Pengaju', render: (r) => <IdText id={r.requestedBy} /> },
            { key: 'w', header: 'Menunggu', align: 'right', render: (r) => <span className={r.waitingHours > 24 ? 'badge badge--warning' : undefined}>{formatHours(r.waitingHours)}</span>, sortValue: (r) => r.waitingHours },
            {
              key: 'act',
              header: 'Aksi',
              render: (r) =>
                r.status === 'PENDING_APPROVAL' ? (
                  <span className="btn-group">
                    <Button size="sm" variant="success" mfa disabledReason={refundApproveBlock(r, perm.reason)} onClick={() => setDlg({ kind: 'approve', r })} data-testid={`approve-${r.id}`}>
                      Setujui
                    </Button>
                    <Button size="sm" variant="danger-outline" mfa disabledReason={perm.reason} onClick={() => setDlg({ kind: 'reject', r })}>
                      Tolak
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>
      <ActionDialog
        open={dlg?.kind === 'approve'}
        onClose={() => setDlg(null)}
        title={`Setujui refund ${dlg?.r.number ?? ''}`}
        description={dlg ? `${formatIdr(dlg.r.amountIdr)} ke penitip via ${humanize(dlg.r.method)} (${dlg.r.channel ?? '—'}). Processor berjalan segera setelah disetujui.` : undefined}
        confirmLabel={dlg ? `Setujui ${formatIdr(dlg.r.amountIdr)}` : 'Setujui'}
        tone="success"
        mfa
        reason={false}
        idempotencyKey={dlg?.kind === 'approve' ? approve.keyFor(dlg.r) : null}
        onConfirm={() => approve.mutateAsync(dlg!.r)}
      >
        {dlg?.r.sandbox ? <Callout tone="warning">Pembayaran asal berjalan di SANDBOX — refund tidak memindahkan uang sungguhan.</Callout> : null}
      </ActionDialog>
      <ActionDialog
        open={dlg?.kind === 'reject'}
        onClose={() => setDlg(null)}
        title={`Tolak refund ${dlg?.r.number ?? ''}`}
        description="Jurnal alokasi dibalik. Bila tidak ada refund lain yang terbuka, transaksi REFUND_PENDING perlu ditindaklanjuti."
        confirmLabel="Tolak refund"
        tone="danger"
        mfa
        idempotencyKey={dlg?.kind === 'reject' ? reject.keyFor({ r: dlg.r, reason: '' }) : null}
        onConfirm={(reason) => reject.mutateAsync({ r: dlg!.r, reason })}
      />
    </div>
  );
}
