/**
 * SEC-12 review queue: a buyer's refund bank destination whose holder name differs from the verified identity is stored
 * PENDING_REVIEW and the refund is paid only after FINANCE approves it (docs/api/admin.md §1, money.md).
 * APPROVE → VALID + refund processing resumes; REJECT → REJECTED + buyer asked for a new destination (new step-up OTP).
 * Maker-checker: the reviewer can never be the buyer (API `canReview`). Account numbers are never sent — mask only.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { RefundDestinations } from '../../api/admin';
import type { RefundDestinationItem } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Callout, Card, DateTime, Field, KeyValue, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatIdr } from '../../lib/format';

type Decision = 'APPROVE' | 'REJECT';

export function refundDestinationBlock(d: RefundDestinationItem, permReason: string | null): string | null {
  if (permReason) return permReason;
  if (d.validationStatus !== 'PENDING_REVIEW') return `Sudah diputuskan (${d.validationStatus})`;
  if (!d.canReview) return 'Rekening ini milik Anda sebagai pembeli — review harus oleh admin lain (maker-checker)';
  return null;
}

const STATUS_OPTIONS = [
  { value: 'PENDING_REVIEW', label: 'Menunggu review' },
  { value: 'VALID', label: 'Disetujui (VALID)' },
  { value: 'REJECTED', label: 'Ditolak' },
  { value: 'PENDING_REVIEW,VALID,REJECTED', label: 'Semua' },
];

export default function RefundDestinationsPage() {
  const [status, setStatus] = useState('PENDING_REVIEW');
  const q = useQuery({ queryKey: ['refund-destinations', status], queryFn: () => RefundDestinations.list(status) });
  const perm = useCan(CAP.refundDestinationReview);
  const [dlg, setDlg] = useState<{ decision: Decision; d: RefundDestinationItem } | null>(null);
  const review = useAdminAction({
    run: (v: { decision: Decision; d: RefundDestinationItem; note: string }, key) => RefundDestinations.review(v.d.id, { decision: v.decision, note: v.note }, key),
    actionKey: (v) => `refund-destination.${v.decision}:${v.d.id}`,
    invalidate: [['refund-destinations'], ['refunds'], ['transactions']],
    toastErrors: false,
    success: (r) => (r.validationStatus === 'VALID' ? 'Rekening disetujui · refund diproses' : 'Rekening ditolak · pembeli diminta rekening baru'),
  });

  return (
    <div className="stack stack--lg">
      <PageHeader
        title="Review rekening refund"
        subtitle="Nama pemilik rekening berbeda dari identitas terverifikasi pembeli. Refund baru dibayar setelah disetujui di sini. Setiap aksi: MFA + Idempotency-Key."
      />
      <Callout tone="info" icon="shield">
        Pembeli sudah lolos OTP step-up saat mengisi rekening; ketidakcocokan nama bisa sah (rekening pasangan/orang tua) atau tanda pengambilalihan akun.
        Periksa riwayat transaksi & tiket support pembeli sebelum menyetujui. Nomor rekening tidak pernah ditampilkan — hanya mask.
      </Callout>
      <Card flush>
        <div className="filterbar">
          <Field label="Status">
            <Select value={status} onChange={setStatus} options={STATUS_OPTIONS} />
          </Field>
        </div>
        <DataTable
          caption="Rekening refund untuk review"
          rows={q.data?.data}
          loading={q.isPending}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(d) => d.id}
          empty={{ title: status === 'PENDING_REVIEW' ? 'Tidak ada rekening yang menunggu review' : 'Tidak ada data' }}
          columns={[
            {
              key: 'r',
              header: 'Refund',
              render: (d) => (
                <span className="stack" style={{ gap: 0 }}>
                  <span className="cell-primary mono nowrap">{d.refundNumber ?? d.refundId.slice(0, 8)}</span>
                  <Link className="cell-sub" to={`/transactions/${d.transactionId}`}>
                    Buka transaksi
                  </Link>
                </span>
              ),
            },
            { key: 'b', header: 'Pembeli', render: (d) => <Link className="nowrap" to={`/users/${d.buyerId}`}>{d.buyerDisplayName ?? d.buyerId.slice(0, 8)}</Link> },
            { key: 'acc', header: 'Rekening tujuan', render: (d) => <span className="mono">{d.bankCode} {d.accountMask}</span> },
            { key: 'm', header: 'Nama', render: (d) => (d.nameMatch && d.nameMatch !== 'MATCH' ? <Badge tone="warning">{d.nameMatch === 'MISMATCH' ? 'Tidak cocok dgn KYC' : d.nameMatch}</Badge> : <span className="muted">{d.nameMatch ?? '—'}</span>) },
            { key: 'amt', header: 'Nominal refund', align: 'right', render: (d) => <Money value={d.amountIdr} emphasize />, sortValue: (d) => d.amountIdr },
            { key: 's', header: 'Status', render: (d) => <StatusBadge status={d.validationStatus} /> },
            { key: 'c', header: 'Diajukan', render: (d) => <DateTime value={d.createdAt} relative />, sortValue: (d) => d.createdAt },
            {
              key: 'act',
              header: 'Aksi',
              render: (d) =>
                d.validationStatus === 'PENDING_REVIEW' ? (
                  <span className="btn-group" style={{ flexWrap: 'nowrap' }}>
                    <Button size="sm" variant="success" mfa disabledReason={refundDestinationBlock(d, perm.reason)} onClick={() => setDlg({ decision: 'APPROVE', d })} data-testid={`approve-dest-${d.id}`}>
                      Setujui
                    </Button>
                    <Button size="sm" variant="danger-outline" mfa disabledReason={refundDestinationBlock(d, perm.reason)} onClick={() => setDlg({ decision: 'REJECT', d })} data-testid={`reject-dest-${d.id}`}>
                      Tolak
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>
      <ActionDialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg ? `${dlg.decision === 'APPROVE' ? 'Setujui' : 'Tolak'} rekening refund ${dlg.d.refundNumber ?? ''}`.trim() : ''}
        description={
          dlg?.decision === 'APPROVE'
            ? 'Status → VALID dan refund langsung diproses ke rekening ini. Tidak dapat dibatalkan dari admin.'
            : 'Status → REJECTED. Pembeli menerima notifikasi untuk mengisi rekening baru (dengan OTP step-up baru); refund tetap tertahan.'
        }
        confirmLabel={dlg ? (dlg.decision === 'APPROVE' ? `Setujui & bayar ${formatIdr(dlg.d.amountIdr)}` : 'Tolak rekening') : ''}
        tone={dlg?.decision === 'APPROVE' ? 'success' : 'danger'}
        mfa
        reason={{ label: 'Catatan review (tercatat di audit)', minLength: 5, placeholder: 'mis. rekening atas nama suami, dikonfirmasi lewat tiket #…' }}
        idempotencyKey={dlg ? review.keyFor({ ...dlg, note: '' }) : null}
        onConfirm={(note) => review.mutateAsync({ ...dlg!, note })}
      >
        {dlg ? (
          <KeyValue
            items={[
              ['Rekening', <span className="mono">{`${dlg.d.bankCode} ${dlg.d.accountMask}`}</span>],
              ['Pembeli', dlg.d.buyerDisplayName ?? dlg.d.buyerId],
              ['Nominal', <Money value={dlg.d.amountIdr} emphasize />],
            ]}
          />
        ) : null}
      </ActionDialog>
    </div>
  );
}
