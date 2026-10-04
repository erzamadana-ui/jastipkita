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
import { formatIdr, humanize } from '../../lib/format';
import type { Tone } from '../../lib/status';

type Kind = 'hold' | 'release' | 'retry';

export function payoutBlock(p: PayoutItem, kind: Kind, permReason: string | null): string | null {
  if (permReason) return permReason;
  if (kind === 'hold') return ['SCHEDULED', 'FAILED'].includes(p.status) ? null : `Hanya SCHEDULED/FAILED (status ${p.status})`;
  if (kind === 'retry') return p.status === 'FAILED' ? null : 'Hanya payout FAILED';
  if (p.status !== 'ON_HOLD') return 'Payout tidak sedang ditahan';
  if (!p.canRelease) return 'Anda yang menahan payout ini — pelepasan harus oleh admin lain (maker-checker)';
  return null;
}

export interface HoldSource {
  kind: 'SYSTEM_DISPUTE' | 'SYSTEM' | 'MANUAL';
  label: string;
  tone: Tone;
  note: string;
}

/**
 * Where a hold comes from: holds placed by the payout job because a dispute is open (`hold_reason = DISPUTE_OPEN`,
 * no `heldBy`) are released automatically once the dispute is CLOSED and no risk review is open (money.md §5.2);
 * other system holds and manual holds need a FINANCE release (maker-checker for manual ones).
 */
export function holdSource(p: Pick<PayoutItem, 'status' | 'holdReason' | 'heldBy'>): HoldSource | null {
  if (!p.holdReason && p.status !== 'ON_HOLD') return null;
  if (p.heldBy) return { kind: 'MANUAL', label: 'Manual', tone: 'neutral', note: 'Pelepas harus admin lain (maker-checker)' };
  if (p.holdReason === 'DISPUTE_OPEN') return { kind: 'SYSTEM_DISPUTE', label: 'Otomatis · dispute', tone: 'info', note: 'Lepas otomatis setelah dispute CLOSED & tanpa review risiko' };
  return { kind: 'SYSTEM', label: 'Otomatis · sistem', tone: 'warning', note: 'Perlu dilepas manual oleh FINANCE' };
}

/**
 * New payout account cooldown (money.md §5.7): a destination added / verified / made default less than
 * money.policy.newPayoutAccountCooldownHours ago receives nothing before `cooldownUntil` (the processor re-checks it).
 */
export function payoutCooldown(p: Pick<PayoutItem, 'status' | 'cooldownUntil'>, now: Date = new Date()): { until: string; note: string } | null {
  if (!p.cooldownUntil || !['SCHEDULED', 'ON_HOLD', 'FAILED'].includes(p.status)) return null;
  if (Date.parse(p.cooldownUntil) <= now.getTime()) return null;
  return { until: p.cooldownUntil, note: 'Rekening tujuan baru ditambahkan/diverifikasi/dijadikan utama — payout menunggu masa jeda (anti pengambilalihan akun)' };
}

export default function PayoutsPage() {
  const [status, setStatus] = useState('ON_HOLD');
  const { query, rows, pagination } = useCursorQuery(['payouts', status], (cursor) => Payouts.list({ status: status || undefined, cursor, limit: 25 }));
  const perm = useCan(CAP.payouts);
  const kycCap = useCan(CAP.kycReview);
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
      <PageHeader title="Payout traveler" subtitle="Hold manual → release adalah maker-checker (pelepas ≠ penahan, juga dijaga DB). Hold otomatis karena dispute dilepas sistem setelah dispute ditutup. Rekening tujuan baru menunggu masa jeda sebelum menerima payout. Rekening tujuan hanya mask." />
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
            { key: 'n', header: 'Payout', render: (p) => <span className="stack" style={{ gap: 0 }}><span className="cell-primary mono nowrap">{p.number}</span>{p.transactionId ? <Link className="cell-sub mono nowrap" to={`/transactions/${p.transactionId}`}>{p.transactionNumber}</Link> : null}</span> },
            { key: 't', header: 'Traveler', render: (p) => <Link to={`/users/${p.travelerId}`}>{p.travelerDisplayName ?? p.travelerId}</Link> },
            {
              key: 'd',
              header: 'Tujuan',
              render: (p) => (
                <span className="stack" style={{ gap: 2 }}>
                  <span className="mono">
                    {p.destination.bankCode} {p.destination.accountMask}
                  </span>
                  {p.destination.verificationStatus === 'NAME_MISMATCH' ? (
                    <span className="row row--tight">
                      <Badge tone="warning">Nama ≠ KYC</Badge>
                      {kycCap.allowed ? <Link className="small" to="/kyc?tab=payout">Review</Link> : null}
                    </span>
                  ) : (
                    <span className="cell-sub">{p.destination.verificationStatus}</span>
                  )}
                </span>
              ),
            },
            { key: 'net', header: 'Neto', align: 'right', render: (p) => <Money value={p.netIdr} emphasize />, sortValue: (p) => p.netIdr },
            { key: 's', header: 'Status', render: (p) => <span className="row row--tight"><StatusBadge status={p.status} />{p.sandbox ? <Badge tone="warning">SANDBOX</Badge> : null}</span> },
            {
              key: 'h',
              header: 'Hold & sumber',
              render: (p) => {
                const src = holdSource(p);
                if (!src && !p.transactionHoldReason) return <span className="muted">—</span>;
                return (
                  <span className="stack" style={{ gap: 2 }} data-testid={`hold-${p.id}`}>
                    {src ? (
                      <span className="row row--tight">
                        <Badge tone={src.tone}>{src.label}</Badge>
                        {p.holdReason ? <span className="small">{humanize(p.holdReason)}</span> : null}
                      </span>
                    ) : null}
                    <span className="cell-sub">
                      {src?.kind === 'MANUAL' ? (
                        <>
                          oleh <IdText id={p.heldBy} />
                          {p.heldAt ? <> · <DateTime value={p.heldAt} relative /></> : null}
                        </>
                      ) : (
                        src?.note
                      )}
                      {p.transactionHoldReason ? ` · tx: ${p.transactionHoldReason}` : ''}
                    </span>
                  </span>
                );
              },
            },
            {
              key: 'sch',
              header: 'Jadwal',
              render: (p) => {
                const cd = payoutCooldown(p);
                return (
                  <span className="stack" style={{ gap: 2 }}>
                    <DateTime value={p.scheduledFor} />
                    {cd ? (
                      <span className="row row--tight" data-testid={`cooldown-${p.id}`} title={cd.note}>
                        <Badge tone="info">Jeda rekening baru</Badge>
                        <span className="cell-sub">
                          s/d <DateTime value={cd.until} />
                        </span>
                      </span>
                    ) : null}
                  </span>
                );
              },
            },
            {
              key: 'act',
              header: 'Aksi',
              render: (p) => (
                <span className="btn-group" style={{ flexWrap: 'nowrap' }}>
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
        {dlg?.kind === 'release' && holdSource(dlg.p)?.kind === 'SYSTEM_DISPUTE' ? (
          <Callout tone="info">Hold ini otomatis karena dispute dan akan dilepas sistem begitu dispute CLOSED tanpa review risiko terbuka. Lepas manual hanya bila benar-benar perlu (API memperingatkan DISPUTE_NOT_CLOSED).</Callout>
        ) : null}
        {dlg?.p.transactionHoldReason && dlg.kind === 'release' ? <Callout tone="warning">Transaksi punya payout hold: {dlg.p.transactionHoldReason}</Callout> : null}
      </ActionDialog>
    </div>
  );
}
