import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Transactions } from '../../api/admin';
import type { TransactionDetail } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { eventsToTimeline, JsonView, Timeline } from '../../components/data';
import { PriceBreakdown } from '../../components/PriceBreakdown';
import { Badge, Button, Callout, Card, DateTime, Field, IdText, KeyValue, LoadingBlock, Money, PageHeader, Select, StatusBadge, TabPanel, Tabs } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatIdr, formatNumber, humanize } from '../../lib/format';
import { modeTone, txTone } from '../../lib/status';
import { KycBadge, TrustBadge } from '../users/UsersPage';

type Tab = 'summary' | 'money' | 'ledger' | 'proof' | 'timeline';

const HELD = ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING'];

export function escrowHeld(t: TransactionDetail): number {
  return t.ledger.escrow.filter((e) => HELD.includes(e.bucket)).reduce((s, e) => s + e.netCreditIdr, 0);
}

export default function TransactionDetailPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['transactions', 'detail', id], queryFn: () => Transactions.detail(id) });
  const [tab, setTab] = useState<Tab>('summary');
  const [dlg, setDlg] = useState<null | 'cancel' | 'refund'>(null);
  const [amount, setAmount] = useState('');
  const [remainder, setRemainder] = useState<'NONE' | 'TRAVELER'>('NONE');
  const [cause, setCause] = useState('');
  const [approvalNote, setApprovalNote] = useState('');
  const canCancel = useCan(CAP.txCancel);
  const canRefund = useCan(CAP.txRefund);
  const inv = [['transactions'], ['refunds']];
  const cancel = useAdminAction({
    run: (reason: string, key) => Transactions.cancel(id, { reason, approvalNote, ...(cause ? { cause } : {}) }, key),
    actionKey: () => `tx.cancel:${id}`,
    invalidate: inv,
    toastErrors: false,
    success: (r) => `Transaksi → ${r.status}`,
  });
  const refund = useAdminAction({
    run: (reason: string, key) => Transactions.refund(id, { amountIdr: Number(amount), reason, remainderTo: remainder }, key),
    actionKey: () => `tx.refund:${id}`,
    invalidate: inv,
    toastErrors: false,
    success: (r) => r.note ?? `Refund diajukan (${r.created.length})`,
  });

  if (q.isPending) return <LoadingBlock rows={10} />;
  if (q.isError || !q.data) return <Callout tone="danger">Transaksi tidak dapat dimuat.</Callout>;
  const t = q.data;
  const held = escrowHeld(t);
  const allowed = t.adminAllowedTransitions;
  const disputed = t.status === 'DISPUTED' ? 'Transaksi sedang dispute — gunakan resolusi dispute' : null;
  const cancelBlock = canCancel.reason ?? disputed ?? (!allowed.some((s) => s === 'CANCELLED' || s === 'REFUND_PENDING') ? `Tidak ada transisi admin ke CANCELLED/REFUND_PENDING dari ${t.status}` : null);
  const refundBlock = canRefund.reason ?? disputed ?? (t.securedIdr <= 0 ? 'Belum ada dana yang di-secure' : !allowed.includes('REFUND_PENDING') ? `Transisi REFUND_PENDING tidak diizinkan dari ${t.status}` : null);
  const amountNum = Number(amount);
  const sandbox = t.payments.some((p) => p.sandbox);

  return (
    <div className="stack stack--lg">
      <PageHeader
        breadcrumb={<Link to="/transactions">Transaksi</Link>}
        title={<span className="mono">{t.number}</span>}
        subtitle={
          <span className="row">
            <StatusBadge status={t.status} tone={txTone(t.status)} />
            <span>{t.item?.productName ?? '—'}</span>
            {sandbox ? <Badge tone="warning">Pembayaran SANDBOX</Badge> : null}
            {t.payoutHoldReason ? <Badge tone="danger">Payout hold: {t.payoutHoldReason}</Badge> : null}
          </span>
        }
        actions={
          <>
            <Button variant="danger-outline" icon="x" mfa onClick={() => setDlg('cancel')} disabledReason={cancelBlock} data-testid="tx-cancel">
              Batalkan (admin)
            </Button>
            <Button variant="primary" icon="refund" mfa onClick={() => setDlg('refund')} disabledReason={refundBlock} data-testid="tx-refund">
              Refund admin
            </Button>
          </>
        }
      />

      <section className="grid grid-4" aria-label="Ringkasan dana">
        <Card>
          <div className="stat-inline">
            <span className="l">Total landed cost</span>
            <span className="v">
              <Money value={t.totalIdr} />
            </span>
          </div>
        </Card>
        <Card>
          <div className="stat-inline">
            <span className="l">Dana di-secure SafePay</span>
            <span className="v">
              <Money value={t.securedIdr} />
            </span>
          </div>
        </Card>
        <Card>
          <div className="stat-inline">
            <span className="l">Masih ditahan (escrow)</span>
            <span className="v">
              <Money value={held} />
            </span>
          </div>
        </Card>
        <Card>
          <div className="stat-inline">
            <span className="l">Ledger</span>
            <span className="v">{t.ledger.balanced ? <Badge tone="success">Seimbang</Badge> : <Badge tone="danger">TIDAK seimbang</Badge>}</span>
            <span className="small muted">{t.ledger.journals.length} jurnal</span>
          </div>
        </Card>
      </section>

      <Tabs
        label="Detail transaksi"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'summary', label: 'Ringkasan' },
          { key: 'money', label: 'Pembayaran & refund', count: t.payments.length + t.refunds.length + t.payouts.length },
          { key: 'ledger', label: 'Ledger', count: t.ledger.journals.length },
          { key: 'proof', label: 'Bukti & pengiriman' },
          { key: 'timeline', label: 'Timeline', count: t.events.length },
        ]}
      />

      {tab === 'summary' ? (
        <TabPanel id="summary">
          <div className="grid grid-main-side">
            <Card title="Rincian harga (11 baris)" hint="Semua biaya ditampilkan · urutan tetap sesuai domain model §10">
              {t.quote ? <PriceBreakdown quote={t.quote} /> : <p className="muted">Belum ada quote aktif.</p>}
            </Card>
            <div className="stack stack--lg">
              <Card title="Barang">
                {t.item ? (
                  <KeyValue
                    items={[
                      ['Produk', t.item.productName],
                      ['Kategori', t.item.categoryCode],
                      ['Merchant', `${t.item.merchantName ?? '—'} (${t.item.merchantCountry ?? '—'})`],
                      ['Harga asal', t.item.unitPriceMinor !== null ? `${formatNumber(t.item.unitPriceMinor)} ${t.item.currency ?? ''} (minor unit) × ${t.item.quantity}` : '—'],
                      ['Klasifikasi', t.item.restrictionClass ? <StatusBadge status={t.item.restrictionClass} /> : '—'],
                    ]}
                  />
                ) : (
                  '—'
                )}
              </Card>
              <Card title="Pihak (dimasking)">
                <div className="stack">
                  {(['buyer', 'traveler'] as const).map((k) => {
                    const p = t[k];
                    return (
                      <div key={k} className="row row--between">
                        <span className="stack" style={{ gap: 2 }}>
                          <span className="small muted">{k === 'buyer' ? 'Penitip' : 'Traveler'}</span>
                          {p ? <Link to={`/users/${p.id}`}>{p.displayName ?? p.id}</Link> : <span className="muted">—</span>}
                        </span>
                        {p ? (
                          <span className="row row--tight">
                            {p.kycLevel ? <KycBadge level={p.kycLevel} /> : null}
                            <TrustBadge score={p.trustScore} />
                            {p.status && p.status !== 'ACTIVE' ? <StatusBadge status={p.status} /> : null}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </Card>
              <Card title="Aksi admin yang diizinkan" hint="adminAllowedTransitions dari state machine">
                <div className="row">{allowed.length ? allowed.map((s) => <StatusBadge key={s} status={s} tone={txTone(s)} />) : <span className="muted small">Tidak ada transisi admin dari status ini.</span>}</div>
              </Card>
              {t.disputes.length ? (
                <Card title="Dispute">
                  {t.disputes.map((d) => (
                    <div key={d.id} className="row row--between">
                      <Link to={`/disputes/${d.id}`} className="mono">
                        {d.number}
                      </Link>
                      <span className="row row--tight">
                        {humanize(d.type)} <StatusBadge status={d.status} />
                      </span>
                    </div>
                  ))}
                </Card>
              ) : null}
            </div>
          </div>
        </TabPanel>
      ) : null}

      {tab === 'money' ? (
        <TabPanel id="money">
          <Card title="Pembayaran" flush>
            <DataTable
              compact
              caption="Pembayaran"
              rows={t.payments}
              rowKey={(p) => p.id}
              empty={{ title: 'Belum ada pembayaran' }}
              columns={[
                { key: 'p', header: 'Tujuan', render: (p) => humanize(p.purpose) },
                { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
                { key: 'ch', header: 'Kanal', render: (p) => p.channel ?? '—' },
                { key: 'prov', header: 'Provider', render: (p) => <span className="row row--tight">{p.provider} <Badge tone={modeTone(p.sandbox ? 'SANDBOX' : 'LIVE')}>{p.sandbox ? 'SANDBOX' : 'LIVE'}</Badge></span> },
                { key: 'a', header: 'Nominal', align: 'right', render: (p) => <Money value={p.amountIdr} /> },
                { key: 'r', header: 'Direfund', align: 'right', render: (p) => <Money value={p.refundedIdr} /> },
                { key: 't', header: 'Secured', render: (p) => <DateTime value={p.securedAt} /> },
              ]}
            />
          </Card>
          <Card title="Refund" flush>
            <DataTable
              compact
              caption="Refund"
              rows={t.refunds}
              rowKey={(r) => r.id}
              empty={{ title: 'Belum ada refund' }}
              columns={[
                { key: 'n', header: 'Nomor', render: (r) => <span className="mono">{r.number}</span> },
                { key: 'rc', header: 'Alasan', render: (r) => <span className="stack" style={{ gap: 0 }}>{humanize(r.reasonCode)}<span className="cell-sub">{r.reasonNote}</span></span> },
                { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                { key: 'm', header: 'Metode', render: (r) => humanize(r.method) },
                { key: 'd', header: 'Tujuan', render: (r) => (r.destination ? <span className="mono">{r.destination.bankCode} {r.destination.accountMask}</span> : r.destinationRequired ? <Badge tone="warning">Perlu rekening</Badge> : '—') },
                { key: 'a', header: 'Nominal', align: 'right', render: (r) => <Money value={r.amountIdr} /> },
                { key: 't', header: 'Diproses', render: (r) => <DateTime value={r.processedAt} /> },
              ]}
            />
          </Card>
          <Card title="Payout traveler" hint="Tujuan hanya mask rekening" flush>
            <DataTable
              compact
              caption="Payout"
              rows={t.payouts}
              rowKey={(p) => p.id}
              empty={{ title: 'Belum ada payout' }}
              columns={[
                { key: 'n', header: 'Nomor', render: (p) => <span className="mono">{p.number}</span> },
                { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
                { key: 'd', header: 'Tujuan', render: (p) => <span className="mono">{p.destination.bankCode} {p.destination.accountMask}</span> },
                { key: 'env', header: 'Env', render: (p) => <Badge tone={modeTone(p.providerEnv === 'LIVE' ? 'LIVE' : 'SANDBOX')}>{p.providerEnv}</Badge> },
                { key: 'net', header: 'Neto', align: 'right', render: (p) => <Money value={p.netIdr} /> },
                { key: 'h', header: 'Hold', render: (p) => p.holdReason ?? '—' },
                { key: 'sch', header: 'Jadwal', render: (p) => <DateTime value={p.scheduledFor} /> },
              ]}
            />
          </Card>
        </TabPanel>
      ) : null}

      {tab === 'ledger' ? (
        <TabPanel id="ledger">
          <div className="grid grid-main-side">
            <Card title="Jurnal (double-entry, immutable)" hint={t.ledger.balanced ? 'Setiap jurnal: debit = kredit' : 'PERINGATAN: ada jurnal tidak seimbang'} flush>
              <div className="stack" style={{ padding: 0 }}>
                {t.ledger.journals.map((j) => (
                  <div key={j.id} style={{ borderBottom: '1px solid var(--jk-color-divider)' }}>
                    <div className="row row--between" style={{ padding: '10px 18px 4px' }}>
                      <span className="row">
                        <Badge tone="info" dot={false}>
                          #{j.seq}
                        </Badge>
                        <strong>{humanize(j.kind)}</strong>
                        <span className="small muted">{j.description}</span>
                      </span>
                      <span className="small muted">
                        <DateTime value={j.postedAt} />
                      </span>
                    </div>
                    <table className="table table--compact table--ledger" aria-label={`Entri jurnal ${j.seq}`}>
                      <colgroup>
                        <col className="c-bucket" />
                        <col className="c-owner" />
                        <col className="c-amt" />
                        <col className="c-amt" />
                        <col />
                      </colgroup>
                      <thead>
                        <tr>
                          <th scope="col">Bucket</th>
                          <th scope="col">Pemilik</th>
                          <th scope="col" className="num">
                            Debit
                          </th>
                          <th scope="col" className="num">
                            Kredit
                          </th>
                          <th scope="col">Memo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {j.entries.map((e, i) => (
                          <tr key={i}>
                            <td>
                              <code>{e.bucket}</code>
                            </td>
                            <td>{e.ownerUserId ? <IdText id={e.ownerUserId} /> : <span className="muted">platform</span>}</td>
                            <td className="num">{e.direction === 'DEBIT' ? <Money value={e.amountIdr} /> : ''}</td>
                            <td className="num">{e.direction === 'CREDIT' ? <Money value={e.amountIdr} /> : ''}</td>
                            <td className="small muted">{e.memo ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {j.idempotencyKey ? (
                      <div className="small muted" style={{ padding: '4px 18px 10px' }}>
                        idempotency <code>{j.idempotencyKey}</code>
                      </div>
                    ) : null}
                  </div>
                ))}
                {!t.ledger.journals.length ? <p className="muted small" style={{ padding: 18 }}>Belum ada jurnal.</p> : null}
              </div>
            </Card>
            <Card title="Saldo per bucket" hint="v_transaction_ledger · net kredit">
              <DataTable
                compact
                caption="Escrow per bucket"
                rows={t.ledger.escrow}
                rowKey={(e) => e.bucket}
                columns={[
                  { key: 'b', header: 'Bucket', render: (e) => <span className="row row--tight"><code>{e.bucket}</code>{HELD.includes(e.bucket) ? <Badge tone="info">ditahan</Badge> : null}</span> },
                  { key: 'v', header: 'Net kredit', align: 'right', render: (e) => <Money value={e.netCreditIdr} /> },
                ]}
              />
              <p className="small muted" style={{ marginTop: 10 }}>
                Escrow ditahan = PRODUCT_FUND + CUSTOMS_RESERVE + CLEARING = {formatIdr(held)}.
              </p>
            </Card>
          </div>
        </TabPanel>
      ) : null}

      {tab === 'proof' ? (
        <TabPanel id="proof">
          <div className="grid grid-2">
            <Card title="Bukti pembelian" flush>
              <DataTable
                compact
                caption="Bukti pembelian"
                rows={t.purchaseProofs}
                rowKey={(p) => p.id}
                empty={{ title: 'Belum ada bukti pembelian' }}
                columns={[
                  { key: 'm', header: 'Merchant', render: (p) => p.merchantName },
                  { key: 'a', header: 'Harga aktual', align: 'right', render: (p) => `${formatNumber(p.actualPriceMinor)} ${p.currency}` },
                  { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
                  { key: 'f', header: 'Sinyal fraud', render: (p) => (Array.isArray(p.fraudReasons) && p.fraudReasons.length ? <Badge tone="danger">{p.fraudReasons.length}</Badge> : '—') },
                  { key: 't', header: 'Waktu', render: (p) => <DateTime value={p.createdAt} /> },
                ]}
              />
            </Card>
            <Card title="Pengiriman / serah terima">
              {t.delivery ? (
                <KeyValue
                  items={[
                    ['Metode', humanize(t.delivery.method)],
                    ['Status', <StatusBadge status={t.delivery.status} />],
                    ['Kurir / resi', [t.delivery.courierName, t.delivery.trackingNumber].filter(Boolean).join(' · ') || '—'],
                    ['Kota / titik temu', [t.delivery.addressCity, t.delivery.meetupPoint].filter(Boolean).join(' · ') || '—'],
                    ['Jadwal', <DateTime value={t.delivery.scheduledAt} />],
                    ['Dikonfirmasi', t.delivery.confirmedAt ? <span><DateTime value={t.delivery.confirmedAt} /> via {t.delivery.confirmedVia}</span> : '—'],
                    ['PIN', t.delivery.pin ? `${t.delivery.pin.locked ? 'TERKUNCI · ' : ''}sisa ${t.delivery.pin.attemptsRemaining} percobaan (PIN tidak pernah ditampilkan ke admin)` : '—'],
                  ]}
                />
              ) : (
                <p className="muted small">Belum ada data pengiriman.</p>
              )}
            </Card>
          </div>
          <Card title="Konfirmasi perubahan harga">{t.priceConfirmations.length ? <JsonView value={t.priceConfirmations} /> : <p className="muted small">Tidak ada.</p>}</Card>
        </TabPanel>
      ) : null}

      {tab === 'timeline' ? (
        <TabPanel id="timeline">
          <Card title="transaction_events (semua transisi FSM)">
            <Timeline label="Riwayat status transaksi" items={eventsToTimeline(t.events)} />
          </Card>
        </TabPanel>
      ) : null}

      <ActionDialog
        open={dlg === 'cancel'}
        onClose={() => setDlg(null)}
        title={`Batalkan ${t.number} sebagai ADMIN`}
        description="Melalui cancellation matrix (aktor ADMIN). Sebelum pembayaran → CANCELLED; sesudah → REFUND_PENDING + refund & kompensasi traveler sesuai tahap."
        confirmLabel="Batalkan transaksi"
        tone="danger"
        mfa
        idempotencyKey={dlg === 'cancel' ? cancel.keyFor(undefined as never) : null}
        canConfirm={approvalNote.trim().length >= 5}
        onConfirm={(reason) => cancel.mutateAsync(reason)}
      >
        <Field label="Penyebab (opsional)" hint="mis. TRAVELER_NO_SHOW, FRAUD, BUYER_REQUEST">
          <input className="input" value={cause} onChange={(e) => setCause(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Catatan persetujuan" required hint="Siapa menyetujui override ini (tercatat).">
          <input className="input" value={approvalNote} onChange={(e) => setApprovalNote(e.target.value)} />
        </Field>
      </ActionDialog>
      <ActionDialog
        open={dlg === 'refund'}
        onClose={() => setDlg(null)}
        title={`Refund admin ${t.number}`}
        description="Di atas batas auto-approve (config money.policy.refundAutoApproveMaxIdr) refund menunggu persetujuan admin lain (maker-checker)."
        confirmLabel={amountNum > 0 ? `Ajukan refund ${formatIdr(amountNum)}` : 'Ajukan refund'}
        mfa
        idempotencyKey={dlg === 'refund' ? refund.keyFor(undefined as never) : null}
        canConfirm={Number.isInteger(amountNum) && amountNum > 0 && amountNum <= t.securedIdr}
        onConfirm={(reason) => refund.mutateAsync(reason)}
      >
        <Field label="Nominal refund (IDR)" required hint={`Maksimal dana di-secure ${formatIdr(t.securedIdr)} · masih ditahan ${formatIdr(held)}`}>
          <input className="input tabular" type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Sisa dana ke">
          <Select
            value={remainder}
            onChange={(v) => setRemainder(v as 'NONE' | 'TRAVELER')}
            options={[
              { value: 'NONE', label: 'Tidak ada (tetap ditahan)' },
              { value: 'TRAVELER', label: 'Traveler (rilis sisa)' },
            ]}
          />
        </Field>
        {amountNum > 0 ? (
          <Callout tone="info" title="Pratinjau:">
            Penitip menerima {formatIdr(Math.min(amountNum, held))}; sisa escrow {formatIdr(Math.max(0, held - amountNum))} → {remainder === 'TRAVELER' ? 'dirilis ke traveler' : 'tetap ditahan'}. Angka final ditentukan ledger API.
          </Callout>
        ) : null}
      </ActionDialog>
    </div>
  );
}
